import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Souvenir, SpeechPlan, StageEvent } from '@dafeiyu/contracts';
import { openDb, type Db } from '../src/storage/db.js';
import { Repository } from '../src/storage/repository.js';
import { StageService } from '../src/stage/stage-service.js';
import { MockSpeechService } from '../src/speech/speech-service.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createLolLookupTool } from '../src/tools/lol-lookup.js';
import { webSearchTool } from '../src/tools/web-search.js';
import { createSignatureTool } from '../src/tools/signature.js';
import { BossProgram } from '../src/programs/programs.js';
import { ProgramManager } from '../src/programs/program-manager.js';
import { SouvenirService } from '../src/souvenirs/souvenir-service.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-mgr-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Harness = {
  db: Db;
  repository: Repository;
  stage: StageService;
  manager: ProgramManager;
  souvenirs: SouvenirService;
  speech: MockSpeechService;
  events: StageEvent[];
  speeches: SpeechPlan[];
  dir: string;
};

function setup(): Harness {
  const dir = tempDir();
  const db = openDb({ file: ':memory:' });
  const repository = new Repository(db);
  repository.ensureRoom('room-main');

  const stage = new StageService({
    roomId: 'room-main',
    characterName: '大肥鱼',
    program: 'chat',
  });
  const events: StageEvent[] = [];
  const speeches: SpeechPlan[] = [];
  stage.subscribe((event) => {
    events.push(event);
    if (event.type === 'speech.ready') speeches.push(event.speech);
  });

  const speech = new MockSpeechService({
    outputDir: join(dir, 'tts'),
    publicPrefix: '/media/tts',
  });

  const registry = new ToolRegistry();
  registry.register(createLolLookupTool({ adapter: 'mock' }));
  registry.register(webSearchTool);
  registry.register(
    createSignatureTool({
      repository,
      outputDir: join(dir, 'souvenirs'),
      publicPrefix: '/media/souvenirs',
      roomId: 'room-main',
    }),
  );
  // 节目执行器允许写工具；模型执行器（runtime 里）仍只有只读。
  const tools = new ToolExecutor({
    registry,
    allowedTools: ['lol.lookup', 'web.search', 'signature.create'],
    defaultTimeoutMs: 2000,
  });

  const manager = new ProgramManager({
    roomId: 'room-main',
    repository,
    stage,
    speech,
    tools,
    boss: new BossProgram({
      bossName: '测试Boss',
      bossMaxHp: 100,
      partyMaxHp: 100,
      windowMs: 10_000,
      autoAdvanceMs: 0,
    }),
  });

  const souvenirs = new SouvenirService({
    repository,
    storageDir: join(dir, 'souvenirs'),
    roomId: 'room-main',
  });

  return { db, repository, stage, manager, souvenirs, speech, events, speeches, dir };
}

describe('节目协调器：LOL', () => {
  it('查战绩产生带 mock 标记的卡片与台词', async () => {
    const h = setup();
    const handled = await h.manager.handleCommand({
      kind: 'lol',
      query: 'Faker#KR1',
      viewerId: 'v1',
      viewerName: '小鱼干',
    });
    expect(handled).toBe(true);

    const speech = h.speeches.at(-1);
    expect(speech?.text).toContain('Faker');
    expect(speech?.text).toContain('mock');
    const card = speech?.effects.find((effect) => effect.kind === 'card');
    expect(card?.isMock).toBe(true);
    // 有 mock TTS 时应带音频
    expect(speech?.audioUrl).toContain('/media/tts/');
    expect(speech?.audioIsMock).toBe(true);
    expect(speech?.timings.length).toBeGreaterThan(0);
    h.db.close();
  });

  it('查不到时不编造战绩', async () => {
    const h = setup();
    await h.manager.handleCommand({
      kind: 'lol',
      query: 'zzz#999',
      viewerId: 'v1',
      viewerName: null,
    });
    const speech = h.speeches.at(-1);
    expect(speech?.text).toContain('没查到');
    expect(speech?.text).not.toMatch(/挑战者|白金/);
    h.db.close();
  });
});

