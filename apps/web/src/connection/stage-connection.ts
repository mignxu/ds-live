import type { PlaybackReceipt, StageEvent, StageSnapshot } from '@dafeiyu/contracts';

/**
 * 舞台连接：WS 订阅 + 重连 + 快照恢复。
 *
 * 重连策略：先重新获取 snapshot 与 revision，再恢复后续事件；
 * 不默认重播已经播完的音频（只恢复 recentSpeeches 做可见上下文）。
 */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'reconnecting';

export type StageConnectionHandlers = {
  onSnapshot: (snapshot: StageSnapshot, rendererToken: string) => void;
  onEvent: (event: StageEvent) => void;
  onState: (state: ConnectionState, detail?: string) => void;
  /** 后端拒绝回执（如租约已转移）；连接本身仍然有效。 */
  onReceiptRejected?: (reason: string) => void;
};

export type StageConnection = {
  connect: () => void;
  close: () => void;
  sendReceipt: (receipt: PlaybackReceipt) => void;
  state: () => ConnectionState;
};

const MAX_BACKOFF_MS = 8_000;

export function createStageConnection(
  options: { token: string; handlers: StageConnectionHandlers; baseUrl?: string },
): StageConnection {
  let socket: WebSocket | null = null;
  let state: ConnectionState = 'closed';
  let attempt = 0;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: ConnectionState, detail?: string) => {
    state = next;
    options.handlers.onState(next, detail);
  };

  const buildUrl = () => {
    const base = options.baseUrl ?? window.location.origin;
    const url = new URL('/api/stage/events', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', options.token);
    return url.toString();
  };

  const connect = () => {
    closedByUser = false;
    setState(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(buildUrl());
    socket = ws;

    ws.addEventListener('open', () => {
      attempt = 0;
      setState('open');
    });

    ws.addEventListener('message', (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const payload = parsed as
        | { type: 'snapshot'; snapshot: StageSnapshot; rendererToken?: string }
        | { type: 'receipt.rejected'; reason?: string }
        | StageEvent;

      if (payload.type === 'snapshot') {
        const token = 'rendererToken' in payload ? payload.rendererToken : undefined;
        if (token) options.handlers.onSnapshot(payload.snapshot, token);
        else options.handlers.onSnapshot(payload.snapshot, '');
        return;
      }
      if (payload.type === 'receipt.rejected') {
        // 租约过期等：连接本身仍然有效，只通知上层停止本地播放。
        options.handlers.onReceiptRejected?.(payload.reason ?? 'unknown');
        return;
      }
      options.handlers.onEvent(payload as StageEvent);
    });

    ws.addEventListener('close', (event) => {
      socket = null;
      if (closedByUser) {
        setState('closed');
        return;
      }
      if (event.code === 4401) {
        setState('unauthorized', '舞台令牌无效');
        return;
      }
      attempt += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
      setState('reconnecting', `${delay}ms 后重连`);
      retryTimer = setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => {
      // 错误后浏览器会触发 close，重连逻辑集中在 close。
    });
  };

  return {
    connect,
    close: () => {
      closedByUser = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
      setState('closed');
    },
    sendReceipt: (receipt) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(receipt));
      }
    },
    state: () => state,
  };
}
