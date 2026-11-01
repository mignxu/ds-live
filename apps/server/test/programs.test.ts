import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { Repository } from '../src/storage/repository.js';
import { BossProgram, createSignatureArtwork, readSignatureSvg } from '../src/programs/programs.js';
import { parseCommand } from '../src/programs/program-manager.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-prog-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Boss 节目状态机', () => {
  it('未开回合时提交被拒绝', () => {
    const boss = new BossProgram();
    const result = boss.submit({ viewerId: 'v1', viewerName: null, action: 'attack' });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('round_not_open');
  });

  it('开回合后同一观众只能提交一次', () => {
    const boss = new BossProgram();
    boss.openRound();
    expect(boss.submit({ viewerId: 'v1', viewerName: '甲', action: 'attack' }).accepted).toBe(true);
    const second = boss.submit({ viewerId: 'v1', viewerName: '甲', action: 'attack' });
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('already_submitted');
    expect(boss.snapshot().submitted).toBe(1);
  });

  it('不同观众可以分别提交', () => {
    const boss = new BossProgram();
    boss.openRound();
    boss.submit({ viewerId: 'v1', viewerName: null, action: 'attack' });
    boss.submit({ viewerId: 'v2', viewerName: null, action: 'charge' });
    expect(boss.snapshot().submitted).toBe(2);
  });

  it('结算按确定性规则扣血，重复结算不重复扣', () => {
    const boss = new BossProgram({
      bossName: '测试Boss',
      bossMaxHp: 300,
      partyMaxHp: 120,
      windowMs: 10_000,
      autoAdvanceMs: 0,
    });
    boss.openRound();
    boss.submit({ viewerId: 'v1', viewerName: null, action: 'attack' });
    boss.submit({ viewerId: 'v2', viewerName: null, action: 'attack' });
    boss.submit({ viewerId: 'v3', viewerName: null, action: 'heal' });

    const result = boss.settle();
    expect(result?.damage).toBe(12); // 2 × 6
    expect(result?.healing).toBe(5);
    expect(result?.bossHp ?? boss.snapshot().bossHp).toBe(288);
    expect(boss.snapshot().phase).toBe('resolved');

    const again = boss.settle();
    expect(again?.damage).toBe(12);
    expect(boss.snapshot().bossHp).toBe(288);
  });

  it('窗口到点后提交被拒绝；结算由定时器/tick 负责，迟到输入不进入回合', () => {
    let nowMs = 1_000_000;
    const boss = new BossProgram(
      { bossName: 'B', bossMaxHp: 100, partyMaxHp: 100, windowMs: 1000, autoAdvanceMs: 0 },
      () => nowMs,
    );
    boss.openRound();
    boss.submit({ viewerId: 'v1', viewerName: null, action: 'attack' });

    nowMs += 1500;
    const late = boss.submit({ viewerId: 'v2', viewerName: null, action: 'attack' });
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('window_closed');
    // submit 不再隐式结算，避免出现“有副作用”和“无副作用”两条结算路径
    expect(boss.snapshot().phase).toBe('open');
    expect(boss.isWindowExpired()).toBe(true);

    // 显式结算（生产由 1s 定时器调用 tick）
    const result = boss.settle();
    expect(boss.snapshot().phase).toBe('resolved');
    // 迟到者的动作没有被计入
    expect(result?.actions.attack).toBe(1);
  });

  it('settle 会通知结算监听（无论手动还是窗口到期）', () => {
    let nowMs = 0;
    const boss = new BossProgram(
      { bossName: 'B', bossMaxHp: 100, partyMaxHp: 100, windowMs: 1000, autoAdvanceMs: 0 },
      () => nowMs,
    );
    const settled: string[] = [];
    boss.onSettled((result) => settled.push(result.roundId));
    boss.openRound();
    nowMs += 1500;
    boss.settle();
    expect(settled).toHaveLength(1);
    // 重复结算不再通知
    boss.settle();
    expect(settled).toHaveLength(1);
  });

  it('Boss 被打死后开新回合会重置血量', () => {
    const boss = new BossProgram({
      bossName: 'B',
      bossMaxHp: 10,
      partyMaxHp: 100,
      windowMs: 10_000,
      autoAdvanceMs: 0,
    });
    boss.openRound();
    boss.submit({ viewerId: 'v1', viewerName: null, action: 'charge' }); // 10 伤
    const result = boss.settle();
    expect(result?.bossDefeated).toBe(true);
    expect(boss.snapshot().bossHp).toBe(0);

    boss.openRound();
    expect(boss.snapshot().bossHp).toBe(10);
    expect(boss.snapshot().round).toBe(2);
  });

  it('窗口剩余时间随当前时刻递减', () => {
    let nowMs = 0;
    const boss = new BossProgram(
      { bossName: 'B', bossMaxHp: 100, partyMaxHp: 100, windowMs: 5000, autoAdvanceMs: 0 },
      () => nowMs,
    );
    boss.openRound();
    expect(boss.snapshot().windowRemainingMs).toBe(5000);
    nowMs += 2000;
    expect(boss.snapshot().windowRemainingMs).toBe(3000);
  });
});

