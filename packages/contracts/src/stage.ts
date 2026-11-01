import { z } from 'zod';

/**
 * 舞台契约：后端产出可播放的回应计划，舞台只负责呈现与回执。
 *
 * 音频字段：P2 起 `audioUrl` 可能非空，`audioDurationMs` 由 TTS 适配器给出。
 * 没有词级时间戳时只提供句级 `timings`，不宣称精确对齐。
 */
export const TurnPhaseSchema = z.enum([
  'QUEUED',
  'PLANNING',
  'TOOL_RUNNING',
  'READY',
  'SPEAKING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
]);
export type TurnPhase = z.infer<typeof TurnPhaseSchema>;

export const StageEffectSchema = z.object({
  kind: z.enum(['speech', 'card', 'signature', 'game', 'idle', 'clear']),
  /** speech 时为台词；card/signature/game 时为标题。 */
  text: z.string(),
  /** 附带的结构化事实，例如工具结果卡片；可能来自 mock。 */
  data: z.unknown().optional(),
  /** signature/game 等视觉素材地址（相对路径）。 */
  imageUrl: z.string().nullable().optional(),
  isMock: z.boolean().default(false),
});
export type StageEffect = z.infer<typeof StageEffectSchema>;

/** 句级时间片：startMs/endMs 相对语音开头；没有词级数据时用它驱动字幕。 */
export const SpeechTimingSchema = z.object({
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type SpeechTiming = z.infer<typeof SpeechTimingSchema>;

export const SpeechPlanSchema = z.object({
  speechId: z.string().min(1),
  turnId: z.string().min(1),
  text: z.string(),
  /** TTS 音频地址；null 表示无音频，舞台只显示字幕。 */
  audioUrl: z.string().nullable(),
  /** 音频真实时长；无音频时为 null。 */
  audioDurationMs: z.number().int().nonnegative().nullable().default(null),
  /** 句级时间片；无 TTS 时间戳时为空数组。 */
  timings: z.array(SpeechTimingSchema).default([]),
  /** 音频来源是否 mock（例如本地合成音）。 */
  audioIsMock: z.boolean().default(false),
  effects: z.array(StageEffectSchema),
  isMock: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type SpeechPlan = z.infer<typeof SpeechPlanSchema>;

export const StageSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  roomId: z.string().min(1),
  /** 当前节目 id：chat / lol / signature / boss。 */
  program: z.string().min(1),
  characterName: z.string().min(1),
  /** 正在播放或待播放的回应；null 表示待机。 */
  activeSpeech: SpeechPlanSchema.nullable(),
  /** 最近若干条已完成的台词，用于重连后恢复可见上下文。 */
  recentSpeeches: z.array(SpeechPlanSchema).max(10),
  /** 降级状态：模型不支持原生工具时显式暴露，不伪装成完整循环。 */
  degraded: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  /** 当前节目状态（例如 Boss 回合），供舞台卡片使用。 */
  programState: z.unknown().nullable().default(null),
  updatedAt: z.string().datetime({ offset: true }),
});
export type StageSnapshot = z.infer<typeof StageSnapshotSchema>;

export const PlaybackReceiptSchema = z.object({
  speechId: z.string().min(1),
  /** 选主令牌，后端拒绝旧主的回执。 */
  rendererToken: z.string().min(1),
  state: z.enum(['started', 'progress', 'ended', 'failed', 'cancelled']),
  /** 播放进度毫秒，用于字幕/口型同步；无音频时可为 0。 */
  positionMs: z.number().int().nonnegative().default(0),
  error: z.string().max(200).optional(),
});
export type PlaybackReceipt = z.infer<typeof PlaybackReceiptSchema>;

export const StageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: StageSnapshotSchema }),
  z.object({ type: z.literal('speech.ready'), speech: SpeechPlanSchema }),
  z.object({ type: z.literal('speech.started'), speechId: z.string() }),
  z.object({ type: z.literal('speech.completed'), speechId: z.string() }),
  z.object({ type: z.literal('speech.cancelled'), speechId: z.string() }),
  z.object({ type: z.literal('program.changed'), program: z.string(), state: z.unknown() }),
  z.object({ type: z.literal('idle') }),
]);
export type StageEvent = z.infer<typeof StageEventSchema>;

/** 控制台可见的内部状态；不含密钥，也不下发到舞台。 */
export const StudioStatusSchema = z.object({
  characterName: z.string().min(1),
  characterVersion: z.string().min(1),
  modelId: z.string().min(1),
  degraded: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  room: z.object({
    id: z.string().min(1),
    count: z.number().int().nonnegative(),
    max: z.number().int().positive(),
  }),
  queue: z.object({
    queued: z.number().int().nonnegative(),
    planning: z.number().int().nonnegative(),
    speaking: z.number().int().nonnegative(),
  }),
  budget: z.object({
    maxModelCallsPerTurn: z.number().int().positive(),
    maxToolCallsPerTurn: z.number().int().positive(),
    turnDeadlineMs: z.number().int().positive(),
  }),
  program: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    state: z.unknown(),
  }),
  /** TTS 适配器状态；未配置时 available=false。 */
  speech: z.object({
    available: z.boolean(),
    isMock: z.boolean(),
    voice: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  /** 保留期限：配置与待清理数量（只读，供控制台展示）。 */
  retention: z.object({
    pending: z.object({
      processedEvents: z.number().int().nonnegative(),
      messages: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
      souvenirs: z.number().int().nonnegative(),
      memories: z.number().int().nonnegative(),
    }),
    config: z.object({
      processedEventsDays: z.number().int().nonnegative(),
      messagesDays: z.number().int().nonnegative(),
      turnsDays: z.number().int().nonnegative(),
      souvenirsDays: z.number().int().nonnegative(),
      memoriesGraceDays: z.number().int().nonnegative(),
    }),
  }),
  recentTurns: z.array(
    z.object({
      turnId: z.string(),
      phase: TurnPhaseSchema,
      modelCalls: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative(),
      finishReason: z.string().nullable(),
      errorCode: z.string().nullable(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    }),
  ),
  updatedAt: z.string().datetime({ offset: true }),
});
export type StudioStatus = z.infer<typeof StudioStatusSchema>;
