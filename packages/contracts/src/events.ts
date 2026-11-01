import { z } from 'zod';

/**
 * 事件信封：所有进入系统的外部输入都先归一化成这个结构。
 * receivedAt / traceId 由服务端分配，客户端传来的同名字段不被信任。
 */
export const SCHEMA_VERSION = 1 as const;

export const IngressEventType = z.enum([
  'chat.message',
  'viewer.join',
  'viewer.leave',
  'system.tick',
  'simulation.note',
]);
export type IngressEventType = z.infer<typeof IngressEventType>;

export const MAX_MESSAGE_LENGTH = 300;
export const MAX_VIEWER_NAME_LENGTH = 40;

/** 弹幕文本：先裁剪首尾空白，再限制长度，超长直接拒绝而不是静默截断。 */
export const MessageTextSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_MESSAGE_LENGTH));

export const ChatMessagePayloadSchema = z.object({
  text: MessageTextSchema,
  /** 展示用昵称，可变，不作为稳定身份。 */
  viewerName: z.string().trim().min(1).max(MAX_VIEWER_NAME_LENGTH).optional(),
});

export const ViewerPresencePayloadSchema = z.object({
  viewerName: z.string().trim().min(1).max(MAX_VIEWER_NAME_LENGTH).optional(),
});

export const SystemTickPayloadSchema = z.object({
  reason: z.enum(['idle', 'scheduled', 'manual']).default('scheduled'),
});

export const SimulationNotePayloadSchema = z.object({
  note: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export const IngressPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.message'), payload: ChatMessagePayloadSchema }),
  z.object({ type: z.literal('viewer.join'), payload: ViewerPresencePayloadSchema }),
  z.object({ type: z.literal('viewer.leave'), payload: ViewerPresencePayloadSchema }),
  z.object({ type: z.literal('system.tick'), payload: SystemTickPayloadSchema }),
  z.object({ type: z.literal('simulation.note'), payload: SimulationNotePayloadSchema }),
]);
export type IngressPayload = z.infer<typeof IngressPayloadSchema>;

/** 适配器提交的原始事件：只允许声明业务字段，服务端补全可信字段。 */
export const IngressSubmissionSchema = z
  .object({
    roomId: z.string().trim().min(1).max(64),
    /** 平台侧事件 ID；缺失时服务端退回内容指纹去重并标记风险。 */
    eventId: z.string().trim().min(1).max(128).optional(),
    viewerId: z.string().trim().min(1).max(128).optional(),
    /** 平台侧发生时间，仅作参考，不能覆盖服务端 receivedAt。 */
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .and(IngressPayloadSchema);
export type IngressSubmission = z.infer<typeof IngressSubmissionSchema>;

export const EventEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: z.string().min(1),
  roomId: z.string().min(1),
  sessionId: z.string().min(1),
  viewerId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
  traceId: z.string().min(1),
  type: IngressEventType,
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const IngestAcceptedSchema = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean(),
  eventId: z.string().min(1),
  traceId: z.string().min(1),
  /** 去重依据：platform-id 为可信；content-fingerprint 表示有误判边界。 */
  dedupeStrategy: z.enum(['platform-id', 'content-fingerprint']),
});
export type IngestAccepted = z.infer<typeof IngestAcceptedSchema>;
