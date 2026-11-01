import type { Memory, MemoryScope } from '@dafeiyu/contracts';
import type { Db } from './db.js';
import type { RetentionConfig, RetentionStats } from './retention.js';

/**
 * 保留期限清理与长期记忆的仓储扩展。
 *
 * 拆成独立文件的原因：repository.ts 已经承载会话/轮次/节目/纪念品，
 * 再塞进来会超过可读长度。两者都只依赖 Db，用 mixin 方式挂到 Repository 上。
 */
export class RetentionRepository {
  protected readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- 保留期限清理 ----
  //
  // 每条语句都带 LIMIT 上限，避免一次删除太多行长时间锁库。
  // 返回被删除的行数，便于日志与监控。

  pruneProcessedEvents(olderThan: Date, limit = 5000): number {
    const info = this.db
      .prepare(
        'DELETE FROM processed_events WHERE dedupe_key IN (SELECT dedupe_key FROM processed_events WHERE processed_at < ? LIMIT ?)',
      )
      .run(olderThan.toISOString(), limit);
    return info.changes;
  }

  pruneMessages(olderThan: Date, limit = 5000): number {
    const info = this.db
      .prepare(
        'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < ? LIMIT ?)',
      )
      .run(olderThan.toISOString(), limit);
    return info.changes;
  }

  pruneTurns(olderThan: Date, limit = 2000): number {
    // 先删 tool_calls（有外键），再删 turns，避免外键失败。
    this.db
      .prepare(
        'DELETE FROM tool_calls WHERE turn_id IN (SELECT id FROM turns WHERE started_at < ? LIMIT ?)',
      )
      .run(olderThan.toISOString(), limit);
    const info = this.db
      .prepare(
        'DELETE FROM turns WHERE id IN (SELECT id FROM turns WHERE started_at < ? LIMIT ?)',
      )
      .run(olderThan.toISOString(), limit);
    return info.changes;
  }

  pruneSouvenirs(olderThan: Date, limit = 1000): number {
    const info = this.db
      .prepare(
        'DELETE FROM souvenirs WHERE public_id IN (SELECT public_id FROM souvenirs WHERE is_public = 1 AND created_at < ? LIMIT ?)',
      )
      .run(olderThan.toISOString(), limit);
    return info.changes;
  }

  pruneExpiredMemories(now: Date, graceDays = 0, limit = 2000): number {
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
    const info = this.db
      .prepare(
        'DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?)',
      )
      .run(cutoff.toISOString(), limit);
    return info.changes;
  }

  /** 执行一次完整清理，返回各类删除数量。 */
  applyRetention(
    config: RetentionConfig,
    now: Date,
    cutoffFor: (days: number, now: Date) => Date | null,
  ): RetentionStats {
    const eventsCutoff = cutoffFor(config.processedEventsDays, now);
    const messagesCutoff = cutoffFor(config.messagesDays, now);
    const turnsCutoff = cutoffFor(config.turnsDays, now);
    const souvenirsCutoff = cutoffFor(config.souvenirsDays, now);

    return {
      processedEvents: eventsCutoff ? this.pruneProcessedEvents(eventsCutoff) : 0,
      messages: messagesCutoff ? this.pruneMessages(messagesCutoff) : 0,
      turns: turnsCutoff ? this.pruneTurns(turnsCutoff) : 0,
      souvenirs: souvenirsCutoff ? this.pruneSouvenirs(souvenirsCutoff) : 0,
      memories: this.pruneExpiredMemories(now, config.memoriesGraceDays),
    };
  }

