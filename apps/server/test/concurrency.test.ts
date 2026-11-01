import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage/db.js';
import { Repository } from '../src/storage/repository.js';
import { BossProgram } from '../src/programs/programs.js';
import { StageService } from '../src/stage/stage-service.js';
import { MockSpeechService } from '../src/speech/speech-service.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ProgramManager } from '../src/programs/program-manager.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-load-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = tempDir();
  const db = openDb({ file: ':memory:' });
  const repository = new Repository(db);
  repository.ensureRoom('room-main');
  const stage = new StageService({ roomId: 'room-main', characterName: '大肥鱼', program: 'chat' });
  const manager = new ProgramManager({
    roomId: 'room-main',
    repository,
    stage,
    speech: new MockSpeechService({ outputDir: join(dir, 'tts') }),
    tools: new ToolExecutor({
      registry: new ToolRegistry(),
      allowedTools: [],
      defaultTimeoutMs: 200,
    }),
    boss: new BossProgram(
      { bossName: 'B', bossMaxHp: 10_000, partyMaxHp: 10_000, windowMs: 60_000, autoAdvanceMs: 0 },
      () => Date.now(),
    ),
  });
  return { db, repository, manager, stage };
}

describe('Boss 并发提交压力', () => {
  it('200 个观众并发提交：DB 与内存统计一致', async () => {
    const { db, repository, manager } = setup();
    await manager.handleCommand({ kind: 'boss.open', viewerId: 'host', viewerName: '主播' });

    const viewers = Array.from({ length: 200 }, (_, i) => `viewer-${i}`);
    // 注意：ProgramManager 内部是串行 await，这里模拟同时发起
    await Promise.all(
      viewers.map((viewerId) =>
        manager.handleCommand({
          kind: 'boss.act',
          action: viewerId.endsWith('0') ? 'heal' : 'attack',
          viewerId,
          viewerName: viewerId,
        }),
      ),
    );

    const roundId = manager.bossState().roundId as string;
    const dbCount = repository.countGameActions(roundId);
    const memCount = manager.bossState().submitted;
    expect(memCount).toBe(200);
    expect(dbCount).toBe(200);
    db.close();
  });

  it('同一观众并发提交 50 次只计一次', async () => {
    const { db, repository, manager } = setup();
    await manager.handleCommand({ kind: 'boss.open', viewerId: 'host', viewerName: '主播' });

    await Promise.all(
      Array.from({ length: 50 }, () =>
        manager.handleCommand({
          kind: 'boss.act',
          action: 'attack',
          viewerId: 'same-viewer',
          viewerName: '甲',
        }),
      ),
    );

    const roundId = manager.bossState().roundId as string;
    expect(manager.bossState().submitted).toBe(1);
    expect(repository.countGameActions(roundId)).toBe(1);
    db.close();
  });

  it('并发结算只结算一次，战报只有一份', async () => {
    const { db, repository, manager } = setup();
    await manager.handleCommand({ kind: 'boss.open', viewerId: 'host', viewerName: null });
    for (let i = 0; i < 20; i += 1) {
      await manager.handleCommand({
        kind: 'boss.act',
        action: 'attack',
        viewerId: `v${i}`,
        viewerName: null,
      });
    }

    await Promise.all(
      Array.from({ length: 10 }, () =>
        manager.handleCommand({ kind: 'boss.settle', viewerId: 'host', viewerName: null }),
      ),
    );
    // applyBossSettlement 是异步的，等一拍
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reports = repository.listPublicSouvenirs(20).items.filter((i) => i.kind === 'game-report');
    expect(reports).toHaveLength(1);
    expect(manager.bossState().phase).toBe('resolved');
    db.close();
  });
});

describe('多房间并发', () => {
  it('5 个房间各 40 次提交，互不串台', async () => {
    const dir = tempDir();
    const db = openDb({ file: ':memory:' });
    const repository = new Repository(db);
    const managers: ProgramManager[] = [];
    const stage = new StageService({ roomId: 'shared', characterName: '大肥鱼', program: 'chat' });

    for (let room = 0; room < 5; room += 1) {
      const roomId = `room-${room}`;
      repository.ensureRoom(roomId);
      managers.push(
        new ProgramManager({
          roomId,
          repository,
          stage,
          speech: new MockSpeechService({ outputDir: join(dir, `tts-${room}`) }),
          tools: new ToolExecutor({
            registry: new ToolRegistry(),
            allowedTools: [],
            defaultTimeoutMs: 200,
          }),
          boss: new BossProgram(
            { bossName: 'B', bossMaxHp: 10_000, partyMaxHp: 10_000, windowMs: 60_000, autoAdvanceMs: 0 },
            () => Date.now(),
          ),
        }),
      );
    }

    await Promise.all(managers.map((m) => m.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null })));

    await Promise.all(
      managers.flatMap((manager, room) =>
        Array.from({ length: 40 }, (_, i) =>
          manager.handleCommand({
            kind: 'boss.act',
            action: 'attack',
            viewerId: `room${room}-viewer${i}`,
            viewerName: null,
          }),
        ),
      ),
    );

    for (const manager of managers) {
      expect(manager.bossState().submitted).toBe(40);
    }
    db.close();
  });
});
