import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import type { SpeechPlan, StageSnapshot } from '@dafeiyu/contracts';
import { StagePage } from '../src/pages/stage/StagePage.js';

/**
 * 舞台组件测试：重点覆盖「取消旧句 + 立即新句」的竞态。
 *
 * 这个竞态曾经真实存在：服务端在同一帧广播 speech.cancelled(旧) 与 speech.ready(新)，
 * 旧句的 done 回调晚于新句启动，导致误停新句。现在用 speechId 精确匹配。
 */

type FakeSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  OPEN: number;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  emit: (type: string, event: unknown) => void;
};

let sockets: FakeSocket[] = [];

function installFakeWebSocket(): void {
  sockets = [];
  class FakeWebSocket implements Partial<FakeSocket> {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    OPEN = 1;
    send = vi.fn();
    close = vi.fn();
    private handlers = new Map<string, Array<(event: unknown) => void>>();

    constructor() {
      sockets.push(this as unknown as FakeSocket);
      // 连接成功后立刻下发快照（模拟服务端行为）
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type: string, handler: (event: unknown) => void) {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }

    emit(type: string, event: unknown) {
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

function snapshot(activeSpeech: SpeechPlan | null = null): StageSnapshot {
  return {
    revision: 1,
    roomId: 'room-main',
    program: 'chat',
    characterName: '大肥鱼',
    activeSpeech,
    recentSpeeches: [],
    degraded: { active: false, reason: null },
    programState: null,
    updatedAt: new Date().toISOString(),
  };
}

function speech(speechId: string, text: string): SpeechPlan {
  return {
    speechId,
    turnId: `turn-${speechId}`,
    text,
    audioUrl: null,
    audioDurationMs: null,
    timings: [],
    audioIsMock: false,
    effects: [{ kind: 'speech', text, isMock: false }],
    isMock: false,
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/stage');
});

describe('舞台：取消旧句与推送新句的竞态', () => {
  it('取消旧句后立刻推新句，新句仍然显示（不被误停）', async () => {
    installFakeWebSocket();
    window.localStorage.setItem('dafeiyu.stageToken', 'dev-only-stage');

    render(<StagePage />);
    await act(async () => {
      await Promise.resolve();
    });

    const socket = sockets[0];
    expect(socket).toBeDefined();

    // 先下发快照（带租约），再点“开始”
    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(), rendererToken: 'lease-1' }),
      });
    });

    const activate = screen.getByRole('button', { name: /点击开始/ });
    await act(async () => {
      activate.click();
    });

    // 服务端同一帧内：取消旧句 → 推送新句
    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.ready', speech: speech('old-speech', '旧的一句话') }),
      });
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.cancelled', speechId: 'old-speech' }),
      });
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.ready', speech: speech('new-speech', '新的一句话') }),
      });
      await Promise.resolve();
    });

    // 新句必须还在舞台上
    expect(await screen.findByText('新的一句话')).toBeTruthy();
  });

  it('服务端取消当前句后回到待机', async () => {
    installFakeWebSocket();
    window.localStorage.setItem('dafeiyu.stageToken', 'dev-only-stage');

    render(<StagePage />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = sockets[0];

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(), rendererToken: 'lease-1' }),
      });
    });
    await act(async () => {
      screen.getByRole('button', { name: /点击开始/ }).click();
    });

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.ready', speech: speech('s1', '会被取消') }),
      });
      await Promise.resolve();
    });
    expect(await screen.findByText('会被取消')).toBeTruthy();

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.cancelled', speechId: 's1' }),
      });
      await Promise.resolve();
    });

    expect(await screen.findByText('待机中…')).toBeTruthy();
  });

  it('没有租约时不发回执（避免 stale_renderer_lease 误停）', async () => {
    installFakeWebSocket();
    window.localStorage.setItem('dafeiyu.stageToken', 'dev-only-stage');

    render(<StagePage />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = sockets[0];
    expect(socket).toBeDefined();

    // 不先发 snapshot：模拟重连时 speech.ready 先到
    await act(async () => {
      screen.getByRole('button', { name: /点击开始/ }).click();
    });
    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'speech.ready', speech: speech('s-no-lease', '无租约') }),
      });
      await Promise.resolve();
    });

    // 不应该发任何 started 回执
    const sends = socket?.send.mock.calls.map((call) => String(call[0])) ?? [];
    expect(sends.some((payload) => payload.includes('"started"'))).toBe(false);
  });
});

describe('舞台：Boss 面板', () => {
  it('programState 有 Boss 时显示血条与回合', async () => {
    installFakeWebSocket();
    window.localStorage.setItem('dafeiyu.stageToken', 'dev-only-stage');

    render(<StagePage />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = sockets[0];

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({
          type: 'snapshot',
          snapshot: {
            ...snapshot(),
            program: 'boss',
            programState: {
              roundId: 'r1',
              round: 3,
              phase: 'open',
              bossName: '弹幕巨鲲',
              bossHp: 240,
              bossMaxHp: 300,
              partyHp: 100,
              partyMaxHp: 120,
              submitted: 7,
              windowRemainingMs: 12_000,
              lastOutcome: null,
            },
          },
          rendererToken: 'lease-1',
        }),
      });
      await Promise.resolve();
    });

    expect(await screen.findByText(/弹幕巨鲲/)).toBeTruthy();
    expect(screen.getByText(/第 3 回合/)).toBeTruthy();
    expect(screen.getByText(/已出手 7/)).toBeTruthy();
    expect(screen.getByText(/240\/300/)).toBeTruthy();
  });

  it('签名效果渲染图片并标记 mock', async () => {
    installFakeWebSocket();
    window.localStorage.setItem('dafeiyu.stageToken', 'dev-only-stage');

    render(<StagePage />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = sockets[0];

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({ type: 'snapshot', snapshot: snapshot(), rendererToken: 'lease-1' }),
      });
    });
    await act(async () => {
      screen.getByRole('button', { name: /点击开始/ }).click();
    });

    await act(async () => {
      socket?.emit('message', {
        data: JSON.stringify({
          type: 'speech.ready',
          speech: {
            ...speech('sig-1', '签名好了'),
            isMock: true,
            effects: [
              { kind: 'speech', text: '签名好了', isMock: false },
              {
                kind: 'signature',
                text: '签名：大肥鱼',
                imageUrl: '/media/souvenirs/sig-abc.svg',
                isMock: true,
              },
            ],
          },
        }),
      });
      await Promise.resolve();
    });

    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe('/media/souvenirs/sig-abc.svg');
  });
});

describe('舞台：无令牌提示', () => {
  it('没有令牌时提示缺少舞台令牌', async () => {
    installFakeWebSocket();
    render(<StagePage />);
    expect(await screen.findByText(/缺少舞台令牌/)).toBeTruthy();
  });
});