describe('数据库是“每观众一次”的最终防线', () => {
  it('同一回合同一观众第二次写库被拒绝', () => {
    const db = openDb({ file: ':memory:' });
    const repo = new Repository(db);
    repo.ensureRoom('r1');
    repo.createProgramRun({ id: 'run-1', program: 'boss', roomId: 'r1' });

    expect(repo.recordGameAction({ roundId: 'run-1', viewerId: 'v1', action: 'attack' })).toBe(true);
    expect(repo.recordGameAction({ roundId: 'run-1', viewerId: 'v1', action: 'heal' })).toBe(false);
    expect(repo.countGameActions('run-1')).toBe(1);
    db.close();
  });

  it('启动恢复把进行中的节目运行标记为 cancelled', () => {
    const db = openDb({ file: ':memory:' });
    const repo = new Repository(db);
    repo.ensureRoom('r1');
    repo.createProgramRun({ id: 'run-2', program: 'boss', roomId: 'r1' });
    expect(repo.markInterruptedProgramRuns()).toBe(1);
    db.close();
  });
});

describe('签名笔迹生成', () => {
  it('生成 SVG 文件且可复现（同文本同路径）', () => {
    const dir = tempDir();
    const first = createSignatureArtwork({ publicId: 'abc12345', text: '大肥鱼', outputDir: dir });
    const second = createSignatureArtwork({ publicId: 'abc12345', text: '大肥鱼', outputDir: dir });

    expect(first.imageUrl).toBe('/media/souvenirs/sig-abc12345.svg');
    expect(first.strokes).toEqual(second.strokes);
    expect(existsSync(join(dir, 'sig-abc12345.svg'))).toBe(true);

    const svg = readFileSync(join(dir, 'sig-abc12345.svg'), 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('大肥鱼 · mock 笔迹');
  });

  it('不同文本产生不同笔迹', () => {
    const dir = tempDir();
    const a = createSignatureArtwork({ publicId: 'p1', text: '甲', outputDir: dir });
    const b = createSignatureArtwork({ publicId: 'p2', text: '乙', outputDir: dir });
    expect(a.strokes).not.toEqual(b.strokes);
  });

  it('超长文本被截断，不生成超宽画布', () => {
    const dir = tempDir();
    const art = createSignatureArtwork({ publicId: 'p3', text: 'x'.repeat(100), outputDir: dir });
    expect(art.text.length).toBe(12);
    expect(art.width).toBeLessThanOrEqual(80 + 12 * 72 + 1);
  });

  it('readSignatureSvg 对不存在的 id 返回 null', () => {
    const dir = tempDir();
    expect(readSignatureSvg(dir, 'missing')).toBeNull();
  });
});

describe('命令解析：普通聊天不被命令劫持', () => {
  it('普通文本走 chat', () => {
    expect(parseCommand('哈哈哈哈', 'v1', '甲').kind).toBe('chat');
    expect(parseCommand('你是谁啊', 'v1', '甲').kind).toBe('chat');
    expect(parseCommand('大肥鱼在吗', 'v1', '甲').kind).toBe('chat');
  });

  it('识别 LOL 查询', () => {
    const cmd = parseCommand('查战绩 Faker#KR1', 'v1', '甲');
    expect(cmd.kind).toBe('lol');
    if (cmd.kind === 'lol') expect(cmd.query).toBe('Faker#KR1');
  });

  it('识别签名申请，未指定文字时用昵称', () => {
    // “签名 xxx”（带空格）在任何节目都认，是明确意图
    const withText = parseCommand('签名 大肥鱼最帅', 'v1', '甲');
    expect(withText.kind).toBe('signature');
    if (withText.kind === 'signature') expect(withText.text).toBe('大肥鱼最帅');

    // 裸“签名”只在签名节目里生效，避免“签名怎么弄啊”被劫持
    const inChat = parseCommand('签名', 'v1', '小鱼干', 'chat');
    expect(inChat.kind).toBe('chat');

    const inSignature = parseCommand('签名', 'v1', '小鱼干', 'signature');
    expect(inSignature.kind).toBe('signature');
    if (inSignature.kind === 'signature') expect(inSignature.text).toBe('小鱼干');

    // 显式前缀任何时候都生效
    const prefixed = parseCommand('/签名', 'v1', '小鱼干', 'chat');
    expect(prefixed.kind).toBe('signature');
  });

  it('识别 Boss 动作与开关（在 boss 节目或显式前缀下）', () => {
    const attack = parseCommand('攻击', 'v1', null, 'boss');
    expect(attack.kind).toBe('boss.act');
    if (attack.kind === 'boss.act') expect(attack.action).toBe('attack');

    const charge = parseCommand('蓄力', 'v1', null, 'boss');
    if (charge.kind === 'boss.act') expect(charge.action).toBe('charge');

    const heal = parseCommand('治疗', 'v1', null, 'boss');
    if (heal.kind === 'boss.act') expect(heal.action).toBe('heal');

    expect(parseCommand('开Boss', 'v1', null, 'boss').kind).toBe('boss.open');
    expect(parseCommand('结算', 'v1', null, 'boss').kind).toBe('boss.settle');

    // 显式前缀在 chat 节目也生效
    expect(parseCommand('/攻击', 'v1', null, 'chat').kind).toBe('boss.act');
    expect(parseCommand('/开Boss', 'v1', null, 'chat').kind).toBe('boss.open');
  });

  it('chat 节目里的裸动作词不会被劫持', () => {
    // 观众只是在闲聊里说“打”“奶”
    expect(parseCommand('打', 'v1', null, 'chat').kind).toBe('chat');
    expect(parseCommand('奶', 'v1', null, 'chat').kind).toBe('chat');
    expect(parseCommand('治疗', 'v1', null, 'chat').kind).toBe('chat');
  });

  it('“治疗一下”这类自然语句不会被误判为命令', () => {
    expect(parseCommand('治疗一下我的菜', 'v1', null, 'boss').kind).toBe('chat');
  });

  it('裸“查”不再被当作战绩查询', () => {
    expect(parseCommand('查了下天气预报', 'v1', null, 'chat').kind).toBe('chat');
    // 明确的“查战绩”仍然有效
    expect(parseCommand('查战绩 Faker', 'v1', null, 'chat').kind).toBe('lol');
  });

  it('“签名怎么弄啊”不会被当作签名申请', () => {
    expect(parseCommand('签名怎么弄啊', 'v1', null, 'chat').kind).toBe('chat');
  });
});

describe('蓄力代价', () => {
  it('每个蓄力动作让队伍额外自损 1 点', () => {
    const boss = new BossProgram({
      bossName: 'B',
      bossMaxHp: 500,
      partyMaxHp: 100,
      windowMs: 10_000,
      autoAdvanceMs: 0,
    });
    boss.openRound();
    boss.submit({ viewerId: 'v1', viewerName: null, action: 'charge' });
    boss.submit({ viewerId: 'v2', viewerName: null, action: 'charge' });
    const result = boss.settle();

    // 第 1 回合：bossDamage = 4，chargeCost = 2 → 队伍 100 - 4 - 2 = 94
    expect(result?.bossDamage).toBe(4);
    expect(boss.snapshot().partyHp).toBe(94);
    expect(result?.summary).toContain('蓄力代价 2 点');
  });

  it('队伍血量不会低于 0', () => {
    const boss = new BossProgram({
      bossName: 'B',
      bossMaxHp: 500,
      partyMaxHp: 5,
      windowMs: 10_000,
      autoAdvanceMs: 0,
    });
    boss.openRound();
    for (let i = 0; i < 10; i += 1) {
      boss.submit({ viewerId: `v${i}`, viewerName: null, action: 'charge' });
    }
    boss.settle();
    expect(boss.snapshot().partyHp).toBe(0);
  });
});

describe('回合 ID 唯一性', () => {
  it('reset 后同一毫秒开新回合也不会与旧 ID 冲突', () => {
    const fixed = () => 1_700_000_000_000;
    const boss = new BossProgram(
      { bossName: 'B', bossMaxHp: 100, partyMaxHp: 100, windowMs: 1000, autoAdvanceMs: 0 },
      fixed,
    );
    const first = boss.openRound();
    boss.settle();
    boss.reset();
    const second = boss.openRound();
    expect(second.roundId).not.toBe(first.roundId);
    expect(second.roundId).toBeTruthy();
  });
});

describe('签名读取路径校验', () => {
  it('拒绝含路径分隔符的 publicId', () => {
    const dir = tempDir();
    expect(readSignatureSvg(dir, '../secret')).toBeNull();
    expect(readSignatureSvg(dir, 'a/b')).toBeNull();
    expect(readSignatureSvg(dir, '..')).toBeNull();
  });
});
