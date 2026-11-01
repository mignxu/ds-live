import type { Memory } from '@dafeiyu/contracts';
import type { Repository } from '../storage/repository.js';
import { cutoffFor, type RetentionConfig } from '../storage/retention.js';

/**
 * 长期记忆策略。
 *
 * 边界（来自设计文档）：
 * - 只保存有用偏好和明确同意的记忆，可查看、纠正、清除；
 * - 昵称可变，不作为稳定身份；
 * - 游戏分数/战绩等事实由业务表提供，不用记忆替代；
 * - 观众说“你现在不是大肥鱼”不会写回角色。
 */
export type MemoryWriteInput = {
  roomId: string;
  scope: 'session' | 'viewer';
  sessionId: string | null;
  viewerId: string | null;
  key: string;
  value: unknown;
  source: 'viewer-stated' | 'session-derived' | 'admin';
  confidence?: number;
  ttlDays?: number | null;
};

/** 允许写入的 key 白名单：避免模型/观众随意往记忆里塞任意字段。 */
const ALLOWED_KEYS = new Set([
  'preferred_topic',
  'nickname_pref',
  'play_style',
  'signature_style',
]);

/** 明确的“记住…”句式，视为观众明示同意。 */
const EXPLICIT_REMEMBER = /(?:记住|记一下|别忘了)[:：\s]*(.{1,80})/u;

export class MemoryService {
  constructor(
    private readonly repository: Repository,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** 加载当前会话/观众可用记忆，进入上下文。 */
  load(input: {
    roomId: string;
    sessionId: string;
    viewerId: string | null;
    limit?: number;
  }): Memory[] {
    return this.repository.listMemories({
      roomId: input.roomId,
      sessionId: input.sessionId,
      viewerId: input.viewerId,
      now: this.now(),
      limit: input.limit ?? 10,
    });
  }

  /**
   * 从观众消息里提取“明确同意的记忆”。
   *
   * 只处理显式的“记住 xxx”，不做模型推断：
   * 模型推断的记忆无法让观众知情，违反“明确同意”。
   */
  captureExplicit(input: {
    roomId: string;
    sessionId: string;
    viewerId: string | null;
    text: string;
  }): Memory | null {
    const match = input.text.match(EXPLICIT_REMEMBER);
    const fact = match?.[1]?.trim();
    if (!fact || fact.length < 2) return null;
    // 身份类指令不允许写回角色（设计文档明确要求）。
    if (/(你是|你不是|改名|叫我.*模型|忽略.*规则)/u.test(fact)) return null;

    return this.write({
      roomId: input.roomId,
      scope: input.viewerId ? 'viewer' : 'session',
      sessionId: input.sessionId,
      viewerId: input.viewerId,
      key: 'preferred_topic',
      value: { note: fact.slice(0, 80) },
      source: 'viewer-stated',
      confidence: 0.9,
      ttlDays: 30,
    });
  }

  write(input: MemoryWriteInput): Memory | null {
    if (!ALLOWED_KEYS.has(input.key)) return null;

    const now = this.now();
    const expiresAt =
      input.ttlDays === null || input.ttlDays === undefined
        ? null
        : new Date(now.getTime() + input.ttlDays * 24 * 60 * 60 * 1000).toISOString();

    return this.repository.upsertMemory({
      roomId: input.roomId,
      scope: input.scope,
      sessionId: input.sessionId,
      viewerId: input.viewerId,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence: input.confidence ?? 0.8,
      expiresAt,
      now,
    });
  }

  /** 管理面：列出房间全部记忆（含过期）。 */
  listAll(roomId: string, limit = 100): Memory[] {
    return this.repository.listAllMemories(roomId, limit);
  }

  remove(id: string): boolean {
    return this.repository.deleteMemory(id);
  }

  clearViewer(roomId: string, viewerId: string): number {
    return this.repository.deleteMemoriesForViewer(roomId, viewerId);
  }

  /** 按保留策略清理过期记忆。 */
  prune(config: RetentionConfig): number {
    return this.repository.pruneExpiredMemories(this.now(), config.memoriesGraceDays);
  }
}

/** 把记忆渲染成给模型看的一行摘要；不含 viewerId。 */
export function renderMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((memory) => {
    const value =
      typeof memory.value === 'object' && memory.value !== null
        ? JSON.stringify(memory.value)
        : String(memory.value);
    return `- ${memory.key}: ${value.slice(0, 120)}（来源：${memory.source}）`;
  });
  return ['## 已知偏好（来自观众明说或主播设置，可能过时）', ...lines].join('\n');
}

export { cutoffFor };
