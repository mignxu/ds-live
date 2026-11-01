import type { Souvenir, SouvenirKind, ToolResult } from '@dafeiyu/contracts';
import type { Db } from './db.js';
import { RetentionRepository } from './retention-repository.js';

export type StoredMessage = {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  viewerId: string | null;
  text: string;
  createdAt: string;
  turnId: string | null;
};

export type TurnRecord = {
  id: string;
  sessionId: string;
  roomId: string;
  triggerEventId: string | null;
  phase: string;
  modelCalls: number;
  toolCalls: number;
  finishReason: string | null;
  errorCode: string | null;
  degraded: boolean;
  startedAt: string;
  endedAt: string | null;
  traceId: string;
};

/**
 * 单进程 SQLite 仓储。写入短事务、串行，不承载长耗时查询。
 * 这里不做业务校验，只做数据映射。
 */
export class Repository extends RetentionRepository {
  constructor(db: Db) {
    super(db);
  }

  ensureRoom(roomId: string, now = new Date()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO rooms (id, created_at) VALUES (?, ?)')
      .run(roomId, now.toISOString());
  }

  /** 同一房间复用最近一个会话，避免每轮新建。 */
  ensureSession(roomId: string, now = new Date()): string {
    const iso = now.toISOString();
    // 房间必须先存在，避免调用方顺序不同导致外键失败。
    this.ensureRoom(roomId, now);
    const existing = this.db
      .prepare('SELECT id FROM sessions WHERE room_id = ? ORDER BY last_active_at DESC LIMIT 1')
      .get(roomId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = `sess_${roomId}_${now.getTime().toString(36)}`;
    this.db
      .prepare('INSERT INTO sessions (id, room_id, started_at, last_active_at) VALUES (?, ?, ?, ?)')
      .run(id, roomId, iso, iso);
    return id;
  }

  touchSession(sessionId: string, now = new Date()): void {
    this.db
      .prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')
      .run(now.toISOString(), sessionId);
  }

  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    viewerId?: string | null;
    turnId?: string | null;
    now?: Date;
  }): void {
    this.db
      .prepare(
        'INSERT INTO messages (session_id, role, viewer_id, text, created_at, turn_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.sessionId,
        input.role,
        input.viewerId ?? null,
        input.text,
        (input.now ?? new Date()).toISOString(),
        input.turnId ?? null,
      );
  }

  /** 最近 N 条消息，按时间正序返回，供上下文窗口使用。 */
  recentMessages(sessionId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, role, viewer_id, text, created_at, turn_id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(sessionId, limit) as Array<{
      id: number;
      session_id: string;
      role: 'user' | 'assistant';
      viewer_id: string | null;
      text: string;
      created_at: string;
      turn_id: string | null;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      viewerId: row.viewer_id,
      text: row.text,
      createdAt: row.created_at,
      turnId: row.turn_id,
    }));
  }

  createTurn(input: {
    id: string;
    sessionId: string;
    roomId: string;
    triggerEventId: string | null;
    traceId: string;
    now?: Date;
  }): void {
    this.db
      .prepare(
        'INSERT INTO turns (id, session_id, room_id, trigger_event_id, phase, started_at, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.sessionId,
        input.roomId,
        input.triggerEventId,
        'PLANNING',
        (input.now ?? new Date()).toISOString(),
        input.traceId,
      );
  }

  updateTurn(
    id: string,
    patch: {
      phase?: string;
      modelCalls?: number;
      toolCalls?: number;
      finishReason?: string | null;
      errorCode?: string | null;
      degraded?: boolean;
      endedAt?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      phase: 'phase',
      modelCalls: 'model_calls',
      toolCalls: 'tool_calls',
      finishReason: 'finish_reason',
      errorCode: 'error_code',
      degraded: 'degraded',
      endedAt: 'ended_at',
    };
    for (const [key, column] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        const value = (patch as Record<string, unknown>)[key];
        values.push(typeof value === 'boolean' ? Number(value) : value);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  recordToolCall(input: {
    id: string;
    turnId: string;
    request: unknown;
    result: ToolResult;
    now?: Date;
  }): void {
    this.db
      .prepare(
        'INSERT INTO tool_calls (id, turn_id, name, status, source, is_mock, error_code, retryable, duration_ms, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.turnId,
        input.result.name,
        input.result.status,
        input.result.source,
        Number(input.result.isMock),
        input.result.errorCode,
        Number(input.result.retryable),
        input.result.durationMs,
        JSON.stringify(input.request),
        JSON.stringify(input.result),
        (input.now ?? new Date()).toISOString(),
      );
  }

  recentTurns(limit: number): TurnRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, room_id, trigger_event_id, phase, model_calls, tool_calls, finish_reason, error_code, degraded, started_at, ended_at, trace_id FROM turns ORDER BY started_at DESC LIMIT ?',
      )
      .all(limit) as Array<{
      id: string;
      session_id: string;
      room_id: string;
      trigger_event_id: string | null;
      phase: string;
      model_calls: number;
      tool_calls: number;
      finish_reason: string | null;
      error_code: string | null;
      degraded: number;
      started_at: string;
      ended_at: string | null;
      trace_id: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      roomId: row.room_id,
      triggerEventId: row.trigger_event_id,
      phase: row.phase,
      modelCalls: row.model_calls,
      toolCalls: row.tool_calls,
      finishReason: row.finish_reason,
      errorCode: row.error_code,
      degraded: row.degraded === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      traceId: row.trace_id,
    }));
  }

  /** 返回 true 表示首次出现，false 表示重复事件。 */
  markEventProcessed(input: {
    dedupeKey: string;
    eventId: string;
    strategy: 'platform-id' | 'content-fingerprint';
    roomId: string;
    now?: Date;
  }): boolean {
    const info = this.db
      .prepare(
        'INSERT OR IGNORE INTO processed_events (dedupe_key, event_id, strategy, room_id, processed_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        input.dedupeKey,
        input.eventId,
        input.strategy,
        input.roomId,
        (input.now ?? new Date()).toISOString(),
      );
    return info.changes > 0;
  }

  /** 入队失败时回滚去重记录，避免观众重试被误判为重复事件。 */
  unmarkEventProcessed(dedupeKey: string): void {
    this.db.prepare('DELETE FROM processed_events WHERE dedupe_key = ?').run(dedupeKey);
  }

  // ---- 节目运行记录 ----

  /** 插入节目运行记录。返回 false 表示 ID 已存在（主键冲突），调用方应视为异常。 */
  createProgramRun(input: {
    id: string;
    program: string;
    roomId: string;
    now?: Date;
  }): boolean {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO program_runs (id, program, room_id, status, round, started_at) VALUES (?, ?, ?, 'open', 0, ?)",
      )
      .run(input.id, input.program, input.roomId, (input.now ?? new Date()).toISOString());
    return info.changes > 0;
  }

  updateProgramRun(
    id: string,
    patch: {
      status?: string;
      round?: number;
      state?: unknown;
      result?: unknown;
      endedAt?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.round !== undefined) {
      sets.push('round = ?');
      values.push(patch.round);
    }
    if (patch.state !== undefined) {
      sets.push('state_json = ?');
      values.push(JSON.stringify(patch.state));
    }
    if (patch.result !== undefined) {
      sets.push('result_json = ?');
      values.push(JSON.stringify(patch.result));
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?');
      values.push(patch.endedAt);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE program_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 记录观众动作。返回 false 表示该观众本回合已提交过（数据库唯一约束保证）。
   * 这是“每观众一次有效动作”的最终防线，不依赖内存状态。
   */
  recordGameAction(input: {
    roundId: string;
    viewerId: string;
    action: string;
    now?: Date;
  }): boolean {
    const info = this.db
      .prepare(
        'INSERT OR IGNORE INTO game_actions (round_id, viewer_id, action, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        input.roundId,
        input.viewerId,
        input.action,
        (input.now ?? new Date()).toISOString(),
      );
    return info.changes > 0;
  }

  countGameActions(roundId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM game_actions WHERE round_id = ?')
      .get(roundId) as { c: number };
    return row.c;
  }

  /** 启动恢复：中断的节目运行标记为 cancelled，不重复结算。 */
  markInterruptedProgramRuns(now = new Date()): number {
    const info = this.db
      .prepare(
        "UPDATE program_runs SET status = 'cancelled', ended_at = ? WHERE status IN ('open', 'settling')",
      )
      .run(now.toISOString());
    return info.changes;
  }

  // ---- 纪念品 ----

  /**
   * 写入纪念品。返回 false 表示 publicId 已存在。
   * 用 INSERT OR IGNORE 而不是 OR REPLACE：publicId 随机，重复说明异常，
   * 不应静默覆盖已有作品（可能覆盖别人的签名）。
   */
  insertSouvenir(input: {
    souvenir: Souvenir;
    imagePath: string | null;
    roomId: string;
    isPublic?: boolean;
  }): boolean {
    const { souvenir } = input;
    const info = this.db
      .prepare(
        'INSERT OR IGNORE INTO souvenirs (public_id, kind, title, text, image_path, data_json, is_mock, program, room_id, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        souvenir.publicId,
        souvenir.kind,
        souvenir.title,
        souvenir.text,
        input.imagePath,
        souvenir.data === null ? null : JSON.stringify(souvenir.data),
        Number(souvenir.isMock),
        souvenir.program,
        input.roomId,
        Number(input.isPublic ?? true),
        souvenir.createdAt,
      );
    return info.changes > 0;
  }

  /** 回滚：删除一条纪念品（仅用于写入失败时清理）。 */
  deleteSouvenir(publicId: string): void {
    this.db.prepare('DELETE FROM souvenirs WHERE public_id = ?').run(publicId);
  }

  /** 写入后补充结构化数据（例如笔迹统计）。 */
  updateSouvenirData(publicId: string, data: unknown): void {
    this.db
      .prepare('UPDATE souvenirs SET data_json = ? WHERE public_id = ?')
      .run(JSON.stringify(data), publicId);
  }

  findPublicSouvenir(publicId: string): Souvenir | null {
    const row = this.db
      .prepare(
        'SELECT public_id, kind, title, text, image_path, data_json, is_mock, program, created_at FROM souvenirs WHERE public_id = ? AND is_public = 1',
      )
      .get(publicId) as
      | {
          public_id: string;
          kind: string;
          title: string;
          text: string;
          image_path: string | null;
          data_json: string | null;
          is_mock: number;
          program: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      publicId: row.public_id,
      kind: row.kind as SouvenirKind,
      title: row.title,
      text: row.text,
      imageUrl: row.image_path,
      isMock: row.is_mock === 1,
      program: row.program,
      createdAt: row.created_at,
      data: row.data_json === null ? null : (JSON.parse(row.data_json) as unknown),
    };
  }

  listPublicSouvenirs(limit: number, offset = 0): { items: Souvenir[]; total: number } {
    const rows = this.db
      .prepare(
        'SELECT public_id, kind, title, text, image_path, data_json, is_mock, program, created_at FROM souvenirs WHERE is_public = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as Array<{
      public_id: string;
      kind: string;
      title: string;
      text: string;
      image_path: string | null;
      data_json: string | null;
      is_mock: number;
      program: string;
      created_at: string;
    }>;
    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM souvenirs WHERE is_public = 1')
      .get() as { c: number };
    return {
      items: rows.map((row) => ({
        publicId: row.public_id,
        kind: row.kind as SouvenirKind,
        title: row.title,
        text: row.text,
        imageUrl: row.image_path,
        isMock: row.is_mock === 1,
        program: row.program,
        createdAt: row.created_at,
        data: row.data_json === null ? null : (JSON.parse(row.data_json) as unknown),
      })),
      total: totalRow.c,
    };
  }

  /** 启动恢复：把中断的进行中任务标记为中断，不重播已完成内容。 */
  markInterruptedTurns(now = new Date()): number {
    const info = this.db
      .prepare(
        "UPDATE turns SET phase = 'FAILED', error_code = 'interrupted', ended_at = ? WHERE ended_at IS NULL",
      )
      .run(now.toISOString());
    return info.changes;
  }
}
