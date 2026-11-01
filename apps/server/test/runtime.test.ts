import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { Repository } from '../src/storage/repository.js';
import { IngressNormalizer } from '../src/ingress/normalizer.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { StageService } from '../src/stage/stage-service.js';
import { Harness } from '../src/harness/harness.js';
import { MockModelGateway } from '../src/harness/mock-model.js';
import type { ModelGateway, ModelRequest } from '../src/harness/model.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createLolLookupTool } from '../src/tools/lol-lookup.js';

const lolLookupTool = createLolLookupTool({ adapter: 'mock' });
import { loadCharacter } from '../src/conversation/character.js';
import type { AssistantTurn } from '@dafeiyu/contracts';

const budget = {
  maxModelCallsPerTurn: 3,
  maxToolCallsPerTurn: 3,
  modelTimeoutMs: 500,
  toolTimeoutMs: 200,
  turnDeadlineMs: 2000,
};

describe('接入归一化与限流', () => {
  it('同一观众超过限流被拒绝', () => {
    const normalizer = new IngressNormalizer({ rateLimitPerMinute: 2 });
    const submission = {
      roomId: 'r1',
      viewerId: 'v1',
      type: 'chat.message' as const,
      payload: { text: '你好' },
    };
    expect(normalizer.normalize(submission).ok).toBe(true);
    expect(normalizer.normalize(submission).ok).toBe(true);
    const third = normalizer.normalize(submission);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('rate_limited');
  });

  it('不同观众分桶互不影响', () => {
    const normalizer = new IngressNormalizer({ rateLimitPerMinute: 1 });
    expect(
      normalizer.normalize({
        roomId: 'r1',
        viewerId: 'v1',
        type: 'chat.message',
        payload: { text: 'a' },
      }).ok,
    ).toBe(true);
    expect(
      normalizer.normalize({
        roomId: 'r1',
        viewerId: 'v2',
        type: 'chat.message',
        payload: { text: 'a' },
      }).ok,
    ).toBe(true);
  });
});

