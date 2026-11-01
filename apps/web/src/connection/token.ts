/**
 * 令牌读取。舞台/控制台各用最小权限令牌：
 * - 优先 URL 查询参数（OBS 浏览器源方便配置）
 * - 其次 localStorage（本机调试）
 * 不在前端打包任何密钥；令牌由使用者填入，不进 Git。
 */
const STORAGE_KEYS = {
  stage: 'dafeiyu.stageToken',
  studio: 'dafeiyu.studioToken',
} as const;

export type TokenScope = keyof typeof STORAGE_KEYS;

export function readToken(scope: TokenScope, search = window.location.search): string | null {
  const params = new URLSearchParams(search);
  const fromQuery = params.get('token');
  if (fromQuery && fromQuery.length > 0) {
    persistToken(scope, fromQuery);
    return fromQuery;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEYS[scope]);
  } catch {
    return null;
  }
}

export function persistToken(scope: TokenScope, token: string): void {
  try {
    if (token.length > 0) window.localStorage.setItem(STORAGE_KEYS[scope], token);
    else window.localStorage.removeItem(STORAGE_KEYS[scope]);
  } catch {
    // 隐私模式下 localStorage 不可用，忽略
  }
}

/** 从地址栏移除令牌，避免出现在截图或录屏里。 */
export function stripTokenFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  window.history.replaceState({}, '', url.toString());
}
