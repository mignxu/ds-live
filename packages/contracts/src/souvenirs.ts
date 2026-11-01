import { z } from 'zod';

/**
 * 纪念品契约。
 *
 * 硬约束：纪念品只用于事后浏览，不影响当场参与、计分或结算。
 * 公开作品必须走明确公开规则；不暴露服务器文件路径、token 或观众私有记忆。
 */
export const SouvenirKindSchema = z.enum(['signature', 'lol-report', 'game-report']);
export type SouvenirKind = z.infer<typeof SouvenirKindSchema>;

export const SouvenirSchema = z.object({
  /** 对外公开 ID，不可枚举（随机），不是平台 viewerId。 */
  publicId: z.string().min(8),
  kind: SouvenirKindSchema,
  title: z.string().min(1).max(120),
  /** 展示用正文；可以是台词或战报摘要。 */
  text: z.string().max(2000),
  /** 相对媒体地址，例如 /media/souvenirs/xxx.svg；null 表示纯文字。 */
  imageUrl: z.string().nullable(),
  isMock: z.boolean(),
  /** 来源节目与轮次，便于追溯；不含观众隐私。 */
  program: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  /** 结构化事实（战报数据、游戏结算），可能来自 mock。 */
  data: z.unknown().nullable(),
});
export type Souvenir = z.infer<typeof SouvenirSchema>;

export const SouvenirListSchema = z.object({
  items: z.array(SouvenirSchema).max(50),
  total: z.number().int().nonnegative(),
});
export type SouvenirList = z.infer<typeof SouvenirListSchema>;
