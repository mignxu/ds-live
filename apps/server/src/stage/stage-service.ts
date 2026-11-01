import { randomUUID } from 'node:crypto';
import type {
  PlaybackReceipt,
  SpeechPlan,
  StageEffect,
  StageEvent,
  StageSnapshot,
  ToolResult,
} from '@dafeiyu/contracts';

/**
 * 舞台状态与广播。
 *
 * 音频：`SpeechPlan.audioUrl` 由 TTS 适配器提供；没有 TTS 时为 null（纯字幕）。
 * 无论有没有音频，都走同一套 speechId / 回执 / 租约协议。
 */
export type StageSubscriber = (event: StageEvent) => void;

export type RendererLease = {
  token: string;
  acquiredAt: string;
};

/** 舞台只关心这三个字段；TTS 适配器的结果可直接当 artifact 传入。 */
export type SpeechArtifact = {
  audioUrl: string | null;
  durationMs: number | null;
  timings: SpeechPlan['timings'];
  isMock: boolean;
};

export class StageService {
  private revision = 0;
  private activeSpeech: SpeechPlan | null = null;
  private recent: SpeechPlan[] = [];
  private readonly subscribers = new Set<StageSubscriber>();
  private lease: RendererLease | null = null;
  private degraded = { active: false, reason: null as string | null };
  private program = 'chat';
  private programState: unknown = null;

  constructor(
    private readonly options: {
      roomId: string;
      characterName: string;
      program: string;
      now?: () => Date;
      recentLimit?: number;
    },
  ) {
    this.program = options.program;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private bump(): void {
    this.revision += 1;
  }

  subscribe(subscriber: StageSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private broadcast(event: StageEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }

  setDegraded(active: boolean, reason: string | null): void {
    this.degraded = { active, reason };
    this.bump();
  }

  /** 切换节目并广播当前节目状态。 */
  setProgram(program: string, state: unknown): void {
    this.program = program;
    this.programState = state;
    this.bump();
    this.broadcast({ type: 'program.changed', program, state });
  }

  /** 只更新节目状态（例如 Boss 回合推进），不切换节目。 */
  updateProgramState(state: unknown): void {
    this.programState = state;
    this.bump();
    this.broadcast({ type: 'program.changed', program: this.program, state });
  }

  /**
   * 生成回应计划并入队。
   * 上一句还没播完就被新回应取代时，先显式广播 cancelled，
   * 避免舞台对着旧 speechId 发无效回执。
   */
  publishSpeech(input: {
    turnId: string;
    text: string;
    toolResults: ToolResult[];
    degraded: boolean;
    artifact?: SpeechArtifact | null;
    extraEffects?: StageEffect[];
  }): SpeechPlan {
    const superseded = this.activeSpeech;
    if (superseded) {
      this.broadcast({ type: 'speech.cancelled', speechId: superseded.speechId });
    }

    const artifact = input.artifact ?? null;
    const effects: StageEffect[] = [{ kind: 'speech', text: input.text, isMock: false }];
    effects.push(...buildToolEffects(input.toolResults));
    if (input.extraEffects) effects.push(...input.extraEffects);

    const speech: SpeechPlan = {
      speechId: `speech_${randomUUID()}`,
      turnId: input.turnId,
      text: input.text,
      audioUrl: artifact?.audioUrl ?? null,
      audioDurationMs: artifact?.durationMs ?? null,
      timings: artifact?.timings ?? [],
      audioIsMock: artifact?.isMock ?? false,
      effects,
      isMock:
        input.toolResults.some((result) => result.isMock) ||
        (input.extraEffects?.some((effect) => effect.isMock) ?? false),
      createdAt: this.now().toISOString(),
    };
    this.activeSpeech = speech;
    this.recent = [...this.recent, speech].slice(-(this.options.recentLimit ?? 5));
    this.bump();
    this.broadcast({ type: 'speech.ready', speech });
    return speech;
  }

  snapshot(): StageSnapshot {
    return {
      revision: this.revision,
      roomId: this.options.roomId,
      program: this.program,
      characterName: this.options.characterName,
      activeSpeech: this.activeSpeech,
      recentSpeeches: this.recent,
      degraded: this.degraded,
      programState: this.programState,
      updatedAt: this.now().toISOString(),
    };
  }

  /** 选主：新连接获取租约，旧主回执将被拒绝。 */
  acquireRendererLease(): RendererLease {
    this.lease = { token: `renderer_${randomUUID()}`, acquiredAt: this.now().toISOString() };
    this.bump();
    return this.lease;
  }

  /**
   * 播放回执。返回 accepted=false 表示租约不匹配或 speech 不存在，调用方应拒绝。
   * 不默认重播已结束音频。
   */
  handleReceipt(receipt: PlaybackReceipt): { accepted: boolean; reason?: string } {
    if (!this.lease || this.lease.token !== receipt.rendererToken) {
      return { accepted: false, reason: 'stale_renderer_lease' };
    }
    if (!this.activeSpeech || this.activeSpeech.speechId !== receipt.speechId) {
      return { accepted: false, reason: 'unknown_speech' };
    }

    switch (receipt.state) {
      case 'started':
        this.broadcast({ type: 'speech.started', speechId: receipt.speechId });
        break;
      case 'ended':
        this.broadcast({ type: 'speech.completed', speechId: receipt.speechId });
        this.activeSpeech = null;
        this.bump();
        this.broadcast({ type: 'idle' });
        break;
      case 'cancelled':
      case 'failed':
        this.broadcast({ type: 'speech.cancelled', speechId: receipt.speechId });
        this.activeSpeech = null;
        this.bump();
        break;
      case 'progress':
        // 进度只用于前端同步，不改变服务端状态。
        break;
    }
    return { accepted: true };
  }

  /** 主播手动停止：清空当前回应并通知舞台。 */
  cancelActive(): SpeechPlan | null {
    const speech = this.activeSpeech;
    if (speech) {
      this.broadcast({ type: 'speech.cancelled', speechId: speech.speechId });
      this.activeSpeech = null;
      this.bump();
      this.broadcast({ type: 'idle' });
    }
    return speech;
  }
}

function buildToolEffects(toolResults: ToolResult[]): StageEffect[] {
  const effects: StageEffect[] = [];
  for (const result of toolResults) {
    if (result.status !== 'ok' || result.data === null) continue;
    effects.push({
      kind: 'card',
      text: cardTitle(result),
      data: result.data,
      isMock: result.isMock,
    });
  }
  return effects;
}

function cardTitle(result: ToolResult): string {
  const data = result.data as Record<string, unknown> | null;
  if (data && typeof data.displayName === 'string') {
    return `${data.displayName} · ${typeof data.rank === 'string' ? data.rank : '战绩'}`;
  }
  if (data && typeof data.query === 'string') return `搜索：${data.query}`;
  return result.name;
}
