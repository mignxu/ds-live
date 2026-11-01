import { z } from 'zod';
import type { ToolImpl } from './registry.js';

/**
 * lol.lookup：只读查询英雄联盟玩家公开战绩。
 *
 * 两种适配：
 * - mock（默认）：本地确定性数据，明确 isMock。
 * - http：真实外部服务。契约未核实（见 docs/references.md），
 *   因此实现包含统一 egress 校验（拒绝内网/元数据地址、限制重定向与响应体），
 *   但**未与真实服务联调**，默认不启用。
 */
const ArgumentsSchema = z.object({
  query: z.string().trim().min(1).max(64),
});

export type LolAdapterConfig =
  | { adapter: 'mock' }
  | { adapter: 'http'; baseUrl: string; token: string | null };

export type LolPlayerFact = {
  displayName: string;
  rank: string;
  role: string;
  summary: string;
  /** 数据来源说明，写进卡片让观众看到依据。 */
  sourceNote: string;
};

const MockPlayers: Record<string, Omit<LolPlayerFact, 'sourceNote'>> = {
  faker: {
    displayName: 'Faker',
    rank: '挑战者 1120 LP',
    role: '中单',
    summary: 'Faker 目前是挑战者 1120 LP，主要打中单。',
  },
  大肥鱼: {
    displayName: '大肥鱼',
    rank: '未定级',
    role: '辅助',
    summary: '这个 ID 在 mock 数据里是未定级，主打辅助。',
  },
};

export function createLolLookupTool(config: LolAdapterConfig): ToolImpl {
  return {
    definition: {
      name: 'lol.lookup',
      description:
        '查询一名英雄联盟玩家的公开战绩信息（段位、常玩位置）。参数 query 为 Riot ID 或昵称。只读。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Riot ID，例如 Faker#KR1' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      readOnly: true,
    },
    argumentsSchema: ArgumentsSchema,
    async execute(args, context) {
      const { query } = ArgumentsSchema.parse(args);

      if (config.adapter === 'http') {
        return lookupOverHttp(config, query, context.signal);
      }

      const key = (query.split('#')[0] ?? query).toLowerCase();
      if (/^(zzz|不存在|unknown)/i.test(key)) {
        return {
          status: 'error',
          data: null,
          source: 'mock',
          isMock: true,
          errorCode: 'upstream_error',
          retryable: false,
          message: 'mock 数据源中没有这个玩家',
        };
      }

      const player = MockPlayers[key] ?? {
        displayName: query,
        rank: '白金 II 40 LP',
        role: '打野',
        summary: `${query} 在 mock 数据里是白金 II 40 LP，常打野。`,
      };

      return {
        status: 'ok',
        data: { ...player, sourceNote: 'mock 数据源，非真实战绩' } satisfies LolPlayerFact,
        source: 'mock',
        isMock: true,
        errorCode: null,
        retryable: false,
        message: null,
      };
    },
  };
}

/**
 * 真实 HTTP 适配器。
 *
 * 未联调：真实地址、鉴权与响应格式都未核实。这里做的是
 * “契约 + 安全检查”的骨架，避免以后接入时绕过 egress 校验。
 */
async function lookupOverHttp(
  config: { baseUrl: string; token: string | null },
  query: string,
  signal: AbortSignal,
) {
  const guard = assertSafeEgress(config.baseUrl);
  if (!guard.ok) {
    return {
      status: 'error' as const,
      data: null,
      source: 'lol-http' as const,
      isMock: false,
      errorCode: 'unsafe_target' as const,
      retryable: false,
      message: guard.reason,
    };
  }

  const url = new URL('/lookup', config.baseUrl);
  url.searchParams.set('q', query);

  try {
    const response = await fetch(url, {
      signal,
      redirect: 'error',
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
    });
    if (!response.ok) {
      return {
        status: 'error' as const,
        data: null,
        source: 'lol-http' as const,
        isMock: false,
        errorCode: 'upstream_error' as const,
        retryable: response.status >= 500,
        message: `战绩服务返回 ${response.status}`,
      };
    }
    const text = await readLimited(response, 256 * 1024);
    const parsed = JSON.parse(text) as Partial<LolPlayerFact>;
    if (typeof parsed.displayName !== 'string') {
      return {
        status: 'error' as const,
        data: null,
        source: 'lol-http' as const,
        isMock: false,
        errorCode: 'upstream_error' as const,
        retryable: false,
        message: '战绩服务响应格式不符合预期',
      };
    }
    return {
      status: 'ok' as const,
      data: {
        displayName: parsed.displayName,
        rank: typeof parsed.rank === 'string' ? parsed.rank : '未知段位',
        role: typeof parsed.role === 'string' ? parsed.role : '未知位置',
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        sourceNote: '外部战绩服务',
      } satisfies LolPlayerFact,
      source: 'lol-http' as const,
      isMock: false,
      errorCode: null,
      retryable: false,
      message: null,
    };
  } catch (error) {
    return {
      status: 'error' as const,
      data: null,
      source: 'lol-http' as const,
      isMock: false,
      errorCode: signal.aborted ? ('cancelled' as const) : ('upstream_error' as const),
      retryable: !signal.aborted,
      message: error instanceof Error ? error.message.slice(0, 200) : '未知错误',
    };
  }
}

/**
 * 统一 egress 校验：只允许 https，拒绝 loopback / 内网 / 链路本地 / 云元数据地址。
 * 真实环境还应校验 DNS 解析结果与每一跳重定向；这里用 redirect:'error' 阻断重定向。
 */
export function assertSafeEgress(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 不合法' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: '只允许 https' };
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '169.254.169.254' ||
    host === 'metadata.google.internal'
  ) {
    return { ok: false, reason: '拒绝内网或元数据地址' };
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, reason: '拒绝内网地址' };
  }
  return { ok: true };
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '');
  if (!normalized.includes(':')) return false;
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  return false;
}

/** 限制响应体大小，避免上游返回超大内容拖垮进程。 */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`响应体超过 ${maxBytes} 字节`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