describe('节目协调器：签名', () => {
  it('生成签名并写入纪念品，可从公开接口读回', async () => {
    const h = setup();
    await h.manager.handleCommand({
      kind: 'signature',
      text: '大肥鱼最帅',
      viewerId: 'v1',
      viewerName: '小鱼干',
    });

    const speech = h.speeches.at(-1);
    expect(speech?.text).toContain('签好了');
    const effect = speech?.effects.find((e) => e.kind === 'signature');
    expect(effect?.imageUrl).toContain('/media/souvenirs/');

    const list = h.souvenirs.list(10);
    expect(list.total).toBe(1);
    const item = list.items[0] as Souvenir;
    expect(item.kind).toBe('signature');
    expect(item.isMock).toBe(true);
    expect(item.title).toContain('大肥鱼最帅');

    const fetched = h.souvenirs.get(item.publicId);
    expect(fetched?.publicId).toBe(item.publicId);
    h.db.close();
  });

  it('非法 publicId 不返回数据', () => {
    const h = setup();
    expect(h.souvenirs.get('../etc/passwd')).toBeNull();
    expect(h.souvenirs.get('')).toBeNull();
    h.db.close();
  });
});

describe('节目协调器：Boss', () => {
  it('开回合 → 多观众提交 → 结算 → 战报纪念品', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'host', viewerName: '主播' });
    expect(h.manager.bossState().phase).toBe('open');
    expect(h.stage.snapshot().program).toBe('boss');

    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: '甲',
    });
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'charge',
      viewerId: 'v2',
      viewerName: '乙',
    });
    // 同一观众重复提交被拒绝
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'heal',
      viewerId: 'v1',
      viewerName: '甲',
    });
    expect(h.manager.bossState().submitted).toBe(2);
    expect(h.speeches.at(-1)?.text).toContain('已经出过手');

    await h.manager.handleCommand({ kind: 'boss.settle', viewerId: 'host', viewerName: '主播' });
    const state = h.manager.bossState();
    expect(state.phase).toBe('resolved');
    expect(state.bossHp).toBeLessThan(100);

    const reports = h.souvenirs.list(10).items.filter((item) => item.kind === 'game-report');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain('Boss');
    h.db.close();
  });

  it('没开回合时动作被拒绝，不会静默计分', async () => {
    const h = setup();
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: null,
    });
    expect(h.speeches.at(-1)?.text).toContain('开Boss');
    expect(h.manager.bossState().submitted).toBe(0);
    h.db.close();
  });

  it('重复结算不重复扣血、不重复归档', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'host', viewerName: null });
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: null,
    });
    await h.manager.handleCommand({ kind: 'boss.settle', viewerId: 'host', viewerName: null });
    const hpAfterFirst = h.manager.bossState().bossHp;
    await h.manager.handleCommand({ kind: 'boss.settle', viewerId: 'host', viewerName: null });
    expect(h.manager.bossState().bossHp).toBe(hpAfterFirst);
    expect(h.souvenirs.list(10).items.filter((i) => i.kind === 'game-report')).toHaveLength(1);
    h.db.close();
  });
});

describe('TTS 失败时降级为字幕', () => {
  it('合成抛错仍然发布纯字幕语音', async () => {
    const h = setup();
    const failing = {
      available: true,
      isMock: true,
      voice: 'broken',
      unavailableReason: null,
      async synthesize() {
        throw new Error('上游 TTS 挂了');
      },
    };
    const manager = new ProgramManager({
      roomId: 'room-main',
      repository: h.repository,
      stage: h.stage,
      speech: failing,
      tools: new ToolExecutor({
        registry: new ToolRegistry(),
        allowedTools: [],
        defaultTimeoutMs: 100,
      }),
    });
    await manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null });
    const speech = h.speeches.at(-1);
    expect(speech?.audioUrl).toBeNull();
    expect(speech?.text.length).toBeGreaterThan(0);
    h.db.close();
  });
});

