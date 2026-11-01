import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BossAction, BossState } from '@dafeiyu/contracts';

/**
 * 合作打 Boss 节目。
 *
 * 规则全部确定性、由服务端结算：
 * - 一个房间一个回合；回合有明确的输入窗口；
 * - 每个观众每回合只能提交一次有效动作（按 viewerId 去重）；
 * - 窗口关闭后按固定规则结算，迟到输入不进入已结束回合；
 * - 模型不能改分数，只能事后解说。
 *
 * 这不是“另一个假 demo”：状态机、去重、窗口、结算都有测试。
 */
export type BossConfig = {
  bossName: string;
  bossMaxHp: number;
  partyMaxHp: number;
  /** 输入窗口时长。 */
  windowMs: number;
  /** 回合之间自动开下一轮的间隔；0 表示只靠手动/定时触发。 */
  autoAdvanceMs: number;
};

export const DEFAULT_BOSS_CONFIG: BossConfig = {
  bossName: '弹幕巨鲲',
  bossMaxHp: 300,
  partyMaxHp: 120,
  windowMs: 20_000,
  autoAdvanceMs: 0,
};

export type BossSubmission = {
  viewerId: string;
  viewerName: string | null;
  action: BossAction;
  at: number;
};

export type BossRoundResult = {
  roundId: string;
  round: number;
  actions: Record<BossAction, number>;
  damage: number;
  healing: number;
  bossDamage: number;
  bossDefeated: boolean;
  partyDefeated: boolean;
  /** 给舞台/解说的确定性结算文本。 */
  summary: string;
};

const ACTION_DAMAGE: Record<BossAction, number> = {
  attack: 6,
  charge: 10,
  heal: 0,
};
const HEAL_AMOUNT = 5;
const BOSS_DAMAGE_BASE = 4;
/** 蓄力代价：每个蓄力动作自损 1 血。 */
const CHARGE_SELF_DAMAGE = 1;

export type BossSettleListener = (result: BossRoundResult) => void;

export class BossProgram {
  private state: BossState;
  private readonly submissions = new Map<string, BossSubmission>();
  private windowEndsAt = 0;
  private lastResult: BossRoundResult | null = null;
  /**
   * 结算监听：无论结算是“手动触发”还是“窗口到期自动触发”，
   * 都走同一个回调，避免出现两条结算路径（一条有副作用、一条没有）。
   */
  private settleListener: BossSettleListener | null = null;

  constructor(
    private readonly config: BossConfig = DEFAULT_BOSS_CONFIG,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = {
      roundId: null,
      round: 0,
      phase: 'idle',
      bossName: config.bossName,
      bossHp: config.bossMaxHp,
      bossMaxHp: config.bossMaxHp,
      partyHp: config.partyMaxHp,
      partyMaxHp: config.partyMaxHp,
      submitted: 0,
      windowRemainingMs: 0,
      lastOutcome: null,
    };
  }

  /** 注册结算监听；重复注册会替换。 */
  onSettled(listener: BossSettleListener | null): void {
    this.settleListener = listener;
  }

  /** 当前窗口是否已到期（供外部定时器/轮询调用）。 */
  isWindowExpired(): boolean {
    return this.state.phase === 'open' && this.now() >= this.windowEndsAt;
  }

  /** 开一轮新回合；已结束/进行中的回合不会被静默覆盖。 */
  openRound(): BossState {
    if (this.state.phase === 'open' || this.state.phase === 'settling') {
      return this.snapshot();
    }
    if (this.state.bossHp === 0 || this.state.partyHp === 0) {
      // 上一局已分出胜负：重置血量再开新局。
      this.state.bossHp = this.config.bossMaxHp;
      this.state.partyHp = this.config.partyMaxHp;
    }
    this.submissions.clear();
    this.windowEndsAt = this.now() + this.config.windowMs;
    this.state = {
      ...this.state,
      // 带随机后缀：reset 后 round 会回到 1，同一毫秒内可能与旧 roundId 撞车，
      // 而 roundId 是 program_runs 的主键。
      roundId: `boss_${this.now().toString(36)}_${this.state.round + 1}_${randomUUID().slice(0, 8)}`,
      round: this.state.round + 1,
      phase: 'open',
      submitted: 0,
      windowRemainingMs: this.config.windowMs,
    };
    return this.snapshot();
  }

