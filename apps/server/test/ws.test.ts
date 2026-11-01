import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeRuntime, waitForIdle, type TestRuntime } from '../src/test-support.js';

let app: FastifyInstance | null = null;
let harness: TestRuntime | null = null;

afterEach(async () => {
  await app?.close();
  await harness?.cleanup();
  app = null;
  harness = null;
});

async function setup() {
  harness = makeRuntime();
  app = await buildApp({ runtime: harness.runtime, webDistDir: null, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取监听端口');
  return { app, runtime: harness.runtime, port: address.port };
}

type Received = Record<string, unknown>;

function connect(port: number, token: string): Promise<{ socket: WebSocket; messages: Received[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stage/events?token=${token}`);
    const messages: Received[] = [];
    socket.on('message', (data) => {
      messages.push(JSON.parse(String(data)) as Received);
    });
    socket.on('open', () => resolve({ socket, messages }));
    socket.on('error', reject);
  });
}

async function waitFor(messages: Received[], predicate: (m: Received) => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待消息超时，已收到：${JSON.stringify(messages)}`);
}

describe('WS 舞台契约', () => {
  it('无令牌连接被拒绝', async () => {
    const { port } = await setup();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stage/events?token=wrong`);
    const code = await new Promise<number>((resolve) => {
      socket.on('close', (closeCode) => resolve(closeCode));
    });
    expect(code).toBe(4401);
  });

  it('连接后先收到快照与 rendererToken', async () => {
    const { port } = await setup();
    const { socket, messages } = await connect(port, 'dev-only-stage');
    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    expect(snapshot.rendererToken).toEqual(expect.any(String));
    expect((snapshot.snapshot as { characterName: string }).characterName).toBe('大肥鱼');
    socket.close();
  });

  it('聊天事件推送到舞台，播放回执结束当前回应', async () => {
    const { port, app: instance, runtime } = await setup();
    const { socket, messages } = await connect(port, 'dev-only-stage');
    const snapshot = await waitFor(messages, (m) => m.type === 'snapshot');
    const rendererToken = snapshot.rendererToken as string;

    await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: { authorization: 'Bearer dev-only-ingest' },
      payload: {
        roomId: 'room-main',
        eventId: 'ws-1',
        type: 'chat.message',
        payload: { text: '你是谁', viewerName: '观众' },
      },
    });
    await waitForIdle(runtime);

    const ready = await waitFor(messages, (m) => m.type === 'speech.ready');
    const speech = ready.speech as { speechId: string; text: string };
    expect(speech.text).toContain('大肥鱼');

    socket.send(
      JSON.stringify({
        speechId: speech.speechId,
        rendererToken,
        state: 'ended',
        positionMs: 1200,
      }),
    );
    await waitFor(messages, (m) => m.type === 'speech.completed');
    expect(runtime.stage.snapshot().activeSpeech).toBeNull();
    socket.close();
  });

  it('旧 renderer 回执被拒绝', async () => {
    const { port } = await setup();
    const first = await connect(port, 'dev-only-stage');
    const firstSnapshot = await waitFor(first.messages, (m) => m.type === 'snapshot');

    // 第二个连接接管租约
    const second = await connect(port, 'dev-only-stage');
    await waitFor(second.messages, (m) => m.type === 'snapshot');

    first.socket.send(
      JSON.stringify({
        speechId: 'whatever',
        rendererToken: firstSnapshot.rendererToken as string,
        state: 'started',
        positionMs: 0,
      }),
    );
    const rejected = await waitFor(first.messages, (m) => m.type === 'receipt.rejected');
    expect(rejected.reason).toBe('stale_renderer_lease');

    first.socket.close();
    second.socket.close();
  });
});
