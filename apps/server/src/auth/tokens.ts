import { timingSafeEqual } from 'node:crypto';

/**
 * 最小权限令牌校验。
 * 舞台只读、弹幕接入、主播控制台各用独立令牌，互不复用。
 * 比较使用定长安全比较，避免时序侧信道。
 */
export function tokenMatches(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type TokenScope = 'stage' | 'ingest' | 'studio';

export function extractToken(headers: Record<string, unknown>): string | null {
  const header = headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const apiToken = headers['x-api-token'];
  if (typeof apiToken === 'string' && apiToken.length > 0) return apiToken;
  return null;
}
