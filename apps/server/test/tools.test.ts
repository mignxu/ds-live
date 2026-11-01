import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolRequest } from '@dafeiyu/contracts';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry, type ToolImpl } from '../src/tools/registry.js';
import { createLolLookupTool } from '../src/tools/lol-lookup.js';

const lolLookupTool = createLolLookupTool({ adapter: 'mock' });
import { webSearchTool } from '../src/tools/web-search.js';

function ctx(signal = new AbortController().signal, timeoutMs = 1000) {
  return { traceId: 'tr', turnId: 'turn', signal, timeoutMs };
}

function request(name: ToolRequest['name'], args: unknown, callId = 'c1'): ToolRequest {
  return { callId, name, arguments: args };
}

const slowTool: ToolImpl = {
  definition: {
    name: 'game.act',
    description: '慢工具',
    parameters: { type: 'object' },
    readOnly: false,
  },
  argumentsSchema: z.object({}),
  async execute(_args, context) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      context.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    return {
      status: 'ok',
      data: { done: true },
      source: 'mock',
      isMock: true,
      errorCode: null,
      retryable: false,
      message: null,
    };
  },
};

function makeExecutor(allowed = ['lol.lookup', 'web.search'] as const) {
  const registry = new ToolRegistry();
  registry.register(lolLookupTool);
  registry.register(webSearchTool);
  registry.register(slowTool);
  return new ToolExecutor({
    registry,
    allowedTools: allowed as never,
    defaultTimeoutMs: 1000,
  });
}

describe('工具执行器', () => {
  it('成功结果带 source 与 isMock', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(request('lol.lookup', { query: 'Faker#KR1' }), ctx());
    expect(result.status).toBe('ok');
    expect(result.isMock).toBe(true);
    expect(result.source).toBe('mock');
  });

  it('参数非法时不执行并返回 invalid_arguments', async () => {
    const executor = makeExecutor();
    const result = await executor.execute(request('lol.lookup', { query: '' }), ctx());
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('invalid_arguments');
    expect(result.data).toBeNull();
  });

  it('未授权的工具返回 permission_denied', async () => {
    const executor = makeExecutor(['web.search']);
    const result = await executor.execute(request('lol.lookup', { query: 'Faker' }), ctx());
    expect(result.errorCode).toBe('permission_denied');
  });

  it('未注册的工具返回 unknown_tool', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor({
      registry,
      allowedTools: ['lol.lookup'],
      defaultTimeoutMs: 1000,
    });
    const result = await executor.execute(request('lol.lookup', { query: 'x' }), ctx());
    expect(result.errorCode).toBe('unknown_tool');
  });

  it('超时返回 timeout 且不返回伪造数据', async () => {
    const executor = makeExecutor(['game.act']);
    const result = await executor.execute(request('game.act', {}), ctx(undefined, 20));
    expect(result.status).toBe('timeout');
    expect(result.errorCode).toBe('timeout');
    expect(result.data).toBeNull();
    expect(result.retryable).toBe(true);
  });

  it('外部取消返回 cancelled', async () => {
    const executor = makeExecutor(['game.act']);
    const controller = new AbortController();
    const promise = executor.execute(request('game.act', {}), ctx(controller.signal, 5000));
    controller.abort();
    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(result.errorCode).toBe('cancelled');
  });

  it('只暴露白名单内的工具定义', () => {
    const executor = makeExecutor(['web.search']);
    expect(executor.definitions().map((d) => d.name)).toEqual(['web.search']);
  });
});
