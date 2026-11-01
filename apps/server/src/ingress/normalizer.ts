import { createHash, randomUUID } from 'node:crypto';
import type { IngressSubmission, IngressPayload } from '@dafeiyu/contracts';

/**
 * 事件归一化、去重与限流。
 *
 * 去重策略：
 * - 平台提供 eventId → 按 roomId+eventId 去重（可信）；
 * - 无 eventId → 按房间+观众+文本+时间窗的内容指纹去重，并如实标记误判边界。
 */
export type DedupeStrategy = 'platform-id' | 'content-fingerprint';

export type NormalizedEvent = {
  eventId: string;
  traceId: string;
  roomId: string;
  viewerId: string;
  occurredAt: string;
  receivedAt: string;
  type: IngressPayload['type'];
  payload: unknown;
  dedupeKey: string;
  dedupeStrategy: DedupeStrategy;
};

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: 'rate_limited' | 'empty'; retryAfterMs?: number };

const FINGERPRINT_WINDOW_MS = 15_000;
const PRUNE_INTERVAL_MS = 60_000;

export class IngressNormalizer {
  private readonly buckets = new Map<string, number[]>();
  private lastPruneAt = 0;

  constructor(
    private readonly options: {
      rateLimitPerMinute: number;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** 滑动窗口限流，按 viewerId（缺省按 room）分桶。 */
  private checkRateLimit(bucketKey: string): { allowed: boolean; retryAfterMs: number } {
    const nowMs = this.now().getTime();
    const windowStart = nowMs - 60_000;
    const bucket = (this.buckets.get(bucketKey) ?? []).filter((ts) => ts > windowStart);
    if (bucket.length >= this.options.rateLimitPerMinute) {
      const oldest = bucket[0] ?? nowMs;
      this.buckets.set(bucketKey, bucket);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + 60_000 - nowMs) };
    }
    bucket.push(nowMs);
    this.buckets.set(bucketKey, bucket);
    this.maybePrune(nowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * 定期清理过期桶。观众量大时 Map 会一直长，属于内存泄漏；
   * 只在写入时按间隔清理，避免每次请求都全量扫描。
   */
  private maybePrune(nowMs: number): void {
    if (nowMs - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = nowMs;
    const windowStart = nowMs - 60_000;
    for (const [key, timestamps] of this.buckets) {
      const alive = timestamps.filter((ts) => ts > windowStart);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }

  /** 测试与运维可见的桶数量，用来确认清理生效。 */
  bucketCount(): number {
    return this.buckets.size;
  }

  normalize(submission: IngressSubmission): NormalizeResult {
    const now = this.now();
    const receivedAt = now.toISOString();
    const roomId = submission.roomId;
    const viewerId = submission.viewerId ?? `anon_${roomId}`;

    const limit = this.checkRateLimit(`${roomId}:${viewerId}`);
    if (!limit.allowed) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: limit.retryAfterMs };
    }

    const occurredAt = submission.occurredAt ?? receivedAt;
    const dedupeStrategy: DedupeStrategy = submission.eventId
      ? 'platform-id'
      : 'content-fingerprint';

    const dedupeKey =
      dedupeStrategy === 'platform-id'
        ? `pid:${roomId}:${submission.eventId}`
        : `fp:${roomId}:${viewerId}:${fingerprintWindow(occurredAt)}:${createHash('sha256')
            .update(stableStringify(submission.payload))
            .digest('hex')
            .slice(0, 24)}`;

    return {
      ok: true,
      event: {
        eventId: submission.eventId ?? `srv_${randomUUID()}`,
        traceId: `trace_${randomUUID()}`,
        roomId,
        viewerId,
        occurredAt,
        receivedAt,
        type: submission.type,
        payload: submission.payload,
        dedupeKey,
        dedupeStrategy,
      },
    };
  }
}

function fingerprintWindow(iso: string): number {
  const ms = Date.parse(iso);
  const base = Number.isNaN(ms) ? Date.now() : ms;
  return Math.floor(base / FINGERPRINT_WINDOW_MS);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