describe('纪念品 publicId 冲突不覆盖已有作品', () => {
  it('重复 publicId 写入被拒绝，原作品保留', () => {
    const h = setup();
    const first = h.repository.insertSouvenir({
      souvenir: {
        publicId: 'duplicate12345678',
        kind: 'signature',
        title: '第一件',
        text: '原始内容',
        imageUrl: null,
        isMock: true,
        program: 'signature',
        createdAt: new Date().toISOString(),
        data: null,
      },
      imagePath: null,
      roomId: 'room-main',
    });
    expect(first).toBe(true);

    const second = h.repository.insertSouvenir({
      souvenir: {
        publicId: 'duplicate12345678',
        kind: 'signature',
        title: '第二件',
        text: '覆盖尝试',
        imageUrl: null,
        isMock: true,
        program: 'signature',
        createdAt: new Date().toISOString(),
        data: null,
      },
      imagePath: null,
      roomId: 'room-main',
    });
    expect(second).toBe(false);
    expect(h.souvenirs.get('duplicate12345678')?.title).toBe('第一件');
    h.db.close();
  });
});

describe('窗口到期自动结算（不再依赖下一个观众）', () => {
  it('tick 会在窗口到期后结算，并产生战报与播报', async () => {
    let nowMs = 1_000_000;
    const dir = tempDir();
    const db = openDb({ file: ':memory:' });
    const repository = new Repository(db);
    repository.ensureRoom('room-main');
    const stage = new StageService({ roomId: 'room-main', characterName: '大肥鱼', program: 'chat' });
    const speeches: SpeechPlan[] = [];
    stage.subscribe((event) => {
      if (event.type === 'speech.ready') speeches.push(event.speech);
    });
    const registry = new ToolRegistry();
    const manager = new ProgramManager({
      roomId: 'room-main',
      repository,
      stage,
      speech: new MockSpeechService({ outputDir: join(dir, 'tts') }),
      tools: new ToolExecutor({ registry, allowedTools: [], defaultTimeoutMs: 200 }),
      boss: new BossProgram(
        { bossName: 'B', bossMaxHp: 100, partyMaxHp: 100, windowMs: 1000, autoAdvanceMs: 0 },
        () => nowMs,
      ),
      now: () => new Date(nowMs),
    });

    await manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: '主播' });
    await manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: '甲',
    });
    expect(manager.bossState().phase).toBe('open');

    nowMs += 1500;
    await manager.tick();
    // applyBossSettlement 是异步的，等一拍
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.bossState().phase).toBe('resolved');
    expect(speeches.at(-1)?.text).toContain('Boss');
    const reports = manager['options'].repository
      .listPublicSouvenirs(10)
      .items.filter((item) => item.kind === 'game-report');
    expect(reports).toHaveLength(1);

    // DB 中的运行记录也必须是 resolved，而不是永远 open
    const run = db
      .prepare('SELECT status FROM program_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { status: string };
    expect(run.status).toBe('resolved');
    db.close();
  });

  it('窗口未到期时 tick 不结算', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null });
    await h.manager.tick();
    expect(h.manager.bossState().phase).toBe('open');
    h.db.close();
  });
});

