import type {
  AssistantTurn,
  ModelCapabilities,
  ModelMessage,
  ToolDefinition,
} from '@dafeiyu/contracts';
import { ToolRequestSchema } from '@dafeiyu/contracts';
import { ModelAbortError, ModelTimeoutError, raceWithDeadline, type ModelGateway, type ModelRequest } from './model.js';

/**
 * hs-gw 适配器。
 *
 * 重要：hs-gw 的真实协议尚未核实（见 docs/references.md）。
 * 这里按「OpenAI 兼容 chat completions + tools」的公开常见形态实现，
 * 属于待核实的假设，不是已验证事实。协议不一致时只改这一个文件。
 *
 * 凭证缺失时不静默降级：抛出 not_configured，由上层显式切换到 mock 并标记降级。
 */
export type HsGwConfig = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
};

type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class HsGwModelGateway implements ModelGateway {
  readonly capabilities: ModelCapabilities;

  constructor(private readonly config: HsGwConfig) {
    this.capabilities = {
      nativeTools: true,
      structuredOutput: true,
      modelId: config.modelId,
    };
  }

  async complete(request: ModelRequest): Promise<AssistantTurn> {
    return raceWithDeadline(
      async (signal) => {
        const body = {
          model: this.config.modelId,
          messages: request.messages.map(toOpenAiMessage),
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: 'auto',
          temperature: 0.8,
          max_tokens: 400,
        };

        let response: Response;
        try {
          response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw new ModelAbortError();
          throw error;
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`hs-gw 返回 ${response.status}: ${detail.slice(0, 200)}`);
        }

        const json = (await response.json()) as OpenAiResponse;
        const choice = json.choices?.[0];
        if (!choice) throw new Error('hs-gw 响应缺少 choices');

        const rawToolCalls = choice.message?.tool_calls ?? [];
        const toolCalls = rawToolCalls.flatMap((call, index) => {
          const name = call.function?.name;
          if (!name) return [];
          let args: unknown = {};
          try {
            args = JSON.parse(call.function?.arguments ?? '{}');
          } catch {
            args = {};
          }
          const parsed = ToolRequestSchema.safeParse({
            callId: call.id ?? `hs_gw_call_${index + 1}`,
            name,
            arguments: args,
          });
          return parsed.success ? [parsed.data] : [];
        });

        return {
          text: choice.message?.content ?? '',
          toolCalls,
          finishReason: normalizeFinishReason(choice.finish_reason, toolCalls.length > 0),
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? null,
            completionTokens: json.usage?.completion_tokens ?? null,
          },
          degraded: false,
        };
      },
      { timeoutMs: request.timeoutMs, signal: request.signal },
    );
  }
}

/**
 * 把内部 ModelMessage 映射成 OpenAI 兼容消息。
 *
 * 关键点：工具请求与结果必须成对。
 * - assistant 带 tool_calls（每个 call 有 id + function.name/arguments）
 * - 随后每个 tool 消息带 tool_call_id，且 content 是字符串
 * 缺任何一边，真实网关会直接 400。
 */
function toOpenAiMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? 'unknown_call',
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): AssistantTurn['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'stop';
  return 'stop';
}

export { ModelAbortError, ModelTimeoutError };

export type ToolDefinitions = ToolDefinition[];
