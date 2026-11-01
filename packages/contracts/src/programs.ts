import { z } from 'zod';

/**
 * 节目（program）契约。
 *
 * 分界：节目维护确定性的玩法状态与事实；模型只负责“怎么说”。
 * 节目不能自己调用模型供应商，也不能自己创建播放线程。
 */
export const ProgramIdSchema = z.enum(['chat', 'lol', 'signature', 'boss']);
export type ProgramId = z.infer<typeof ProgramIdSchema>;

export const ProgramInfoSchema = z.object({
  id: ProgramIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  /** 是否需要模型点评；false 表示确定性节目，直接给台词。 */
  usesModel: z.boolean(),
});
export type ProgramInfo = z.infer<typeof ProgramInfoSchema>;

export const ProgramSnapshotSchema = z.object({
  id: ProgramIdSchema,
  label: z.string().min(1),
  /** 节目自定义的只读状态，用于控制台与舞台卡片。 */
  state: z.unknown(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProgramSnapshot = z.infer<typeof ProgramSnapshotSchema>;

/** 合作打 Boss：一个房间一个回合，每观众一次有效动作，服务端结算。 */
export const BossRoundStateSchema = z.enum(['idle', 'open', 'settling', 'resolved']);
export type BossRoundState = z.infer<typeof BossRoundStateSchema>;

export const BossActionSchema = z.enum(['attack', 'charge', 'heal']);
export type BossAction = z.infer<typeof BossActionSchema>;

export const BossStateSchema = z.object({
  roundId: z.string().nullable(),
  round: z.number().int().nonnegative(),
  phase: BossRoundStateSchema,
  bossName: z.string(),
  bossHp: z.number().int().nonnegative(),
  bossMaxHp: z.number().int().positive(),
  partyHp: z.number().int().nonnegative(),
  partyMaxHp: z.number().int().positive(),
  /** 已提交动作的观众数（按 viewerId 去重）。 */
  submitted: z.number().int().nonnegative(),
  /** 输入窗口剩余毫秒；phase 不是 open 时为 0。 */
  windowRemainingMs: z.number().int().nonnegative(),
  lastOutcome: z.string().nullable(),
});
export type BossState = z.infer<typeof BossStateSchema>;
