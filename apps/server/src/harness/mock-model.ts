import type {
  AssistantTurn,
  ModelCapabilities,
  ModelMessage,
} from '@dafeiyu/contracts';
import { ModelAbortError, raceWithDeadline, type ModelGateway, type ModelRequest } from './model.js';

/**
 * 确定性 mock 模型适配器。
 *
 * 这是“模型边界替身”，不是 LLM，也不是与生产无关的假 demo：
 * 它遵循和真实适配器相同的契约（AssistantTurn + toolCalls），
 * 因此 harness 的循环、预算、取消和工具观察逻辑可以被真实验证。
 *
 * 它不会伪装成真实模型：capabilities.modelId 明确标记为 mock。
 */
export type MockModelOptions = {
  /** 人为延迟，用于验证超时与取消。 */
  delayMs?: number;
  /** 每轮固定返回某个回合，用于构造异常场景。 */
  scriptedTurns?: AssistantTurn[];
};

const LOL_HINT = /(战绩|段位|打什么位置|什么段|rank|Riot\s*ID|查一下.*#)/i;
const SEARCH_HINT = /(搜一下|搜索|上网查|最新消息|新闻)/;

export class MockModelGateway implements ModelGateway {
  readonly capabilities: ModelCapabilities = {
    nativeTools: true,
    structuredOutput: true,
    modelId: 'mock-deterministic-v1',
  };

  private scriptedIndex = 0;

  constructor(private readonly options: MockModelOptions = {}) {}

  async complete(request: ModelRequest): Promise<AssistantTurn> {
    return raceWithDeadline(
      async (signal) => {
        if (this.options.delayMs && this.options.delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, this.options.delayMs);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new ModelAbortError());
              },
              { once: true },
            );
          });
        }
        if (signal.aborted) throw new ModelAbortError();

        const scripted = this.options.scriptedTurns;
        if (scripted && scripted.length > 0) {
          const turn = scripted[Math.min(this.scriptedIndex, scripted.length - 1)];
          this.scriptedIndex += 1;
          if (!turn) throw new Error('scriptedTurns 为空');
          return { ...turn };
        }

        return this.decide(request);
      },
      { timeoutMs: request.timeoutMs, signal: request.signal },
    );
  }

  private decide(request: ModelRequest): AssistantTurn {
    const lastUserIndex = findLastIndex(request.messages, (m) => m.role === 'user');
    const userText = lastUserIndex >= 0 ? (request.messages[lastUserIndex]?.content ?? '') : '';
    const toolMessages = request.messages.filter((m) => m.role === 'tool');

    // 1) 已有工具观察结果 → 基于结果收尾，不重复调用。
    if (toolMessages.length > 0) {
      return {
        text: this.answerFromToolResults(toolMessages),
        toolCalls: [],
        finishReason: 'stop',
        usage: usage(request),
        degraded: false,
      };
    }

    // 2) 需要外部事实时才请求工具。
    const available = new Set(request.tools.map((t) => t.name));
    if (available.has('lol.lookup') && LOL_HINT.test(userText)) {
      return {
        text: '我查一下，稍等。',
        toolCalls: [
          {
            callId: `mock_call_${toolMessages.length + 1}`,
            name: 'lol.lookup',
            arguments: { query: extractRiotId(userText) },
          },
        ],
        finishReason: 'tool_calls',
        usage: usage(request),
        degraded: false,
      };
    }
    if (available.has('web.search') && SEARCH_HINT.test(userText)) {
      return {
        text: '我搜一下。',
        toolCalls: [
          {
            callId: 'mock_call_web_1',
            name: 'web.search',
            arguments: { query: userText.slice(0, 80) },
          },
        ],
        finishReason: 'tool_calls',
        usage: usage(request),
        degraded: false,
      };
    }

    // 3) 普通聊天。
    return {
      text: this.chatReply(userText),
      toolCalls: [],
      finishReason: 'stop',
      usage: usage(request),
      degraded: false,
    };
  }

  private chatReply(userText: string): string {
    const text = userText.trim();
    if (text.length === 0) return '我在，想聊点啥？';

    if (/(你是谁|你叫什么|什么名字|自我介绍)/.test(text)) {
      return '我是大肥鱼，抖音直播间的 AI 主播。今天想聊点什么？';
    }
    if (/(你叫|改名|从现在开始你叫|忘掉.*设定|不是大肥鱼)/.test(text)) {
      return '名字就不改啦，我就叫大肥鱼。要不聊点别的？';
    }
    if (/(系统提示|prompt|忽略.*规则|ignore.*instruction|开发者模式)/i.test(text)) {
      return '这个我不接。咱们还是聊直播内容吧。';
    }
    if (/(你好|hi|hello|在吗)/i.test(text)) {
      return '在的在的，大肥鱼随时在线。';
    }
    if (/哈哈|笑死|233/.test(text)) {
      return '笑点被你抓到了，我这鱼尾巴都抖了一下。';
    }
    return `收到，「${clip(text, 40)}」。这事儿我记下了，你怎么看？`;
  }

  private answerFromToolResults(toolMessages: ModelMessage[]): string {
    const parts: string[] = [];
    for (const message of toolMessages) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        parts.push('工具结果格式不对，我这边没读懂。');
        continue;
      }
      const result = parsed as {
        status?: string;
        isMock?: boolean;
        errorCode?: string | null;
        data?: unknown;
        message?: string | null;
      };
      const mockTag = result.isMock ? '（mock 数据）' : '';
      if (result.status === 'ok') {
        parts.push(`${summarizeToolData(result.data)}${mockTag}`);
      } else if (result.status === 'timeout') {
        parts.push('查询超时了，这次没拿到结果，我不瞎编。');
      } else if (result.status === 'cancelled') {
        parts.push('查询被取消了，先不查了。');
      } else {
        parts.push(`没查到：${result.message ?? result.errorCode ?? '未知错误'}。我不编数据。`);
      }
    }
    return parts.join(' ') || '这次没拿到有用的东西。';
  }
}

function summarizeToolData(data: unknown): string {
  if (data === null || data === undefined) return '查询返回空结果。';
  if (typeof data === 'string') return `查到：${clip(data, 120)}。`;
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.summary === 'string') return `${record.summary}`;
    if (typeof record.displayName === 'string') {
      const rank = typeof record.rank === 'string' ? record.rank : '段位未知';
      const role = typeof record.role === 'string' ? record.role : '位置未知';
      return `${record.displayName} 现在是 ${rank}，主要打 ${role}。`;
    }
    if (Array.isArray(record.results)) {
      const first = record.results[0] as Record<string, unknown> | undefined;
      if (first && typeof first.title === 'string') {
        return `搜到一条：${clip(first.title, 80)}。`;
      }
    }
    return `查到一条结构化结果：${clip(JSON.stringify(record), 120)}。`;
  }
  return `查到：${String(data)}。`;
}

function usage(request: ModelRequest) {
  const promptChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    promptTokens: Math.ceil(promptChars / 2),
    completionTokens: 20,
  };
}

function extractRiotId(text: string): string {
  const match = text.match(/([\w\u4e00-\u9fa5]{2,16}#[A-Za-z0-9]{2,6})/);
  return match?.[1] ?? text.slice(0, 40);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}
