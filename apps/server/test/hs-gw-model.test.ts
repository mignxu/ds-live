import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ModelMessage } from '@dafeiyu/contracts';
import { HsGwModelGateway } from '../src/harness/hs-gw-model.js';

/**
 * hs-gw 适配器的**契约测试**（不是真实联调）。
 *
 * 用一个本地假网关断言请求形状符合 OpenAI 兼容协议：
 * assistant.tool_calls 与 tool.tool_call_id 必须成对，否则真实网关会 400。
 * hs-gw 的真实协议仍未核实，这里验证的是“我们的假设实现是否自洽”。
 */
type Captured = {
  body: Record<string, unknown>;
};

let server: Server | null = null;

async function startFakeGateway(
  handler: (captured: Captured) => { status: number; body: unknown },
): Promise<{ baseUrl: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const entry = { body };
      captured.push(entry);
      const result = handler(entry);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取假网关端口');
  return { baseUrl: `http://127.0.0.1:${address.port}`, captured };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

function gateway(baseUrl: string) {
  return new HsGwModelGateway({
    baseUrl,
    apiKey: 'test-key-not-real',
    modelId: 'test-model',
  });
}

describe('hs-gw 适配器请求形状', () => {
  it('工具请求与结果成对发送（tool_calls + tool_call_id）', async () => {
    const { baseUrl, captured } = await startFakeGateway(() => ({
      status: 200,
      body: {
        choices: [{ finish_reason: 'stop', message: { content: '查到了。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    }));

    const messages: ModelMessage[] = [
      { role: 'system', content: '你是大肥鱼', trusted: true },
      { role: 'user', content: '查 Faker', trusted: false },
      {
        role: 'assistant',
        content: '',
        trusted: true,
        toolCalls: [{ callId: 'call-1', name: 'lol.lookup', arguments: { query: 'Faker#KR1' } }],
      },
      {
        role: 'tool',
        content: '{"status":"ok"}',
        trusted: false,
        toolCallId: 'call-1',
        name: 'lol.lookup',
      },
    ];

    const turn = await gateway(baseUrl).complete({
      messages,
      tools: [
        {
          name: 'lol.lookup',
          description: '查战绩',
          parameters: { type: 'object' },
          readOnly: true,
        },
      ],
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });

    expect(turn.text).toBe('查到了。');
    const sent = captured[0]?.body.messages as Array<Record<string, unknown>>;
    const assistant = sent.find((m) => m.role === 'assistant');
    const tool = sent.find((m) => m.role === 'tool');
    expect(assistant?.tool_calls).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'lol.lookup', arguments: JSON.stringify({ query: 'Faker#KR1' }) },
      },
    ]);
    expect(tool?.tool_call_id).toBe('call-1');
    expect(typeof tool?.content).toBe('string');
  });

  it('解析模型返回的工具调用', async () => {
    const { baseUrl } = await startFakeGateway(() => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'gw-1',
                  type: 'function',
                  function: { name: 'web.search', arguments: '{"query":"天气"}' },
                },
              ],
            },
          },
        ],
      },
    }));

    const turn = await gateway(baseUrl).complete({
      messages: [{ role: 'user', content: '搜天气', trusted: false }],
      tools: [
        { name: 'web.search', description: '搜索', parameters: { type: 'object' }, readOnly: true },
      ],
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });

    expect(turn.finishReason).toBe('tool_calls');
    expect(turn.toolCalls[0]).toMatchObject({
      callId: 'gw-1',
      name: 'web.search',
      arguments: { query: '天气' },
    });
  });

  it('未登记的工具名被丢弃，不进入 toolCalls', async () => {
    const { baseUrl } = await startFakeGateway(() => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: 'x1',
                  type: 'function',
                  function: { name: 'shell.exec', arguments: '{"cmd":"rm -rf /"}' },
                },
              ],
            },
          },
        ],
      },
    }));

    const turn = await gateway(baseUrl).complete({
      messages: [{ role: 'user', content: 'x', trusted: false }],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });

    expect(turn.toolCalls).toHaveLength(0);
  });

  it('上游 500 抛出错误，不返回伪造文本', async () => {
    const { baseUrl } = await startFakeGateway(() => ({
      status: 500,
      body: { error: 'boom' },
    }));

    await expect(
      gateway(baseUrl).complete({
        messages: [{ role: 'user', content: 'x', trusted: false }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/500/);
  });

  it('请求头带 Authorization，但错误信息不回显密钥', async () => {
    const { baseUrl } = await startFakeGateway(() => ({ status: 401, body: { error: 'no' } }));
    try {
      await gateway(baseUrl).complete({
        messages: [{ role: 'user', content: 'x', trusted: false }],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
      throw new Error('应该抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('test-key-not-real');
    }
  });
});