  /**
   * 提交动作。返回 null 表示被拒绝（窗口未开、已结束、重复提交、已阵亡）。
   * 拒绝原因不暴露给模型，只回给调用方做提示。
   */
  submit(input: {
    viewerId: string;
    viewerName: string | null;
    action: BossAction;
  }): { accepted: boolean; reason?: string; state: BossState } {
    if (this.state.phase !== 'open') {
      return { accepted: false, reason: 'round_not_open', state: this.snapshot() };
    }
    if (this.now() >= this.windowEndsAt) {
      // 窗口到点：拒绝这条输入。结算由定时器或显式 settle() 负责，
      // 不让 submit 内部产生“隐式结算”这条旁路。
      return { accepted: false, reason: 'window_closed', state: this.snapshot() };
    }
    if (this.submissions.has(input.viewerId)) {
      return { accepted: false, reason: 'already_submitted', state: this.snapshot() };
    }
    this.submissions.set(input.viewerId, {
      viewerId: input.viewerId,
      viewerName: input.viewerName,
      action: input.action,
      at: this.now(),
    });
    this.state = { ...this.state, submitted: this.submissions.size };
    return { accepted: true, state: this.snapshot() };
  }

  /**
   * 回滚一次已接受但未能持久化的提交（写库失败时使用）。
   * 保证内存统计与数据库一致：宁可少记一票，也不能出现两套事实。
   */
  revertSubmission(viewerId: string): void {
    if (!this.submissions.delete(viewerId)) return;
    this.state = { ...this.state, submitted: this.submissions.size };
  }

  /** 关闭窗口并结算；重复调用返回同一结果，不重复结算。 */
  settle(): BossRoundResult | null {
    if (this.state.phase !== 'open') return this.lastResult;

    this.state = { ...this.state, phase: 'settling', windowRemainingMs: 0 };
    const actions: Record<BossAction, number> = { attack: 0, charge: 0, heal: 0 };
    for (const submission of this.submissions.values()) {
      actions[submission.action] += 1;
    }

    // 确定性规则：
    // - attack 每票 6 伤；
    // - charge 每票 10 伤，但每个蓄力的人自损 1（代价）；
    // - heal 每票回 5 血；
    // - Boss 每回合对队伍造成 4 + floor(回合/3) 伤害。
    const damage = actions.attack * ACTION_DAMAGE.attack + actions.charge * ACTION_DAMAGE.charge;
    const healing = actions.heal * HEAL_AMOUNT;
    const chargeCost = actions.charge * CHARGE_SELF_DAMAGE;
    const bossDamage = BOSS_DAMAGE_BASE + Math.floor(this.state.round / 3);

    const bossHp = Math.max(0, this.state.bossHp - damage);
    const partyHp = Math.max(
      0,
      Math.min(this.config.partyMaxHp, this.state.partyHp - bossDamage + healing - chargeCost),
    );

    const result: BossRoundResult = {
      roundId: this.state.roundId ?? `boss_${this.state.round}`,
      round: this.state.round,
      actions,
      damage,
      healing,
      bossDamage,
      bossDefeated: bossHp === 0,
      partyDefeated: partyHp === 0,
      summary: buildSummary(actions, damage, healing, bossDamage, chargeCost, bossHp, partyHp),
    };

    this.lastResult = result;
    this.state = {
      ...this.state,
      phase: 'resolved',
      bossHp,
      partyHp,
      lastOutcome: result.summary,
      submitted: this.submissions.size,
    };
    // 统一出口：手动结算与窗口到期自动结算都会走到这里。
    this.settleListener?.(result);
    return result;
  }

  /** 广播给舞台的只读状态；窗口剩余时间按当前时刻计算。 */
  snapshot(): BossState {
    const remaining =
      this.state.phase === 'open' ? Math.max(0, this.windowEndsAt - this.now()) : 0;
    return { ...this.state, windowRemainingMs: remaining };
  }

  /** 控制台/舞台可见的最近结算。 */
  lastRoundResult(): BossRoundResult | null {
    return this.lastResult;
  }

  reset(): BossState {
    this.submissions.clear();
    this.lastResult = null;
    this.state = {
      roundId: null,
      round: 0,
      phase: 'idle',
      bossName: this.config.bossName,
      bossHp: this.config.bossMaxHp,
      bossMaxHp: this.config.bossMaxHp,
      partyHp: this.config.partyMaxHp,
      partyMaxHp: this.config.partyMaxHp,
      submitted: 0,
      windowRemainingMs: 0,
      lastOutcome: null,
    };
    return this.snapshot();
  }
}

