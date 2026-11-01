import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ModelCapabilities, ProgramId } from '@dafeiyu/contracts';
import type { AppConfig } from './config.js';
import { loadCharacter, type CharacterBundle } from './conversation/character.js';
import { MemoryService } from './conversation/memory.js';
import type { ModelGateway, ModelRequest } from './harness/model.js';
import { MockModelGateway } from './harness/mock-model.js';
import { HsGwModelGateway } from './harness/hs-gw-model.js';
import { resolveDataPath } from './paths.js';
import { createRoomRuntime, type RoomRuntime } from './rooms/room-runtime.js';
import { RoomRegistry } from './rooms/room-registry.js';
import { MockSpeechService, UnavailableSpeechService, type SpeechService } from './speech/speech-service.js';
import { openDb, type Db } from './storage/db.js';
import { Repository } from './storage/repository.js';
import { cutoffFor, type RetentionConfig } from './storage/retention.js';
import { ToolExecutor } from './tools/executor.js';
import { ToolRegistry } from './tools/registry.js';
import { createLolLookupTool } from './tools/lol-lookup.js';
import { webSearchTool } from './tools/web-search.js';
import { createSignatureTool } from './tools/signature.js';
import { SouvenirService } from './souvenirs/souvenir-service.js';

/**
 * 进程级运行时。
 *
 * 分成两层：
 * - **共享**：数据库、模型、工具执行器、TTS、纪念品、记忆、保留清理。
 *   这些无状态或依赖单写入，共用更简单。
 * - **按房间**：Stage / Scheduler / Programs / Ingress（见 RoomRegistry）。
 *   每个房间互不影响：队列、租约、回合、限流桶都独立。
 *
 * 为兼容单房间调用方，`stage` / `scheduler` / `programs` 指向默认房间。
 */
export type Runtime = {
  config: AppConfig;
  db: Db;
  repository: Repository;
  character: CharacterBundle;
  model: ModelGateway;
  modelCapabilities: ModelCapabilities;
  tools: ToolExecutor;
  programTools: ToolExecutor;
  speech: SpeechService;
  souvenirs: SouvenirService;
  memories: MemoryService;
  rooms: RoomRegistry;
  /** 默认房间（config.roomId）的运行时；与 rooms.get(default) 同一实例。 */
  defaultRoom: RoomRuntime;
  /** 兼容快捷方式：默认房间的舞台。 */
  stage: RoomRuntime['stage'];
  scheduler: RoomRuntime['scheduler'];
  programs: RoomRuntime['programs'];
  degradation: { active: boolean; reason: string | null };
  retention: RetentionConfig;
  cancelPendingSynthesis: () => number;
  runRetention: () => {
    processedEvents: number;
    messages: number;
    turns: number;
    souvenirs: number;
    memories: number;
  };
  previewRetention: () => {
    processedEvents: number;
    messages: number;
    turns: number;
    souvenirs: number;
    memories: number;
  };
  shutdown: () => Promise<void>;
};

/** 缺凭证时的显式降级模型：不伪装成真实模型，直接报 not_configured。 */
class NotConfiguredModel implements ModelGateway {
  readonly capabilities: ModelCapabilities = {
    nativeTools: false,
    structuredOutput: false,
    modelId: 'unconfigured',
  };

  constructor(private readonly reason: string) {}

  async complete(_request: ModelRequest): Promise<AssistantTurn> {
    throw new Error(this.reason);
  }
}

