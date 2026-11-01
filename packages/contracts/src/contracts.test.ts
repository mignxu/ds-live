import { describe, expect, it } from 'vitest';
import {
  AssistantTurnSchema,
  EventEnvelopeSchema,
  IngressSubmissionSchema,
  MAX_MESSAGE_LENGTH,
  PlaybackReceiptSchema,
  SCHEMA_VERSION,
  ToolResultSchema,
} from '../src/index.js';

describe('ingress 提交校验', () => {
  it('裁剪空白并接受正常弹幕', () => {
    const parsed = IngressSubmissionSchema.parse({
      roomId: 'room-1',
      type: 'chat.message',
      payload: { text: '  大肥鱼在吗  ', viewerName: '观众A' },
    });
    expect(parsed.type).toBe('chat.message');
    expect(parsed.payload).toMatchObject({ text: '大肥鱼在吗' });
  });

  it('拒绝超长与空白弹幕', () => {
    expect(() =>
      IngressSubmissionSchema.parse({
        roomId: 'room-1',
        type: 'chat.message',
        payload: { text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      }),
    ).toThrow();
    expect(() =>
      IngressSubmissionSchema.parse({
        roomId: 'room-1',
        type: 'chat.message',
        payload: { text: '   ' },
      }),
    ).toThrow();
  });

  it('拒绝未知事件类型', () => {
    expect(() =>
      IngressSubmissionSchema.parse({
        roomId: 'room-1',
        type: 'chat.execute_shell',
        payload: { text: 'rm -rf /' },
      }),
    ).toThrow();
  });
});

describe('工具结果契约', () => {
  it('失败结果必须是 errorCode 且 data 为空', () => {
    const result = ToolResultSchema.parse({
      callId: 'c1',
      name: 'lol.lookup',
      status: 'error',
      data: null,
      source: 'mock',
      isMock: true,
      errorCode: 'timeout',
      retryable: true,
      durationMs: 8000,
      message: '上游超时',
    });
    expect(result.data).toBeNull();
    expect(result.errorCode).toBe('timeout');
  });

  it('拒绝未登记的工具名', () => {
    expect(() =>
      ToolResultSchema.parse({
        callId: 'c2',
        name: 'shell.exec',
        status: 'ok',
        data: {},
        source: 'local',
        isMock: false,
        errorCode: null,
        retryable: false,
        durationMs: 1,
        message: null,
      }),
    ).toThrow();
  });
});

describe('模型回合契约', () => {
  it('默认不是降级模式，且工具请求必须带 callId', () => {
    const turn = AssistantTurnSchema.parse({
      text: '我在。',
      toolCalls: [{ callId: 'call-1', name: 'web.search', arguments: { query: '天气' } }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 12, completionTokens: 4 },
    });
    expect(turn.degraded).toBe(false);
    expect(turn.toolCalls).toHaveLength(1);
  });

  it('拒绝空 callId', () => {
    expect(() =>
      AssistantTurnSchema.parse({
        text: '',
        toolCalls: [{ callId: '', name: 'web.search', arguments: {} }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    ).toThrow();
  });
});

describe('舞台契约', () => {
  it('回执默认进度为 0 且需要 rendererToken', () => {
    const receipt = PlaybackReceiptSchema.parse({
      speechId: 's1',
      rendererToken: 'r1',
      state: 'started',
    });
    expect(receipt.positionMs).toBe(0);
  });

  it('信封要求固定 schemaVersion', () => {
    expect(() =>
      EventEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION + 1,
        eventId: 'e1',
        roomId: 'r1',
        sessionId: 's1',
        viewerId: 'v1',
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        traceId: 't1',
        type: 'chat.message',
        payload: {},
      }),
    ).toThrow();
  });
});