describe('动作校验先于写库', () => {
  it('被拒绝的重复提交不会写入 game_actions', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null });
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: '甲',
    });
    // 第二次被内存状态拒绝
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'heal',
      viewerId: 'v1',
      viewerName: '甲',
    });
    const roundId = h.manager.bossState().roundId as string;
    expect(h.repository.countGameActions(roundId)).toBe(1);
    h.db.close();
  });

  it('没开回合时的动作不会留下 game_actions 记录', async () => {
    const h = setup();
    await h.manager.handleCommand({
      kind: 'boss.act',
      action: 'attack',
      viewerId: 'v1',
      viewerName: null,
    });
    const rows = h.db.prepare('SELECT COUNT(*) AS c FROM game_actions').get() as { c: number };
    expect(rows.c).toBe(0);
    h.db.close();
  });

  it('写库失败时回滚内存提交，内存与 DB 保持一致', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null });

    // 让写库抛错，模拟磁盘/约束故障
    const original = h.repository.recordGameAction.bind(h.repository);
    h.repository.recordGameAction = () => {
      throw new Error('disk full');
    };
    try {
      await h.manager.handleCommand({
        kind: 'boss.act',
        action: 'attack',
        viewerId: 'v1',
        viewerName: '甲',
      });
      // 内存状态必须回滚，不能出现“界面显示已出手但 DB 没有”
      expect(h.manager.bossState().submitted).toBe(0);
    } finally {
      h.repository.recordGameAction = original;
    }
    h.db.close();
  });
});

describe('重置 Boss 会清理 DB 状态', () => {
  it('boss_reset 把进行中的运行记录标为 cancelled', async () => {
    const h = setup();
    await h.manager.handleCommand({ kind: 'boss.open', viewerId: 'h', viewerName: null });
    h.manager.resetBoss();
    const run = h.db
      .prepare('SELECT status FROM program_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { status: string };
    expect(run.status).toBe('cancelled');
    expect(h.manager.bossState().phase).toBe('idle');
    h.db.close();
  });
});

describe('公开纪念品不含观众昵称', () => {
  it('签名作品正文不写昵称', async () => {
    const h = setup();
    await h.manager.handleCommand({
      kind: 'signature',
      text: '大肥鱼',
      viewerId: 'v1',
      viewerName: '某个观众的昵称',
    });
    const item = h.souvenirs.list(10).items[0];
    expect(item?.text).not.toContain('某个观众的昵称');
    expect(item?.text).toContain('签名');
    h.db.close();
  });
});

describe('签名写入失败的一致性', () => {
  it('写库失败时删除已生成的 SVG，不留孤儿文件', async () => {
    const h = setup();
    const original = h.repository.insertSouvenir.bind(h.repository);
    h.repository.insertSouvenir = () => {
      throw new Error('db down');
    };
    try {
      await h.manager.handleCommand({
        kind: 'signature',
        text: '测试',
        viewerId: 'v1',
        viewerName: null,
      });
      // 写库失败发生在落盘之前：目录根本不该被创建，更不会有残留 SVG
      const { existsSync, readdirSync } = await import('node:fs');
      const dir = join(h.dir, 'souvenirs');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.svg')) : [];
      expect(files).toHaveLength(0);
      // 舞台给出明确失败台词
      expect(h.speeches.at(-1)?.text).toContain('没生成成功');
    } finally {
      h.repository.insertSouvenir = original;
    }
    h.db.close();
  });

  it('写文件失败时回滚数据库记录，不留“有元数据没图片”', async () => {
    const h = setup();
    const originalCreate = h.repository.insertSouvenir.bind(h.repository);
    // 让写库成功但写文件失败：用不可写目录模拟
    const badDir = join(h.dir, 'souvenirs');
    const { chmodSync } = await import('node:fs');
    try {
      // 用只读目录触发写失败（Windows 上 chmod 语义有限，改为直接删除目录后禁止创建）
      const { rmSync } = await import('node:fs');
      rmSync(badDir, { recursive: true, force: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(badDir, 'not a directory');

      await h.manager.handleCommand({
        kind: 'signature',
        text: '测试',
        viewerId: 'v1',
        viewerName: null,
      });
      // 数据库里不应留下无法访问的作品
      expect(h.repository.listPublicSouvenirs(10).total).toBe(0);
      chmodSync(badDir, 0o644);
    } finally {
      h.repository.insertSouvenir = originalCreate;
    }
    h.db.close();
  });
});
