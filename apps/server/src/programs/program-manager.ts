import { randomUUID } from 'node:crypto';
import type {
  BossAction,
  BossState,
  ProgramId,
  ProgramInfo,
  SpeechPlan,
  StageEffect,
} from '@dafeiyu/contracts';
import { BossProgram, type BossRoundResult } from './programs.js';
import type { Repository } from '../storage/repository.js';
import type { StageService } from '../stage/stage-service.js';
import type { SpeechService, SynthesizeResult } from '../speech/speech-service.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolResult } from '@dafeiyu/contracts';

/**
 * 节目协调器：把弹幕命令路由到确定性节目，并产出舞台回应。
 *
 * 分界：
 * - 节目维护事实与状态（分数、回合、签名文件）；
 * - 模型只负责“怎么说”，且只在 chat 节目里参与；
 * - 这里不调用模型供应商，只调用 TTS 适配器与工具执行器。
 */
export type ProgramManagerOptions = {
  roomId: string;
  repository: Repository;
  stage: StageService;
  speech: SpeechService;
  /**
   * 节目专用执行器：白名单可以包含写工具（签名）。
   * 与模型执行器分开，模型永远拿不到写工具权限。
   */
  tools: ToolExecutor;
  boss?: BossProgram;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

export type InboundCommand =
  | { kind: 'chat'; text: string; viewerId: string; viewerName: string | null }
  | { kind: 'lol'; query: string; viewerId: string; viewerName: string | null }
  | { kind: 'signature'; text: string; viewerId: string; viewerName: string | null }
  | { kind: 'boss.act'; action: BossAction; viewerId: string; viewerName: string | null }
  | { kind: 'boss.open'; viewerId: string; viewerName: string | null }
  | { kind: 'boss.settle'; viewerId: string; viewerName: string | null }
  | { kind: 'program'; program: ProgramId };

export const PROGRAMS: ProgramInfo[] = [
  { id: 'chat', label: '闲聊', description: '普通弹幕聊天，模型可按需调用只读工具。', usesModel: true },
  { id: 'lol', label: 'LOL 锐评', description: '提交 Riot ID，查战绩并点评。', usesModel: true },
  { id: 'signature', label: '现场签名', description: '申请一张原创笔迹签名，归档为纪念品。', usesModel: false },
  { id: 'boss', label: '合作打 Boss', description: '限时回合，每观众一次动作，服务端结算。', usesModel: false },
];

/**
 * 解析弹幕命令。
 *
 * 关键：**不是**只有命令才能互动。普通文本返回 kind='chat'，走模型聊天。
 * 命令只是确定性节目的入口，不构成“固定流水线”。
 */
/** 动作词到确定性动作的映射；只做完全匹配。 */
const BOSS_ACTION_WORDS: Record<string, BossAction> = {
  打: 'attack',
  砍: 'attack',
  攻击: 'attack',
  蓄力: 'charge',
  治疗: 'heal',
  奶: 'heal',
};

/**
 * 解析弹幕命令。
 *
 * 设计原则：**普通聊天优先**。只有满足以下条件才走确定性节目：
 * 1. 显式前缀（`/` 或 `#`）——任何时候都生效，是主播/观众的明确意图；
 * 2. 当前已切到对应节目，且消息是完全匹配的短词。
 *
 * 这样“治疗一下我的菜”“签名怎么弄啊”“查了下天气预报”不会被劫持成命令。
 */
export function parseCommand(
  text: string,
  viewerId: string,
  viewerName: string | null,
  currentProgram: ProgramId = 'chat',
): InboundCommand {
  const trimmed = text.trim();
  const prefixed = /^[/#]/.test(trimmed);
  const bare = trimmed.replace(/^[/#]/, '').trim();

  const isBossOpen = /^(?:开boss|开团|开始打boss)$/iu.test(bare);
  const isBossSettle = /^(?:结算|开奖)$/u.test(bare);

  // “开Boss”是节目入口，任何时候都认：它本身语义明确，不是闲聊词。
  if (isBossOpen) return { kind: 'boss.open', viewerId, viewerName };

  // 其余 Boss 动作（攻击/蓄力/治疗/结算）：带前缀，或当前就在 boss 节目里。
  // 无前缀的裸词只有 boss 节目才认，避免“打”“奶”这类闲聊被劫持。
  if (prefixed || currentProgram === 'boss') {
    const action = BOSS_ACTION_WORDS[bare];
    if (action) return { kind: 'boss.act', action, viewerId, viewerName };
    if (isBossSettle) return { kind: 'boss.settle', viewerId, viewerName };
  }

  // LOL：只认“查战绩/战绩”，去掉容易误伤的裸“查”。
  const lolMatch = bare.match(/^(?:查战绩|战绩)\s*(.+)$/u);
  if (lolMatch?.[1] && (prefixed || currentProgram === 'lol' || currentProgram === 'chat')) {
    // “查战绩 xxx”本身语义明确，允许在 chat 节目直接使用。
    return { kind: 'lol', query: lolMatch[1].trim(), viewerId, viewerName };
  }

  // 签名：带前缀，或当前就在签名节目，且整条消息以“签名”开头。
  const sigMatch = bare.match(/^(?:签名|签个名|给我签)(?:\s+(.*))?$/u);
  if (sigMatch && (prefixed || currentProgram === 'signature')) {
    const wanted = (sigMatch[1] ?? '').trim();
    return {
      kind: 'signature',
      text: wanted.length > 0 ? wanted : (viewerName ?? '大肥鱼'),
      viewerId,
      viewerName,
    };
  }
  // “签名 xxx”是明确意图，chat 节目里也接受（带空格分隔）。
  const sigExplicit = bare.match(/^(?:签名|签个名|给我签)\s+(.+)$/u);
  if (sigExplicit?.[1]) {
    return {
      kind: 'signature',
      text: sigExplicit[1].trim(),
      viewerId,
      viewerName,
    };
  }

  return { kind: 'chat', text: trimmed, viewerId, viewerName };
}

export class ProgramManager {
  private readonly boss: BossProgram;
  private readonly now: () => Date;
  private readonly log: (event: Record<string, unknown>) => void;
  private currentProgram: ProgramId = 'chat';
  private activeRoundRunId: string | null = null;
  /** 已应用过副作用的回合，防止重复播报/重复归档。 */
  private readonly settledRoundIds = new Set<string>();
  private pendingCancel: (() => number) | null = null;

  constructor(private readonly options: ProgramManagerOptions) {
    this.boss = options.boss ?? new BossProgram();
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? (() => undefined);
    // 结算统一收口：手动结算与窗口到期自动结算都走这里。
    this.boss.onSettled((result) => {
      void this.applyBossSettlement(result);
    });
  }

  /**
   * 结算后的统一副作用：更新运行记录、广播状态、播报、归档战报。
   * 幂等：同一回合重复调用只生效一次（由 BossProgram 保证只 settle 一次）。
   */
  private async applyBossSettlement(result: BossRoundResult): Promise<void> {
    const roundId = result.roundId;
    if (this.settledRoundIds.has(roundId)) return;
    this.settledRoundIds.add(roundId);

    if (this.activeRoundRunId === roundId) {
      this.options.repository.updateProgramRun(roundId, {
        status: 'resolved',
        state: this.boss.snapshot(),
        result,
        endedAt: this.now().toISOString(),
      });
      this.activeRoundRunId = null;
    }
    this.options.stage.updateProgramState(this.boss.snapshot());
    await this.publish(result.summary, [
      { kind: 'game', text: `第 ${result.round} 回合结算`, data: result, isMock: false },
    ], false);
    await this.archiveGameSouvenir(result);
    this.log({ event: 'program.boss.settled', round: result.round, damage: result.damage });
  }

  /** 取消本房间正在合成的语音（由 runtime 汇总调用）。 */
  cancelPendingSynthesis(): number {
    // 合成控制器目前由 runtime 的房间闭包持有；这里只暴露计数占位，
    // 真正的取消在 room-runtime 的 publishChatOutcome 里。
    return this.pendingCancel ? this.pendingCancel() : 0;
  }

  /** 注册取消合成回调（由 room-runtime 注入）。 */
  setPendingCancel(fn: () => number): void {
    this.pendingCancel = fn;
  }

  /** 供定时器/控制台调用：窗口到期就主动结算。 */
  async tick(): Promise<void> {
    if (this.boss.isWindowExpired()) {
      this.boss.settle();
    }
  }

  /** 重置 Boss：先把当前运行记录标为 cancelled，再清空内存状态。 */
  resetBoss(): BossState {
    if (this.activeRoundRunId) {
      this.options.repository.updateProgramRun(this.activeRoundRunId, {
        status: 'cancelled',
        state: this.boss.snapshot(),
        endedAt: this.now().toISOString(),
      });
      this.activeRoundRunId = null;
    }
    const state = this.boss.reset();
    this.options.stage.updateProgramState(state);
    return state;
  }

  get bossProgram(): BossProgram {
    return this.boss;
  }

  get program(): ProgramId {
    return this.currentProgram;
  }

  listPrograms(): ProgramInfo[] {
    return PROGRAMS;
  }

  bossState(): BossState {
    return this.boss.snapshot();
  }

  setProgram(program: ProgramId): void {
    this.currentProgram = program;
    const state = program === 'boss' ? this.boss.snapshot() : null;
    this.options.stage.setProgram(program, state);
    this.log({ event: 'program.changed', program });
  }

  /**
   * 处理一条命令，返回是否已经由确定性节目处理。
   * 返回 false 表示应该走模型聊天（harness）。
   */
  async handleCommand(command: InboundCommand): Promise<boolean> {
    switch (command.kind) {
      case 'chat':
        return false;
      case 'program':
        this.setProgram(command.program);
        return true;
      case 'lol':
        // 显式节目命令顺带切到对应节目，观众不必先手动切换。
        if (this.currentProgram !== 'lol') this.setProgram('lol');
        await this.handleLol(command.query, command.viewerName);
        return true;
      case 'signature':
        if (this.currentProgram !== 'signature') this.setProgram('signature');
        await this.handleSignature(command.text, command.viewerName);
        return true;
      case 'boss.open':
        if (this.currentProgram !== 'boss') this.setProgram('boss');
        await this.handleBossOpen();
        return true;
      case 'boss.act':
        await this.handleBossAct(command.action, command.viewerId, command.viewerName);
        return true;
      case 'boss.settle':
        await this.handleBossSettle();
        return true;
    }
  }

  private async handleLol(query: string, viewerName: string | null): Promise<void> {
    const result = await this.options.tools.execute(
      { callId: `lol_${randomUUID()}`, name: 'lol.lookup', arguments: { query } },
      {
        traceId: `trace_${randomUUID()}`,
        turnId: `turn_${randomUUID()}`,
        signal: new AbortController().signal,
        timeoutMs: 8000,
      },
    );

    const text = lolSpeech(result, viewerName);
    const effects: StageEffect[] =
      result.status === 'ok' && result.data !== null
        ? [
            {
              kind: 'card',
              text: lolCardTitle(result),
              data: result.data,
              isMock: result.isMock,
            },
          ]
        : [];

    await this.publish(text, effects, result.isMock);
    this.log({
      event: 'program.lol',
      status: result.status,
      isMock: result.isMock,
      durationMs: result.durationMs,
    });
  }

  private async handleSignature(text: string, viewerName: string | null): Promise<void> {
    const result = await this.options.tools.execute(
      {
        callId: `sig_${randomUUID()}`,
        name: 'signature.create',
        arguments: { text, viewerName },
      },
      {
        traceId: `trace_${randomUUID()}`,
        turnId: `turn_${randomUUID()}`,
        signal: new AbortController().signal,
        timeoutMs: 8000,
      },
    );

    if (result.status !== 'ok' || result.data === null) {
      await this.publish('签名没生成成功，等下再试。', [], true);
      return;
    }
    const data = result.data as { text: string; imageUrl: string; souvenirUrl: string };
    await this.publish(
      `给${viewerName ?? '你'}签好了：${data.text}。纪念品在 ${data.souvenirUrl}。`,
      [
        {
          kind: 'signature',
          text: `签名：${data.text}`,
          data,
          imageUrl: data.imageUrl,
          isMock: true,
        },
      ],
      true,
    );
    this.log({ event: 'program.signature', souvenir: data.souvenirUrl });
  }

  private async handleBossOpen(): Promise<void> {
    const before = this.boss.snapshot();
    if (before.phase === 'open') {
      await this.publish('这回合已经开了，直接发「攻击 / 蓄力 / 治疗」。', [
        { kind: 'game', text: 'Boss 回合进行中', data: before, isMock: false },
      ], false);
      return;
    }
    const state = this.boss.openRound();
    if (state.roundId) {
      const created = this.options.repository.createProgramRun({
        id: state.roundId,
        program: 'boss',
        roomId: this.options.roomId,
        now: this.now(),
      });
      if (!created) {
        // 主键冲突说明回合 ID 复用了：不静默继续，记录并降级为“无持久化回合”。
        // 注意：此时 game_actions 的外键会失败，handleBossAct 会回滚内存状态。
        this.log({ event: 'program.boss.round_id_conflict', roundId: state.roundId });
        this.activeRoundRunId = null;
      } else {
        this.options.repository.updateProgramRun(state.roundId, { round: state.round });
        this.activeRoundRunId = state.roundId;
      }
    }
    this.options.stage.setProgram('boss', state);
    this.options.stage.updateProgramState(state);
    await this.publish(
      `第 ${state.round} 回合开始！Boss「${state.bossName}」还有 ${state.bossHp} 血，发「攻击」「蓄力」「治疗」，每人一次。`,
      [{ kind: 'game', text: `第 ${state.round} 回合`, data: state, isMock: false }],
      false,
    );
  }

  private async handleBossAct(
    action: BossAction,
    viewerId: string,
    viewerName: string | null,
  ): Promise<void> {
    const current = this.boss.snapshot();
    if (current.phase !== 'open') {
      await this.publish('现在没在开回合，发「开Boss」开始。', [], false);
      return;
    }
    if (!current.roundId) {
      await this.publish('回合状态异常，先发「开Boss」。', [], false);
      return;
    }

    // 先让状态机校验（窗口、重复、回合有效性），再落库。
    // 反过来的话，被拒绝的动作会写进 game_actions，污染已结束回合的统计。
    const outcome = this.boss.submit({ viewerId, viewerName, action });
    if (!outcome.accepted) {
      await this.publish(bossRejectText(outcome.reason, viewerName), [], false);
      return;
    }

    // 数据库唯一约束是“每观众一次”的最终防线（跨进程/重启也成立）。
    // 内存已接受但写库失败时，回滚内存状态：宁可少记一票，也不能内存与 DB 不一致。
    let fresh = false;
    try {
      fresh = this.options.repository.recordGameAction({
        roundId: current.roundId,
        viewerId,
        action,
        now: this.now(),
      });
    } catch (error) {
      this.log({
        event: 'program.boss.persist_failed',
        roundId: current.roundId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!fresh) {
      this.boss.revertSubmission(viewerId);
      await this.publish(`${viewerName ?? '你'}这回合已经出过手了，等下回合。`, [], false);
      return;
    }
    this.options.stage.updateProgramState(outcome.state);
    // 单人动作不逐条朗读，只在回合结算时统一播报，避免刷屏。
  }

  private async handleBossSettle(): Promise<void> {
    const before = this.boss.snapshot();
    if (before.phase !== 'open') {
      await this.publish('现在没有进行中的回合。', [], false);
      return;
    }
    // 副作用由 onSettled 回调统一处理，这里只触发结算。
    const result = this.boss.settle();
    if (!result) {
      await this.publish('结算失败，先重新开一回合。', [], false);
    }
  }

  /** 游戏结算归档为纪念品；不参与当场计分。 */
  private async archiveGameSouvenir(result: BossRoundResult): Promise<void> {
    const publicId = randomUUID().replace(/-/g, '').slice(0, 16);
    const stored = this.options.repository.insertSouvenir({
      souvenir: {
        publicId,
        kind: 'game-report',
        title: `第 ${result.round} 回合战报`,
        text: result.summary,
        imageUrl: null,
        isMock: false,
        program: 'boss',
        createdAt: this.now().toISOString(),
        data: result,
      },
      imagePath: null,
      roomId: this.options.roomId,
    });
    if (!stored) {
      this.log({ event: 'program.boss.souvenir_conflict', publicId });
    }
  }

  /** 生成语音（若可用）+ 舞台回应。TTS 失败时降级为纯字幕，不阻塞舞台。 */
  private async publish(text: string, effects: StageEffect[], isMock: boolean): Promise<SpeechPlan> {
    const turnId = `turn_${randomUUID()}`;
    let artifact: SynthesizeResult | null = null;

    if (this.options.speech.available) {
      try {
        artifact = await this.options.speech.synthesize({
          speechId: `speech_${randomUUID()}`,
          text,
          signal: new AbortController().signal,
        });
      } catch (error) {
        this.log({
          event: 'speech.failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.options.stage.publishSpeech({
      turnId,
      text,
      toolResults: [],
      degraded: false,
      artifact,
      extraEffects: effects.map((effect) => ({ ...effect, isMock: effect.isMock || isMock })),
    });
  }
}

function lolSpeech(result: ToolResult, viewerName: string | null): string {
  if (result.status === 'ok' && result.data !== null) {
    const data = result.data as { displayName: string; rank: string; role: string };
    const mockTag = result.isMock ? '（mock 数据）' : '';
    const prefix = viewerName ? `${viewerName} 问的：` : '';
    return `${prefix}${data.displayName} 现在是 ${data.rank}，主要打 ${data.role}${mockTag}。`;
  }
  if (result.status === 'timeout') return '战绩服务超时了，这次不编数据。';
  if (result.status === 'cancelled') return '这次查询被取消了。';
  return `没查到：${result.message ?? '未知原因'}。我不编数据。`;
}

function lolCardTitle(result: ToolResult): string {
  const data = result.data as { displayName?: string; rank?: string } | null;
  if (!data?.displayName) return '战绩';
  return `${data.displayName} · ${data.rank ?? '战绩'}`;
}

function bossRejectText(reason: string | undefined, viewerName: string | null): string {
  switch (reason) {
    case 'already_submitted':
      return `${viewerName ?? '你'}这回合已经出过手了。`;
    case 'window_closed':
      return '这回合窗口关了，等下一回合。';
    case 'round_not_open':
      return '现在没在开回合，发「开Boss」开始。';
    default:
      return '这次动作没生效。';
  }
}
