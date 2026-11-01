import type { ModelMessage, ToolRequest, ToolResult } from '@dafeiyu/contracts';
import type { Repository, StoredMessage } from '../storage/repository.js';

/**
 * 会话上下文装配。
 *
 * 分界：
 * - 身份（system）来自角色配置，不可被观众覆盖；
 * - 会话消息按 session 隔离，窗口长度受限；
 * - 工具结果作为 trusted=false 的数据消息附加，不拼进身份文本。
 *
 * 工具请求与结果必须成对出现（assistant.tool_calls → tool 消息），
 * 否则 OpenAI 兼容网关会拒绝请求。因此按“轮”组织，而不是只追加结果。
 */
export type ToolRound = {
  requests: ToolRequest[];
  results: ToolResult[];
};

export type ContextInput = {
  systemPrompt: string;
  sessionId: string;
  /**
   * 记忆摘要（来自观众明说或主播设置）。
   * 作为独立的 system 片段附加，不拼进角色身份正文。
   */
  memoryDigest?: string;
  /** 当前轮次 ID：该轮已落库的用户消息不重复拼进上下文。 */
  currentTurnId: string;
  /** 当前触发本轮的观众输入。 */
  currentUser: { viewerName: string | null; text: string };
  /** 本轮已经发生的工具往返，按发生顺序。 */
  toolRounds: ToolRound[];
  maxMessages: number;
};

export function buildModelMessages(
  input: ContextInput,
  repository: Repository,
): ModelMessage[] {
  const history: StoredMessage[] = repository
    .recentMessages(input.sessionId, Math.max(2, input.maxMessages - 2))
    // 本轮用户消息由 currentUser 单独提供，避免重复。
    .filter((message) => message.turnId !== input.currentTurnId);

  const messages: ModelMessage[] = [
    { role: 'system', content: input.systemPrompt, trusted: true },
  ];

  // 记忆单独一条 system：可被观众纠正/清除，语义上不等于角色身份。
  if (input.memoryDigest && input.memoryDigest.trim().length > 0) {
    messages.push({
      role: 'system',
      content: `${input.memoryDigest}
（这些偏好可能过时，观众纠正时以最新说法为准。）`,
      trusted: false,
    });
  }

  for (const message of history) {
    messages.push({
      role: message.role,
      content: message.text,
      trusted: message.role === 'assistant',
    });
  }

  messages.push({
    role: 'user',
    content: input.currentUser.viewerName
      ? `${input.currentUser.viewerName}：${input.currentUser.text}`
      : input.currentUser.text,
    trusted: false,
  });

  for (const round of input.toolRounds) {
    // 先放 assistant 的请求，再放对应结果，保证 tool_call_id 有对应项。
    messages.push({
      role: 'assistant',
      content: '',
      trusted: true,
      toolCalls: round.requests,
    });
    for (const result of round.results) {
      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        trusted: false,
        toolCallId: result.callId,
        name: result.name,
      });
    }
  }

  return messages;
}
