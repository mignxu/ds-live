import { z } from 'zod';
import type { ToolImpl } from './registry.js';

/**
 * web.search：只读联网搜索。
 * 真实搜索服务未选定，当前为 mock；结果结构与 lol.lookup 不同（数组 + 摘要），
 * 用于验证 harness 能处理多种工具结果形态。
 */
const ArgumentsSchema = z.object({
  query: z.string().trim().min(1).max(120),
});

export const webSearchTool: ToolImpl = {
  definition: {
    name: 'web.search',
    description: '搜索公开网页信息，返回若干条标题与摘要。只读，不做页面抓取。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  argumentsSchema: ArgumentsSchema,
  async execute(args) {
    const { query } = ArgumentsSchema.parse(args);
    return {
      status: 'ok',
      data: {
        query,
        results: [
          {
            title: `关于「${query.slice(0, 30)}」的 mock 搜索结果`,
            url: 'https://example.invalid/mock-result',
            snippet: '这是 mock 搜索适配器返回的占位摘要，不代表真实网页内容。',
          },
        ],
      },
      source: 'mock',
      isMock: true,
      errorCode: null,
      retryable: false,
      message: null,
    };
  },
};
