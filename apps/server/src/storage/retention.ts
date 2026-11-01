import { z } from 'zod';

/**
 * 保留期限配置。
 *
 * 设计文档要求：原始弹幕不长期保存，调试事件 7 天，普通会话 7 天，
 * 已公开纪念品 30 天；记忆由用户可见策略控制。全部可配置，上线前需确认。
 *
 * 单位：天。0 表示“不自动清理”（需要运维手动处理，慎用）。
 */
export const RetentionConfigSchema = z.object({
  /** 去重表：只用于防重放，过期即可删。 */
  processedEventsDays: z.number().int().min(0).max(365).default(7),
  /** 会话消息（含观众原文）：默认不长期保存。 */
  messagesDays: z.number().int().min(0).max(365).default(7),
  /** 轮次与工具调用记录：保留用于排查与审计。 */
  turnsDays: z.number().int().min(0).max(365).default(30),
  /** 已公开纪念品：默认 30 天。 */
  souvenirsDays: z.number().int().min(0).max(3650).default(30),
  /** 过期记忆（expires_at 已过）额外宽限天数。 */
  memoriesGraceDays: z.number().int().min(0).max(365).default(0),
});

export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

export type RetentionStats = {
  processedEvents: number;
  messages: number;
  turns: number;
  souvenirs: number;
  memories: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 把“天”换算成截止时间；0 表示不清理，返回 null。 */
export function cutoffFor(days: number, now: Date): Date | null {
  if (days <= 0) return null;
  return new Date(now.getTime() - days * DAY_MS);
}