function buildSummary(
  actions: Record<BossAction, number>,
  damage: number,
  healing: number,
  bossDamage: number,
  chargeCost: number,
  bossHp: number,
  partyHp: number,
): string {
  if (damage === 0 && healing === 0) {
    return '这回合没人动手，Boss 白打了一轮。';
  }
  const parts = [`攻击 ${actions.attack}、蓄力 ${actions.charge}、治疗 ${actions.heal}`];
  parts.push(`造成 ${damage} 点伤害，回复 ${healing} 点`);
  if (chargeCost > 0) parts.push(`蓄力代价 ${chargeCost} 点`);
  parts.push(`Boss 反击 ${bossDamage} 点`);
  parts.push(`Boss 剩 ${bossHp} 血，队伍剩 ${partyHp} 血`);
  return parts.join('；') + '。';
}

/** 签名节目：确定性笔迹路径生成，不依赖字体文件或第三方素材。 */
export type SignatureStroke = {
  /** SVG path 的 d 属性。 */
  d: string;
  width: number;
};

export type SignatureArtifact = {
  publicId: string;
  text: string;
  width: number;
  height: number;
  strokes: SignatureStroke[];
  /** 相对媒体地址。 */
  imageUrl: string;
  isMock: boolean;
};

const GLYPH_WIDTH = 72;
const GLYPH_HEIGHT = 120;

/**
 * 生成原创“笔迹”签名：每个字符用确定性的贝塞尔曲线绘制，
 * 不是真实手写，也不冒称真人手写。相同文本产生相同路径（可复现）。
 */
export function createSignatureArtwork(input: {
  publicId: string;
  text: string;
  outputDir: string;
  publicPrefix?: string;
}): SignatureArtifact {
  const text = input.text.slice(0, 12);
  const width = Math.max(240, 80 + text.length * GLYPH_WIDTH);
  const height = 200;
  const strokes: SignatureStroke[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const seed = hash32(`${text[index] ?? ''}${index}`);
    const originX = 40 + index * GLYPH_WIDTH;
    const originY = 60 + (seed % 17);
    const wobble = ((seed >> 5) % 23) - 11;
    strokes.push({
      width: 5,
      d: [
        `M ${originX} ${originY + GLYPH_HEIGHT * 0.5}`,
        `C ${originX + 14} ${originY - 18}, ${originX + 46} ${originY + 6}, ${originX + 56} ${originY + GLYPH_HEIGHT * 0.32}`,
        `S ${originX + 18 + wobble} ${originY + GLYPH_HEIGHT * 0.95}, ${originX + 62} ${originY + GLYPH_HEIGHT * 0.7}`,
      ].join(' '),
    });
    // 一点收笔
    strokes.push({
      width: 3,
      d: `M ${originX + 20} ${originY + GLYPH_HEIGHT * 0.78} Q ${originX + 40} ${originY + GLYPH_HEIGHT * (0.62 + (wobble % 5) / 50)}, ${originX + 66} ${originY + GLYPH_HEIGHT * 0.55}`,
    });
  }

  const svg = renderSignatureSvg({ width, height, strokes, text });
  const prefix = input.publicPrefix ?? '/media/souvenirs';
  mkdirSync(input.outputDir, { recursive: true });
  const fileName = `sig-${input.publicId}.svg`;
  const filePath = join(input.outputDir, fileName);
  if (!existsSync(filePath)) writeFileSync(filePath, svg, 'utf8');

  return {
    publicId: input.publicId,
    text,
    width,
    height,
    strokes,
    imageUrl: `${prefix}/${fileName}`,
    isMock: true,
  };
}

export function renderSignatureSvg(input: {
  width: number;
  height: number;
  strokes: SignatureStroke[];
  text: string;
}): string {
  const paths = input.strokes
    .map(
      (stroke) =>
        `<path d="${stroke.d}" fill="none" stroke="#0b3a5c" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">`,
    '<rect width="100%" height="100%" fill="#fdf6e8"/>',
    `<text x="${input.width - 16}" y="${input.height - 14}" text-anchor="end" font-size="12" fill="#8a7a5c" font-family="system-ui">大肥鱼 · mock 笔迹</text>`,
    paths,
    '</svg>',
  ].join('');
}

/**
 * 读取已生成的签名 SVG（供测试/调试使用；线上走媒体路由，不经过这里）。
 * publicId 必须匹配安全字符集，防止 `..` 之类穿越到目录外。
 */
export function readSignatureSvg(outputDir: string, publicId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(publicId)) return null;
  const filePath = join(outputDir, `sig-${publicId}.svg`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

function hash32(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
