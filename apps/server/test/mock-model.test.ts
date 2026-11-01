import { describe, expect, it } from 'vitest';
import type { AssistantTurn, ModelMessage, ToolDefinition } from '@dafeiyu/contracts';
import { MockModelGateway } from '../src/harness/mock-model.js';
import type { ModelGateway, ModelRequest } from '../src/harness/model.js';
import { ModelAbortError } from '../src/harness/model.js';

const toolDefinitions: ToolDefinition[] = [
  {
    name: 'lol.lookup',
    description: '查战绩',
    parameters: { type: 'object' },
    readOnly: true,
  },
  {
    name: 'web.search',
    description: '搜索',
    parameters: { type: 'object' },
    readOnly: true,
  },
];

function request(messages: ModelMessage[], signal = new AbortController().signal): ModelRequest {
  return { messages, tools: toolDefinitions, signal, timeoutMs: 1000 };
}

describe('mock 模型适配器', () => {
  it('普通聊天不调用工具', async () => {
    const model = new MockModelGateway();
    const turn = await model.complete(
      request([{ role: 'user', content: '哈哈哈哈', trusted: false }]),
    );
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.finishReason).toBe('stop');
  });

  it('提到战绩时请求 lol.lookup', async () => {
    const model = new MockModelGateway();
    const turn = await model.complete(
      request([{ role: 'user', content: '帮我看看 Faker#KR1 什么段位', trusted: false }]),
    );
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe('lol.lookup');
    expect(turn.finishReason).toBe('tool_calls');
  });

  it('已有工具结果时基于结果回答，不重复调用', async () => {
    const model = new MockModelGateway();
    const turn = await model.complete(
      request([
        { role: 'user', content: '查 Faker', trusted: false },
        {
          role: 'tool',
          content: JSON.stringify({
            callId: 'c1',
            name: 'lol.lookup',
            status: 'ok',
            data: { displayName: 'Faker', rank: '挑战者 1120 LP', role: '中单' },
            isMock: true,
          }),
          trusted: false,
          toolCallId: 'c1',
        },
      ]),
    );
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.text).toContain('Faker');
    expect(turn.text).toContain('mock');
  });

  it('工具失败时不编造数据', async () => {
    const model = new MockModelGateway();
    const turn = await model.complete(
      request([
        { role: 'user', content: '查 zzz', trusted: false },
        {
          role: 'tool',
          content: JSON.stringify({
            callId: 'c1',
            name: 'lol.lookup',
            status: 'error',
            data: null,
            isMock: true,
            errorCode: 'upstream_error',
            message: 'mock 数据源中没有这个玩家',
          }),
          trusted: false,
        },
      ]),
    );
    expect(turn.text).toContain('没查到');
    expect(turn.text).not.toMatch(/挑战者|白金/);
  });

  it('延迟超过超时会被中断', async () => {
    const model = new MockModelGateway({ delayMs: 200 });
    await expect(
      model.complete({
        messages: [{ role: 'user', content: 'hi', trusted: false }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('外部取消会中止调用', async () => {
    const model = new MockModelGateway({ delayMs: 200 });
    const controller = new AbortController();
    const promise = model.complete({
      messages: [{ role: 'user', content: 'hi', trusted: false }],
      tools: [],
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ModelAbortError);
  });

  it('模型能力声明为 mock，不冒充真实模型', () => {
    const model: ModelGateway = new MockModelGateway();
    expect(model.capabilities.modelId).toContain('mock');
  });

  it('脚本化回合可以模拟任意异常返回', async () => {
    const scripted: AssistantTurn[] = [
      {
        text: '',
        toolCalls: [{ callId: 'x1', name: 'lol.lookup', arguments: { query: 'a' } }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 1, completionTokens: 1 },
        degraded: false,
      },
    ];
    const model = new MockModelGateway({ scriptedTurns: scripted });
    const turn = await model.complete(request([{ role: 'user', content: '任意', trusted: false }]));
    expect(turn.toolCalls[0]?.callId).toBe('x1');
  });
});
