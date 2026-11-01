import type { ProgramId } from '@dafeiyu/contracts';
import type { AppConfig } from '../config.js';
import type { CharacterBundle } from '../conversation/character.js';
import { MemoryService, renderMemoriesForPrompt } from '../conversation/memory.js';
import { Harness } from '../harness/harness.js';
import type { ModelGateway } from '../harness/model.js';
import { IngressNormalizer } from '../ingress/normalizer.js';
import { ProgramManager } from '../programs/program-manager.js';
import { BossProgram } from '../programs/programs.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type { SpeechService } from '../speech/speech-service.js';
import { StageService } from '../stage/stage-service.js';
import type { Repository } from '../storage/repository.js';
import type { ToolExecutor } from '../tools/executor.js';
import { SouvenirService } from '../souvenirs/souvenir-service.js';

/**
 * 单房间运行时。
 *
 * 多房间隔离的关键：**每个房间一套独立的**
 * - StageService（各自 revision、renderer 租约、programState）
 * - Scheduler（各自队列与取消）
 * - ProgramManager / BossProgram（各自回合与分数）
 * - IngressNormalizer（各自限流桶）
 *
 * 共享的是数据库、模型网关、工具执行器、TTS 与纪念品服务：
 * 这些是无状态的，且共用连接池/SQLite 单写入更简单。
 */
export type RoomRuntime = {
  roomId: string;
  stage: StageService;
  scheduler: Scheduler;
  programs: ProgramManager;
  ingress: IngressNormalizer;
  /** 从观众消息捕获“记住 xxx”类明示记忆。 */
  captureMemory: (input: { sessionId: string; viewerId: string | null; text: string }) => void;
};

export type CreateRoomRuntimeOptions = {
  config: AppConfig;
  roomId: string;
  repository: Repository;
  character: CharacterBundle;
  model: ModelGateway;
  tools: ToolExecutor;
  programTools: ToolExecutor;
  speech: SpeechService;
  souvenirs: SouvenirService;
  memories: MemoryService;
  now: () => Date;
  logger: (event: Record<string, unknown>) => void;
  bossConfig?: ConstructorParameters<typeof BossProgram>[0];
  /** 默认节目，缺省 chat。 */
  initialProgram?: ProgramId;
};

export function createRoomRuntime(options: CreateRoomRuntimeOptions): RoomRuntime {
  const {
    config,
    roomId,
    repository,
    character,
    model,
    tools,
    programTools,
    speech,
    memories,
    now,
    logger,
  } = options;

  repository.ensureRoom(roomId, now());

  const stage = new StageService({
    roomId,
    characterName: character.profile.name,
    program: 'chat',
    now,
  });

  const boss = new BossProgram(options.bossConfig, () => now().getTime());

  const programs = new ProgramManager({
    roomId,
    repository,
    stage,
    speech,
    tools: programTools,
    boss,
    now,
    logger,
  });

  const harness = new Harness({
    model,
    tools,
    repository,
    character,
    budget: config.budget,
    contextMaxMessages: config.contextMaxMessages,
    now,
    logger,
    loadMemoryDigest: ({ roomId: room, sessionId, viewerId }) => {
      const loaded = memories.load({ roomId: room, sessionId, viewerId, limit: 8 });
      return renderMemoriesForPrompt(loaded);
    },
  });

  const scheduler = new Scheduler({
    harness,
    maxPending: config.queue.maxPending,
    events: {
      onTurnStarted: (turn) => {
        logger({
          event: 'turn.started',
          roomId,
          turnId: turn.turnId,
          triggerEventId: turn.triggerEventId,
        });
      },
      onTurnFinished: (turn, outcome, error) => {
        if (error || !outcome) {
          logger({ event: 'turn.failed', roomId, turnId: turn.turnId, error });
          return;
        }
        if (outcome.finishReason === 'cancelled') {
          logger({ event: 'turn.cancelled', roomId, turnId: outcome.turnId });
          return;
        }
        void publishChatOutcome(turn.turnId, outcome);
        logger({
          event: 'turn.completed',
          roomId,
          turnId: outcome.turnId,
          finishReason: outcome.finishReason,
          modelCalls: outcome.modelCalls,
          toolCalls: outcome.toolCalls,
          degraded: outcome.degraded,
        });
      },
    },
  });

  /** 合成语音期间的取消控制器（按房间隔离）。 */
  const pendingSynthesis = new Map<string, AbortController>();

  async function publishChatOutcome(
    turnId: string,
    outcome: {
      text: string;
      toolResults: Parameters<StageService['publishSpeech']>[0]['toolResults'];
      degraded: boolean;
    },
  ): Promise<void> {
    let artifact = null;
    const controller = new AbortController();
    pendingSynthesis.set(turnId, controller);

    try {
      if (speech.available) {
        try {
          artifact = await speech.synthesize({
            speechId: `speech_${turnId}`,
            text: outcome.text,
            signal: controller.signal,
          });
        } catch (error) {
          logger({
            event: 'speech.failed',
            roomId,
            turnId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (controller.signal.aborted) {
        logger({ event: 'speech.cancelled_during_synthesis', roomId, turnId });
        return;
      }

      stage.publishSpeech({
        turnId,
        text: outcome.text,
        toolResults: outcome.toolResults,
        degraded: outcome.degraded,
        artifact,
      });
    } finally {
      pendingSynthesis.delete(turnId);
    }
  }

  // 把“取消合成”的能力交给 ProgramManager，供控制台统一调用。
  /**
   * 从观众消息里捕获“明确同意的记忆”（“记住 xxx”）。
   * 只处理观众明示语句，不做模型推断；身份类指令会被 MemoryService 丢弃。
   */
  const captureMemory = (input: {
    sessionId: string;
    viewerId: string | null;
    text: string;
  }) => {
    try {
      memories.captureExplicit({
        roomId,
        sessionId: input.sessionId,
        viewerId: input.viewerId,
        text: input.text,
      });
    } catch (error) {
      logger({
        event: 'memory.capture_failed',
        roomId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  programs.setPendingCancel(() => {
    let cancelled = 0;
    for (const controller of pendingSynthesis.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
        cancelled += 1;
      }
    }
    return cancelled;
  });

  programs.setProgram(options.initialProgram ?? 'chat');

  return {
    roomId,
    stage,
    scheduler,
    programs,
    captureMemory,
    ingress: new IngressNormalizer({
      rateLimitPerMinute: config.queue.rateLimitPerMinute,
      now,
    }),
  };
}