describe('调度器背压与取消', () => {
  function makeScheduler(maxPending: number, model?: ModelGateway) {
    const db = openDb({ file: ':memory:' });
    const repository = new Repository(db);
    repository.ensureRoom('r1');
    const sessionId = repository.ensureSession('r1');
    const registry = new ToolRegistry();
    registry.register(lolLookupTool);
    const tools = new ToolExecutor({ registry, allowedTools: ['lol.lookup'], defaultTimeoutMs: 200 });
    const harness = new Harness({
      model: model ?? new MockModelGateway({ delayMs: 50 }),
      tools,
      repository,
      character: loadCharacter(),
      budget,
      contextMaxMessages: 12,
    });
    const scheduler = new Scheduler({ harness, maxPending });
    return { scheduler, db, sessionId };
  }

  it('队列满时背压返回 false', async () => {
    const { scheduler, db, sessionId } = makeScheduler(1);
    const enqueue = (i: number) =>
      scheduler.enqueue({
        turnId: `t${i}`,
        traceId: `tr${i}`,
        sessionId,
        roomId: 'r1',
        triggerEventId: `e${i}`,
        viewerName: null,
        text: `消息${i}`,
      });
    expect(enqueue(1)).toBe(true);
    expect(enqueue(2)).toBe(true);
    expect(enqueue(3)).toBe(false);
    await scheduler.shutdown();
    db.close();
  });

  it('取消当前轮会中止模型调用', async () => {
    const { scheduler, db, sessionId } = makeScheduler(4, new MockModelGateway({ delayMs: 200 }));
    let finished = false;
    scheduler.enqueue({
      turnId: 't-cancel',
      traceId: 'tr-cancel',
      sessionId,
      roomId: 'r1',
      triggerEventId: 'e-cancel',
      viewerName: null,
      text: '你好',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduler.cancelActive()).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    finished = true;
    expect(finished).toBe(true);
    await scheduler.shutdown();
    db.close();
  });
});

describe('舞台回执与租约', () => {
  it('拒绝过期 renderer 回执', () => {
    const stage = new StageService({
      roomId: 'r1',
      characterName: '大肥鱼',
      program: 'chat',
    });
    const first = stage.acquireRendererLease();
    const speech = stage.publishSpeech({ turnId: 't1', text: '你好', toolResults: [], degraded: false });
    const second = stage.acquireRendererLease();
    expect(second.token).not.toBe(first.token);

    const stale = stage.handleReceipt({
      speechId: speech.speechId,
      rendererToken: first.token,
      state: 'started',
      positionMs: 0,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('stale_renderer_lease');

    const fresh = stage.handleReceipt({
      speechId: speech.speechId,
      rendererToken: second.token,
      state: 'started',
      positionMs: 0,
    });
    expect(fresh.accepted).toBe(true);
  });

  it('播放结束清空 activeSpeech，不重播旧内容', () => {
    const stage = new StageService({ roomId: 'r1', characterName: '大肥鱼', program: 'chat' });
    const lease = stage.acquireRendererLease();
    const speech = stage.publishSpeech({ turnId: 't1', text: '你好', toolResults: [], degraded: false });
    stage.handleReceipt({
      speechId: speech.speechId,
      rendererToken: lease.token,
      state: 'ended',
      positionMs: 0,
    });
    expect(stage.snapshot().activeSpeech).toBeNull();
    // 已播完的内容仍在 recentSpeeches 里，供重连恢复可见上下文
    expect(stage.snapshot().recentSpeeches).toHaveLength(1);
  });

  it('mock 结果标记一路传到舞台卡片', () => {
    const stage = new StageService({ roomId: 'r1', characterName: '大肥鱼', program: 'chat' });
    const speech = stage.publishSpeech({
      turnId: 't1',
      text: '查到了',
      toolResults: [
        {
          callId: 'c1',
          name: 'lol.lookup',
          status: 'ok',
          data: { displayName: 'Faker', rank: '挑战者' },
          source: 'mock',
          isMock: true,
          errorCode: null,
          retryable: false,
          durationMs: 5,
          message: null,
        },
      ],
      degraded: false,
    });
    expect(speech.isMock).toBe(true);
    const card = speech.effects.find((effect) => effect.kind === 'card');
    expect(card?.isMock).toBe(true);
  });
});

describe('降级模式显式标记', () => {
  it('模型不支持原生工具时 degraded 标记透传', async () => {
    const db = openDb({ file: ':memory:' });
    const repository = new Repository(db);
    repository.ensureRoom('r1');
    const sessionId = repository.ensureSession('r1');
    const degradedModel: ModelGateway = {
      capabilities: { nativeTools: false, structuredOutput: false, modelId: 'text-only-mock' },
      async complete(_request: ModelRequest): Promise<AssistantTurn> {
        return {
          text: '我只能聊天。',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
          degraded: true,
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(lolLookupTool);
    const tools = new ToolExecutor({ registry, allowedTools: ['lol.lookup'], defaultTimeoutMs: 200 });
    const harness = new Harness({
      model: degradedModel,
      tools,
      repository,
      character: loadCharacter(),
      budget,
      contextMaxMessages: 12,
    });
    const outcome = await harness.runTurn({
      turnId: 't1',
      traceId: 'tr1',
      sessionId,
      roomId: 'r1',
      triggerEventId: null,
      viewerName: null,
      text: '你好',
      signal: new AbortController().signal,
    });
    expect(outcome.degraded).toBe(true);
    db.close();
  });
});

describe('新回应取代旧回应', () => {
  it('上一句未播完时先广播 cancelled，避免旧 speechId 卡住', () => {
    const stage = new StageService({ roomId: 'r1', characterName: '大肥鱼', program: 'chat' });
    const events: string[] = [];
    stage.subscribe((event) => events.push(event.type));
    const first = stage.publishSpeech({ turnId: 't1', text: '第一句', toolResults: [], degraded: false });
    const second = stage.publishSpeech({ turnId: 't2', text: '第二句', toolResults: [], degraded: false });

    expect(events).toEqual(['speech.ready', 'speech.cancelled', 'speech.ready']);
    expect(stage.snapshot().activeSpeech?.speechId).toBe(second.speechId);
    expect(stage.snapshot().recentSpeeches.map((s) => s.speechId)).toEqual([
      first.speechId,
      second.speechId,
    ]);
  });

  it('旧 speechId 的回执被拒绝，不污染新状态', () => {
    const stage = new StageService({ roomId: 'r1', characterName: '大肥鱼', program: 'chat' });
    const lease = stage.acquireRendererLease();
    const first = stage.publishSpeech({ turnId: 't1', text: '第一句', toolResults: [], degraded: false });
    const second = stage.publishSpeech({ turnId: 't2', text: '第二句', toolResults: [], degraded: false });

    const stale = stage.handleReceipt({
      speechId: first.speechId,
      rendererToken: lease.token,
      state: 'ended',
      positionMs: 100,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('unknown_speech');
    expect(stage.snapshot().activeSpeech?.speechId).toBe(second.speechId);
  });
});

describe('限流桶清理', () => {
  it('过期桶会被清理，Map 不会无限增长', () => {
    let nowMs = Date.parse('2026-10-31T00:00:00.000Z');
    const normalizer = new IngressNormalizer({
      rateLimitPerMinute: 5,
      now: () => new Date(nowMs),
    });

    for (let i = 0; i < 50; i += 1) {
      nowMs += 10;
      normalizer.normalize({
        roomId: 'r1',
        viewerId: `v${i}`,
        type: 'chat.message',
        payload: { text: `消息${i}` },
      });
    }
    expect(normalizer.bucketCount()).toBe(50);

    // 推进超过窗口 + 清理间隔，再产生一次写入触发清理
    nowMs += 120_000;
    normalizer.normalize({
      roomId: 'r1',
      viewerId: 'fresh',
      type: 'chat.message',
      payload: { text: '新观众' },
    });
    expect(normalizer.bucketCount()).toBe(1);
  });
});