  /** 只统计不删除，供控制台展示“有多少数据将被清理”。 */
  countRetention(
    config: RetentionConfig,
    now: Date,
    cutoffFor: (days: number, now: Date) => Date | null,
  ): RetentionStats {
    const count = (table: string, column: string, days: number): number => {
      const cutoff = cutoffFor(days, now);
      if (!cutoff) return 0;
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} < ?`)
        .get(cutoff.toISOString()) as { c: number };
      return row.c;
    };
    const expiredMemories = this.db
      .prepare(
        'SELECT COUNT(*) AS c FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?',
      )
      .get(now.toISOString()) as { c: number };
    return {
      processedEvents: count('processed_events', 'processed_at', config.processedEventsDays),
      messages: count('messages', 'created_at', config.messagesDays),
      turns: count('turns', 'started_at', config.turnsDays),
      souvenirs: count('souvenirs', 'created_at', config.souvenirsDays),
      memories: expiredMemories.c,
    };
  }

  // ---- 长期记忆 ----
  //
  // 只保存有用偏好与明确同意的信息。游戏分数/战绩等事实由业务表提供，
  // 不用模型记忆替代。

  upsertMemory(input: {
    roomId: string;
    scope: MemoryScope;
    sessionId: string | null;
    viewerId: string | null;
    key: string;
    value: unknown;
    source: string;
    confidence?: number;
    expiresAt?: string | null;
    now?: Date;
  }): Memory {
    const nowIso = (input.now ?? new Date()).toISOString();
    const existing = this.db
      .prepare(
        `SELECT id, created_at FROM memories
         WHERE room_id = ?
           AND scope = ?
           AND COALESCE(session_id, '') = COALESCE(?, '')
           AND COALESCE(viewer_id, '') = COALESCE(?, '')
           AND key = ?`,
      )
      .get(
        input.roomId,
        input.scope,
        input.sessionId,
        input.viewerId,
        input.key,
      ) as { id: string; created_at: string } | undefined;

    const id = existing?.id ?? `mem_${randomId()}`;
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 1));

    if (existing) {
      this.db
        .prepare(
          'UPDATE memories SET value_json = ?, source = ?, confidence = ?, expires_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify(input.value),
          input.source,
          confidence,
          input.expiresAt ?? null,
          nowIso,
          id,
        );
    } else {
      this.db
        .prepare(
          'INSERT INTO memories (id, room_id, scope, session_id, viewer_id, key, value_json, source, confidence, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.roomId,
          input.scope,
          input.sessionId,
          input.viewerId,
          input.key,
          JSON.stringify(input.value),
          input.source,
          confidence,
          input.expiresAt ?? null,
          nowIso,
          nowIso,
        );
    }

    return {
      id,
      roomId: input.roomId,
      scope: input.scope,
      sessionId: input.sessionId,
      viewerId: input.viewerId,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence,
      expiresAt: input.expiresAt ?? null,
      createdAt: existing?.created_at ?? nowIso,
      updatedAt: nowIso,
    };
  }

  /** 读取未过期记忆；按作用域过滤（会话级 + 观众级）。 */
  listMemories(input: {
    roomId: string;
    sessionId?: string | null;
    viewerId?: string | null;
    now?: Date;
    limit?: number;
  }): Memory[] {
    const nowIso = (input.now ?? new Date()).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, room_id, scope, session_id, viewer_id, key, value_json, source, confidence, expires_at, created_at, updated_at
         FROM memories
         WHERE room_id = ?
           AND (expires_at IS NULL OR expires_at > ?)
           AND (
             (scope = 'session' AND session_id = ?)
             OR (scope = 'viewer' AND viewer_id = ?)
           )
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.roomId,
        nowIso,
        input.sessionId ?? '',
        input.viewerId ?? '',
        Math.max(1, Math.min(100, input.limit ?? 20)),
      ) as MemoryRow[];

    return rows.map(mapMemoryRow);
  }

  /** 管理面：按房间列出全部记忆（含过期的），供控制台查看与清理。 */
  listAllMemories(roomId: string, limit = 100): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT id, room_id, scope, session_id, viewer_id, key, value_json, source, confidence, expires_at, created_at, updated_at
         FROM memories WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(roomId, Math.max(1, Math.min(200, limit))) as MemoryRow[];
    return rows.map(mapMemoryRow);
  }

  /** 删除单条记忆（观众纠正/清除）。 */
  deleteMemory(id: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 清除某个观众的全部记忆。 */
  deleteMemoriesForViewer(roomId: string, viewerId: string): number {
    const info = this.db
      .prepare('DELETE FROM memories WHERE room_id = ? AND viewer_id = ?')
      .run(roomId, viewerId);
    return info.changes;
  }
}

type MemoryRow = {
  id: string;
  room_id: string;
  scope: string;
  session_id: string | null;
  viewer_id: string | null;
  key: string;
  value_json: string;
  source: string;
  confidence: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapMemoryRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    roomId: row.room_id,
    scope: row.scope as MemoryScope,
    sessionId: row.session_id,
    viewerId: row.viewer_id,
    key: row.key,
    value: safeParse(row.value_json),
    source: row.source,
    confidence: row.confidence,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}
