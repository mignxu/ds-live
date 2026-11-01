import { describe, expect, it } from 'vitest';
import { openDb, applyMigrations, defaultMigrationsDir } from '../src/storage/db.js';
import { Repository } from '../src/storage/repository.js';

describe('数据库迁移与仓储', () => {
  it('应用迁移是幂等的', () => {
    const db = openDb({ file: ':memory:' });
    const dir = defaultMigrationsDir();
    const first = applyMigrations(db, dir);
    const second = applyMigrations(db, dir);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain('messages');
    expect(tables).toContain('tool_calls');
    expect(tables).toContain('processed_events');
    db.close();
  });

  it('同一房间复用会话，消息按 id 正序返回', () => {
    const db = openDb({ file: ':memory:' });
    const repo = new Repository(db);
    repo.ensureRoom('r1');
    const sessionId = repo.ensureSession('r1');
    expect(repo.ensureSession('r1')).toBe(sessionId);

    repo.appendMessage({ sessionId, role: 'user', text: '第一句' });
    repo.appendMessage({ sessionId, role: 'assistant', text: '第二句' });
    const recent = repo.recentMessages(sessionId, 10);
    expect(recent.map((m) => m.text)).toEqual(['第一句', '第二句']);
    db.close();
  });

  it('去重键首次返回 true，重复返回 false', () => {
    const db = openDb({ file: ':memory:' });
    const repo = new Repository(db);
    const input = {
      dedupeKey: 'pid:r1:e1',
      eventId: 'e1',
      strategy: 'platform-id' as const,
      roomId: 'r1',
    };
    expect(repo.markEventProcessed(input)).toBe(true);
    expect(repo.markEventProcessed(input)).toBe(false);
    db.close();
  });

  it('启动恢复把未结束的轮次标记为中断', () => {
    const db = openDb({ file: ':memory:' });
    const repo = new Repository(db);
    repo.ensureRoom('r1');
    const sessionId = repo.ensureSession('r1');
    repo.createTurn({ id: 't1', sessionId, roomId: 'r1', triggerEventId: null, traceId: 'tr1' });
    expect(repo.markInterruptedTurns()).toBe(1);
    const turns = repo.recentTurns(5);
    expect(turns[0]).toMatchObject({ phase: 'FAILED', errorCode: 'interrupted' });
    db.close();
  });
});
