import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MockModelGateway } from '../src/harness/mock-model.js';
import { makeRuntime, testConfig, waitForIdle, type TestRuntime } from '../src/test-support.js';

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
  return { app, runtime: harness.runtime };
}

const ingestHeaders = { authorization: 'Bearer dev-only-ingest' };
const stageHeaders = { authorization: 'Bearer dev-only-stage' };
const studioHeaders = { authorization: 'Bearer dev-only-studio' };

describe('HTTP 契约', () => {
  it('health 不暴露配置', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('缺少接入凭证返回 401', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      payload: { roomId: 'room-main', type: 'chat.message', payload: { text: '你好' } },
    });
    expect(response.statusCode).toBe(401);
  });

  it('非法事件返回 400 且不进入队列', async () => {
    const { app: instance, runtime } = await setup();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload: { roomId: 'room-main', type: 'chat.execute', payload: { text: 'x' } },
    });
    expect(response.statusCode).toBe(400);
    expect(runtime.scheduler.queueDepth).toBe(0);
  });

  it('重复事件被识别为 duplicate', async () => {
    const { app: instance } = await setup();
    const payload = {
      roomId: 'room-main',
      eventId: 'dup-1',
      type: 'chat.message',
      payload: { text: '你好' },
    };
    const first = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ duplicate: false, dedupeStrategy: 'platform-id' });

    const second = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(second.json()).toMatchObject({ duplicate: true, accepted: false });
  });

  it('无 eventId 时用内容指纹去重并如实标记策略', async () => {
    const { app: instance } = await setup();
    const payload = {
      roomId: 'room-main',
      viewerId: 'v1',
      type: 'chat.message',
      payload: { text: '同样的内容' },
    };
    const first = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(first.json()).toMatchObject({ dedupeStrategy: 'content-fingerprint' });
    const second = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(second.json()).toMatchObject({ duplicate: true });
  });

  it('聊天事件驱动一轮回应并出现在舞台快照', async () => {
    const { app: instance, runtime } = await setup();
    await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload: {
        roomId: 'room-main',
        eventId: 'e-chat-1',
        viewerId: 'v1',
        type: 'chat.message',
        payload: { text: '你是谁啊', viewerName: '小鱼干' },
      },
    });
    await waitForIdle(runtime);

    const snapshot = await instance.inject({
      method: 'GET',
      url: '/api/stage/snapshot',
      headers: stageHeaders,
    });
    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json();
    expect(body.characterName).toBe('大肥鱼');
    expect(body.activeSpeech.text).toContain('大肥鱼');
  });

  it('舞台快照需要舞台令牌，控制台令牌不可复用', async () => {
    const { app: instance } = await setup();
    const withStudio = await instance.inject({
      method: 'GET',
      url: '/api/stage/snapshot',
      headers: studioHeaders,
    });
    expect(withStudio.statusCode).toBe(401);

    const withoutToken = await instance.inject({ method: 'GET', url: '/api/stage/snapshot' });
    expect(withoutToken.statusCode).toBe(401);
  });

  it('studio 状态包含降级标记与预算，不含密钥', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({
      method: 'GET',
      url: '/api/studio/status',
      headers: studioHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.modelId).toContain('mock');
    expect(body.budget.turnDeadlineMs).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/dev-only|apiKey|token/i);
  });

  it('主播控制可以取消当前回应', async () => {
    const { app: instance, runtime } = await setup();
    await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload: {
        roomId: 'room-main',
        eventId: 'e-cancel-1',
        type: 'chat.message',
        payload: { text: '你是谁' },
      },
    });
    await waitForIdle(runtime);
    expect(runtime.stage.snapshot().activeSpeech).not.toBeNull();

    const control = await instance.inject({
      method: 'POST',
      url: '/api/studio/control',
      headers: studioHeaders,
      payload: { action: 'cancel' },
    });
    expect(control.statusCode).toBe(200);
    expect(control.json()).toMatchObject({ ok: true });
    expect(runtime.stage.snapshot().activeSpeech).toBeNull();
  });

  it('未知控制动作返回 400', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/studio/control',
      headers: studioHeaders,
      payload: { action: 'drop_database' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('队列背压与去重一致性', () => {
  it('队列满时不把事件记为已处理，重试仍能成功', async () => {
    // 慢模型保证队列在填充期间不会被瞬间抽干。
    harness = makeRuntime({ model: new MockModelGateway({ delayMs: 400 }) });
    const runtime = harness.runtime;
    app = await buildApp({ runtime, webDistDir: null, logger: false });
    const instance = app;

    // 占满队列：maxPending 默认 32，用慢模型更难，这里直接塞满
    // drain 会立刻把第一条转成执行中，所以要多塞一条才能真正填满 pending。
    const capacity = runtime.config.queue.maxPending + 1;
    for (let i = 0; i < capacity; i += 1) {
      runtime.scheduler.enqueue({
        turnId: `block-${i}`,
        traceId: `block-trace-${i}`,
        sessionId: runtime.repository.ensureSession('room-main'),
        roomId: 'room-main',
        triggerEventId: null,
        viewerName: null,
        text: `占位${i}`,
      });
    }

    const payload = {
      roomId: 'room-main',
      eventId: 'backpressure-1',
      type: 'chat.message',
      payload: { text: '排队测试' },
    };
    const rejected = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(rejected.statusCode).toBe(429);

    // 清空队列后同一条事件应被接受，而不是被误判成重复
    runtime.scheduler.clearPending();
    await waitForIdle(runtime, 5000);
    const retried = await instance.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload,
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ duplicate: false });
  });

  it('非开发模式拒绝模拟事件', async () => {
    harness = makeRuntime({
      config: testConfig({ devAllowMockIngest: false }),
    });
    app = await buildApp({ runtime: harness.runtime, webDistDir: null, logger: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest/events',
      headers: ingestHeaders,
      payload: { roomId: 'room-main', type: 'system.tick', payload: { reason: 'manual' } },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('安全响应头', () => {
  it('API 响应禁止缓存与嵌入', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({ method: 'GET', url: '/health' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');

    const api = await instance.inject({
      method: 'GET',
      url: '/api/stage/snapshot',
      headers: stageHeaders,
    });
    expect(api.headers['x-frame-options']).toBe('DENY');
  });
});

describe('控制台写操作的 CSRF 边界', () => {
  it('只带 Cookie 的写操作被拒绝，必须用 Header 令牌', async () => {
    const { app: instance } = await setup();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/studio/control',
      cookies: { studio_token: 'dev-only-studio' },
      payload: { action: 'cancel' },
    });
    expect(response.statusCode).toBe(401);

    const withHeader = await instance.inject({
      method: 'POST',
      url: '/api/studio/control',
      cookies: { studio_token: 'dev-only-studio' },
      headers: studioHeaders,
      payload: { action: 'cancel' },
    });
    expect(withHeader.statusCode).toBe(200);
  });
});

describe('日志不泄露 URL 中的令牌', () => {
  it('请求序列化只保留路径，不含 query 里的 token', async () => {
    const { safeRequestSerializer } = await import('../src/app.js');
    const serialized = safeRequestSerializer({
      method: 'GET',
      url: '/api/stage/events?token=dev-only-stage',
      ip: '127.0.0.1',
    });
    expect(serialized.path).toBe('/api/stage/events');
    expect(JSON.stringify(serialized)).not.toContain('dev-only-stage');
  });

  it('app.ts 的 logger 配置使用该序列化器', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain('req: safeRequestSerializer');
    expect(source).not.toMatch(/url: request\.url/);
  });
});
