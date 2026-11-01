import { z } from 'zod';
import { ToolRequestSchema } from './tools.js';

/**
 * 模型适配层契约。harness 只依赖这些类型，不依赖任何具体网关协议。
 * 不包含隐藏推理内容，只保留可展示文本、工具请求、结束原因与用量。
 */
export const ModelCapabilitiesSchema = z.object({
  nativeTools: z.boolean(),
  structuredOutput: z.boolean(),
  /** 适配器自报的模型标识，用于 trace 与 eval 记录。 */
  modelId: z.string().min(1),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const FinishReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'length',
  'cancelled',
  'error',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const AssistantTurnSchema = z.object({
  text: z.string(),
  toolCalls: z.array(ToolRequestSchema),
  finishReason: FinishReasonSchema,
  usage: ModelUsageSchema,
  /** 适配器在降级路径下必须声明，便于区分“完整工具循环”与“降级模式”。 */
  degraded: z.boolean().default(false),
});
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * 发送给模型的单条上下文消息。
 * tool 角色消息承载工具结果，`trusted=false` 表示内容是外部数据。
 */
export const ModelMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  trusted: z.boolean(),
  /** 工具消息关联的 callId，便于模型对齐结果。 */
  toolCallId: z.string().optional(),
  /** 工具消息对应的工具名；OpenAI 兼容协议需要它做对齐。 */
  name: z.string().optional(),
  /** assistant 消息请求过的工具；重建上下文时保持请求/结果成对。 */
  toolCalls: z.array(ToolRequestSchema).optional(),
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;
