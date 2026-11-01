import { z } from 'zod';

/**
 * 工具契约：模型只能“提出请求”，宿主负责校验、授权、执行和结果封装。
 * 工具结果对模型而言是不可信数据，必须带来源与 mock 标记。
 */
export const ToolNameSchema = z.enum([
  'lol.lookup',
  'web.search',
  'signature.create',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** 只读工具集合：执行器可据此判断是否允许并发/重试。 */
export const READ_ONLY_TOOLS: readonly ToolName[] = ['lol.lookup', 'web.search'];

/**
 * 写操作工具需要观众明确触发，不接受模型自由调用。
 * 当前签名是写操作（生成文件并公开），因此不在模型白名单里。
 */

export const ToolRequestSchema = z.object({
  callId: z.string().min(1),
  name: ToolNameSchema,
  /** 模型给出的原始参数，宿主按工具 schema 再校验一次。 */
  arguments: z.unknown(),
});
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const ToolErrorCodeSchema = z.enum([
  'invalid_arguments',
  'unknown_tool',
  'permission_denied',
  'timeout',
  'cancelled',
  'upstream_error',
  'not_configured',
  'budget_exceeded',
  'unsafe_target',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolResultStatus = z.enum(['ok', 'error', 'cancelled', 'timeout']);
export type ToolResultStatus = z.infer<typeof ToolResultStatus>;

export const ToolSourceSchema = z.enum([
  'mock',
  'local',
  'lol-http',
  'web-egress',
]);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

export const ToolResultSchema = z.object({
  callId: z.string().min(1),
  name: ToolNameSchema,
  status: ToolResultStatus,
  /** 成功时的结构化事实；失败时为 null，不伪造内容。 */
  data: z.unknown().nullable(),
  source: ToolSourceSchema,
  /** true 表示数据来自 mock 适配器，必须一路传到舞台与纪念品。 */
  isMock: z.boolean(),
  errorCode: ToolErrorCodeSchema.nullable(),
  retryable: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** 面向模型的简短说明；敏感上游细节不进入此处。 */
  message: z.string().max(500).nullable(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ToolDefinitionSchema = z.object({
  name: ToolNameSchema,
  description: z.string().min(1),
  /** JSON Schema 形式，供模型侧声明参数；宿主另做 zod 校验。 */
  parameters: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