export type CreateRuntimeOptions = {
  config: AppConfig;
  /** 测试可注入内存库与自定义模型。 */
  db?: Db;
  model?: ModelGateway;
  speech?: SpeechService;
  roomId?: string;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
  /** 测试可固定房间上限。 */
  maxRooms?: number;
};

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? (() => undefined);
  const defaultRoomId = options.roomId ?? config.roomId;

  const db = options.db ?? openDb({ file: resolveDataPath(`${config.dataDir}/dafeiyu.db`) });
  const repository = new Repository(db);
  const character = loadCharacter();

  let model: ModelGateway;
  let degradation: Runtime['degradation'] = { active: false, reason: null };

  if (options.model) {
    model = options.model;
  } else if (config.model.adapter === 'hs-gw') {
    if (config.model.baseUrl && config.model.apiKey && config.model.modelId) {
      model = new HsGwModelGateway({
        baseUrl: config.model.baseUrl,
        apiKey: config.model.apiKey,
        modelId: config.model.modelId,
      });
    } else {
      const reason = 'hs-gw 凭证未配置（HS_GW_BASE_URL / HS_GW_API_KEY / HS_GW_MODEL）';
      model = new NotConfiguredModel(reason);
      degradation = { active: true, reason };
    }
  } else {
    model = new MockModelGateway();
  }

  // ---- TTS：默认 mock（生成可播放 WAV），未配置时显式不可用 ----
  const speech: SpeechService = options.speech
    ? options.speech
    : config.speech.adapter === 'mock'
      ? new MockSpeechService({
          outputDir: resolveDataPath(`${config.storageRoot}/tts`),
          publicPrefix: '/media/tts',
          ...(config.speech.voice ? { voice: config.speech.voice } : {}),
          now,
        })
      : new UnavailableSpeechService(
          'TTS 未配置（SPEECH_ADAPTER=none），当前为纯字幕模式',
        );

  const signatureDir = resolveDataPath(`${config.storageRoot}/souvenirs`);

  const registry = new ToolRegistry();
  registry.register(
    createLolLookupTool(
      config.lol.adapter === 'http' && config.lol.baseUrl
        ? { adapter: 'http', baseUrl: config.lol.baseUrl, token: config.lol.token }
        : { adapter: 'mock' },
    ),
  );
  registry.register(webSearchTool);
  registry.register(
    createSignatureTool({
      repository,
      outputDir: signatureDir,
      publicPrefix: '/media/souvenirs',
      roomId: defaultRoomId,
      now,
    }),
  );

  const tools = new ToolExecutor({
    registry,
    // 模型白名单只含只读工具：签名是写操作，只能由观众明确触发。
    allowedTools: ['lol.lookup', 'web.search'],
    defaultTimeoutMs: config.budget.toolTimeoutMs,
  });

  /**
   * 节目执行器：允许写工具（签名），但只由确定性节目/主播控制调用。
   * 模型侧永远使用上面的只读执行器。
   */
  const programTools = new ToolExecutor({
    registry,
    allowedTools: ['lol.lookup', 'web.search', 'signature.create'],
    defaultTimeoutMs: config.budget.toolTimeoutMs,
  });

  const memories = new MemoryService(repository, { now });
  const souvenirs = new SouvenirService({ repository, storageDir: signatureDir, roomId: defaultRoomId });

  const registryRooms = new RoomRegistry({
    maxRooms: options.maxRooms ?? config.maxRooms,
    createRoom: (roomId) =>
      createRoomRuntime({
        config,
        roomId,
        repository,
        character,
        model,
        tools,
        programTools,
        speech,
        souvenirs,
        memories,
        now,
        logger,
      }),
  });

  const defaultRoom = registryRooms.get(defaultRoomId);
  if (!defaultRoom) {
    throw new Error('无法创建默认房间运行时（检查 MAX_ROOMS 配置）');
  }

  // ---- 保留期限清理 ----
  const retentionConfig: RetentionConfig = {
    processedEventsDays: config.retention.processedEventsDays,
    messagesDays: config.retention.messagesDays,
    turnsDays: config.retention.turnsDays,
    souvenirsDays: config.retention.souvenirsDays,
    memoriesGraceDays: config.retention.memoriesGraceDays,
  };

  const runRetention = () => {
    const stats = repository.applyRetention(retentionConfig, now(), cutoffFor);
    const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
    if (total > 0) logger({ event: 'retention.pruned', ...stats });
    return stats;
  };

  const previewRetention = () =>
    repository.countRetention(retentionConfig, now(), cutoffFor);

  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  if (config.retention.intervalMinutes > 0) {
    retentionTimer = setInterval(() => {
      try {
        runRetention();
      } catch (error) {
        logger({
          event: 'retention.failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, config.retention.intervalMinutes * 60_000);
    retentionTimer.unref?.();
  }

  // ---- Boss 窗口到期自动结算（所有房间） ----
  const bossTickTimer = setInterval(() => {
    for (const room of registryRooms.all()) {
      void room.programs.tick().catch((error: unknown) => {
        logger({
          event: 'program.tick.failed',
          roomId: room.roomId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, 1000);
  bossTickTimer.unref?.();

  // 启动恢复：上次未完成的轮次/节目标记中断，不重播、不重结算。
  const interrupted = repository.markInterruptedTurns(now());
  const interruptedRuns = repository.markInterruptedProgramRuns(now());
  if (interrupted > 0 || interruptedRuns > 0) {
    logger({ event: 'startup.recovered', interruptedTurns: interrupted, interruptedRuns });
  }

  for (const room of registryRooms.all()) {
    room.stage.setDegraded(degradation.active, degradation.reason);
  }

  /** 取消所有房间正在合成的语音。 */
  const cancelPendingSynthesis = (): number => {
    let cancelled = 0;
    for (const room of registryRooms.all()) {
      cancelled += room.programs.cancelPendingSynthesis();
    }
    return cancelled;
  };

  return {
    config,
    db,
    repository,
    character,
    model,
    modelCapabilities: model.capabilities,
    tools,
    programTools,
    speech,
    souvenirs,
    memories,
    rooms: registryRooms,
    defaultRoom,
    stage: defaultRoom.stage,
    scheduler: defaultRoom.scheduler,
    programs: defaultRoom.programs,
    degradation,
    retention: retentionConfig,
    cancelPendingSynthesis,
    runRetention,
    previewRetention,
    shutdown: async () => {
      clearInterval(bossTickTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      await registryRooms.shutdownAll();
      db.close();
    },
  };
}

/** 生成一次 turn 的 ID 集合，集中在这里避免各路由各造格式。 */
export function newTurnIds(): { turnId: string; traceId: string } {
  return { turnId: `turn_${randomUUID()}`, traceId: `trace_${randomUUID()}` };
}

export type { ProgramId, RoomRuntime };
