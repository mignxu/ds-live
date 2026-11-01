import { z } from 'zod';

/**
 * 记忆契约。
 *
 * 设计文档要求：只保存有用偏好和明确同意的记忆，可查看、纠正和清除；
 * 游戏分数与战绩等事实由业务数据提供，不用模型记忆替代。
 * 昵称可变，不作为稳定身份。
 */
export const MemoryScopeSchema = z.enum(['session', 'viewer']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemorySchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  scope: MemoryScopeSchema,
  sessionId: z.string().nullable(),
  viewerId: z.string().nullable(),
  /** 短标识，例如 'preferred_topic'、'nickname_pref'。 */
  key: z.string().min(1).max(64),
  value: z.unknown(),
  /** 来源：viewer-stated（观众明说）/ session-derived（会话推断）/ admin。 */
  source: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Memory = z.infer<typeof MemorySchema>;

export const MemoryListSchema = z.object({
  items: z.array(MemorySchema).max(100),
});
export type MemoryList = z.infer<typeof MemoryListSchema>;

/** 允许写入记忆的来源。模型推断不能作为唯一来源。 */
export const MemorySourceSchema = z.enum([
  'viewer-stated',
  'session-derived',
  'admin',
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;
