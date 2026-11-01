import type { AssistantTurn, ToolResult } from '@dafeiyu/contracts';
import type { CharacterBundle } from '../conversation/character.js';
import { buildSystemMessage } from '../conversation/character.js';
import { buildModelMessages, type ToolRound } from '../conversation/context.js';
import type { Repository } from '../storage/repository.js';
import type { ModelGateway } from './model.js';
import { ModelAbortError, ModelTimeoutError } from './model.js';
import type { ToolExecutor } from '../tools/executor.js';
import { errorResult } from '../tools/registry.js';

export type BudgetConfig = {
  maxModelCallsPerTurn: number;
  maxToolCallsPerTurn: number;
  modelTimeoutMs: number;
  toolTimeoutMs: number;
  turnDeadlineMs: number;
};

export type TurnInput = {
  turnId: string;
  traceId: string;
  sessionId: string;
  roomId: string;
  /** 触发本轮的事件 ID，用于从 turn 反查原始事件。 */
  triggerEventId: string | null;
  /** 观众 ID：用于加载观众级记忆；匿名时为 null。 */
  viewerId: string | null;
  viewerName: string | null;
  text: string;
  signal: AbortSignal;
};

export type TurnOutcome = {
  turnId: string;
  text: string;
  finishReason: AssistantTurn['finishReason'] | 'budget_exceeded' | 'deadline_exceeded';
  modelCalls: number;
  toolCalls: number;
  toolResults: ToolResult[];
  degraded: boolean;
  errorCode: string | null;
};

export type HarnessOptions = {
  model: ModelGateway;
  tools: ToolExecutor;
  repository: Repository;
  character: CharacterBundle;
  budget: BudgetConfig;
  contextMaxMessages: number;
  /**
   * 记忆加载器：返回要放进上下文的记忆摘要。
   * 缺省为空（不影响无记忆场景）。
   */
  loadMemoryDigest?: (input: {
    roomId: string;
    sessionId: string;
    viewerId: string | null;
  }) => string;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

/**
 * 有界 harness 循环：模型 → 工具 → 观察结果 → 再回应。
 *
 * 硬边界（不可由模型或观众放宽）：
 * - 每轮模型调用次数、工具执行次数上限；
 * - 单次模型/工具超时 + 整轮截止时间，截止时间优先；
 * - 取消信号贯穿模型与工具；
 * - 重复的 callId 不重复执行，避免模型自激循环；
 * - 工具失败作为结果返回模型，不自动重试、不编造数据。
 */
export class Harness {
  private readonly now: () => Date;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(private readonly options: HarnessOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? (() => undefined);
  }

  async runTurn(input: TurnInput): Promise<TurnOutcome> {
    const { repository, budget } = this.options;
    const deadline = Date.now() + budget.turnDeadlineMs;
    const toolResults: ToolResult[] = [];
    // 按轮保存“请求 → 结果”，保证回灌上下文时 tool_call_id 成对。
    const toolRounds: ToolRound[] = [];
    const executedCallIds = new Set<string>();
    let modelCalls = 0;
    let toolCalls = 0;
    let lastTurn: AssistantTurn | null = null;
    let finishReason: TurnOutcome['finishReason'] = 'stop';
    let errorCode: string | null = null;

    repository.createTurn({
      id: input.turnId,
      sessionId: input.sessionId,
      roomId: input.roomId,
      triggerEventId: input.triggerEventId,
      traceId: input.traceId,
      now: this.now(),
    });
    repository.appendMessage({
      sessionId: input.sessionId,
      role: 'user',
      text: input.viewerName ? `${input.viewerName}：${input.text}` : input.text,
      viewerId: null,
      turnId: input.turnId,
      now: this.now(),
    });

    const systemPrompt = buildSystemMessage(this.options.character, [
      `- 当前节目：chat。`,
      `- 角色版本：${this.options.character.profile.version}。`,
    ]);

    // 记忆只作为“可能过时的偏好”附加，不改变身份与权限。
    const memoryDigest =
      this.options.loadMemoryDigest?.({
        roomId: input.roomId,
        sessionId: input.sessionId,
        viewerId: input.viewerId,
      }) ?? '';

    try {
      while (true) {
        if (input.signal.aborted) {
          finishReason = 'cancelled';
          errorCode = 'cancelled';
          break;
        }
        if (Date.now() >= deadline) {
          finishReason = 'deadline_exceeded';
          errorCode = 'deadline_exceeded';
          break;
        }
        if (modelCalls >= budget.maxModelCallsPerTurn) {
          finishReason = 'budget_exceeded';
          errorCode = 'model_budget_exceeded';
          break;
        }

        const remainingMs = Math.max(1, deadline - Date.now());
        const messages = buildModelMessages(
          {
            systemPrompt,
            sessionId: input.sessionId,
            memoryDigest,
            currentTurnId: input.turnId,
            currentUser: { viewerName: input.viewerName, text: input.text },
            toolRounds,
            maxMessages: this.options.contextMaxMessages,
          },
          repository,
        );

        modelCalls += 1;
        const turn = await this.options.model.complete({
          messages,
          tools: this.options.tools.definitions(),
          signal: input.signal,
          timeoutMs: Math.min(budget.modelTimeoutMs, remainingMs),
        });
        lastTurn = turn;
        this.log({
          event: 'model.call',
          turnId: input.turnId,
          traceId: input.traceId,
          modelId: this.options.model.capabilities.modelId,
          modelCall: modelCalls,
          toolCallsRequested: turn.toolCalls.length,
          finishReason: turn.finishReason,
        });

        if (turn.toolCalls.length === 0) {
          finishReason = turn.finishReason;
          break;
        }

        // 模型请求了工具：逐个执行，超出预算的请求明确拒绝并回报。
        let executedThisRound = 0;
        const roundRequests = turn.toolCalls;
        const roundResults: ToolResult[] = [];
        for (const request of turn.toolCalls) {
          if (input.signal.aborted) {
            finishReason = 'cancelled';
            errorCode = 'cancelled';
            break;
          }
          if (Date.now() >= deadline) {
            finishReason = 'deadline_exceeded';
            errorCode = 'deadline_exceeded';
            break;
          }

          if (executedCallIds.has(request.callId)) {
            // 重复请求同一个 callId：不再执行，避免自激。
            const duplicate = errorResult(
              request.name,
              request.callId,
              'invalid_arguments',
              '重复的 callId，已忽略',
              { durationMs: 0 },
            );
            toolResults.push(duplicate);
            roundResults.push(duplicate);
            continue;
          }

          if (toolCalls >= budget.maxToolCallsPerTurn) {
            const overBudget = errorResult(
              request.name,
              request.callId,
              'budget_exceeded',
              '本轮工具预算已用尽',
              { durationMs: 0 },
            );
            toolResults.push(overBudget);
            roundResults.push(overBudget);
            continue;
          }

          executedCallIds.add(request.callId);
          toolCalls += 1;
          executedThisRound += 1;
          const result = await this.options.tools.execute(request, {
            traceId: input.traceId,
            turnId: input.turnId,
            signal: input.signal,
            timeoutMs: Math.min(budget.toolTimeoutMs, Math.max(1, deadline - Date.now())),
          });
          toolResults.push(result);
          roundResults.push(result);
          repository.recordToolCall({
            id: `${input.turnId}:${request.callId}`,
            turnId: input.turnId,
            request,
            result,
            now: this.now(),
          });
          this.log({
            event: 'tool.result',
            turnId: input.turnId,
            traceId: input.traceId,
            tool: request.name,
            status: result.status,
            errorCode: result.errorCode,
            isMock: result.isMock,
            durationMs: result.durationMs,
          });
        }

        if (roundResults.length > 0) {
          toolRounds.push({ requests: roundRequests, results: roundResults });
        }
        repository.updateTurn(input.turnId, { modelCalls, toolCalls });
        if (finishReason === 'cancelled' || finishReason === 'deadline_exceeded') break;
        if (executedThisRound === 0) {
          // 本轮所有请求都被拒绝，继续循环只会重复，直接收尾。
          // 若拒绝原因是工具预算耗尽，如实标记为预算上限，而不是普通结束。
          finishReason = toolCalls >= budget.maxToolCallsPerTurn ? 'budget_exceeded' : 'stop';
          errorCode = toolCalls >= budget.maxToolCallsPerTurn ? 'tool_budget_exceeded' : 'tool_requests_rejected';
          break;
        }
      }
    } catch (error) {
      if (error instanceof ModelAbortError) {
        finishReason = 'cancelled';
        errorCode = 'cancelled';
      } else if (error instanceof ModelTimeoutError) {
        // 分项超时与整轮截止区分开：剩余时间耗尽时归为截止时间，不误报成上游故障。
        if (Date.now() >= deadline) {
          finishReason = 'deadline_exceeded';
          errorCode = 'deadline_exceeded';
        } else {
          finishReason = 'error';
          errorCode = 'model_timeout';
        }
      } else {
        finishReason = 'error';
        errorCode = 'model_error';
        this.log({
          event: 'model.error',
          turnId: input.turnId,
          traceId: input.traceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finalText = this.resolveFinalText(lastTurn, toolResults, finishReason, errorCode);
    const degraded = lastTurn?.degraded ?? false;
    const endedAt = this.now();
    const cancelled = finishReason === 'cancelled';

    repository.updateTurn(input.turnId, {
      phase: cancelled ? 'CANCELLED' : finishReason === 'error' ? 'FAILED' : 'COMPLETED',
      modelCalls,
      toolCalls,
      finishReason,
      errorCode,
      degraded,
      endedAt: endedAt.toISOString(),
    });
    // 被取消的轮次不落助手消息、不入舞台：没有完成的回应不应该被说出来。
    if (!cancelled) {
      repository.appendMessage({
        sessionId: input.sessionId,
        role: 'assistant',
        text: finalText,
        turnId: input.turnId,
        now: endedAt,
      });
    }
    repository.touchSession(input.sessionId, endedAt);

    return {
      turnId: input.turnId,
      text: finalText,
      finishReason,
      modelCalls,
      toolCalls,
      toolResults,
      degraded,
      errorCode,
    };
  }

  /** 收尾文本：优先模型文本；预算/超时/取消时给出不编造的兜底台词。 */
  private resolveFinalText(
    lastTurn: AssistantTurn | null,
    toolResults: ToolResult[],
    finishReason: TurnOutcome['finishReason'],
    errorCode: string | null,
  ): string {
    const modelText = lastTurn?.text.trim() ?? '';

    if (finishReason === 'cancelled') {
      return modelText || '这轮先不说了。';
    }
    // 预算/截止中断时，最后一轮模型输出往往只是“我查一下，稍等”这类过渡语。
    // 把它当成最终台词会变成空头承诺（说了要查却没查），因此这类情况丢弃它。
    const lastTurnWasInterim = (lastTurn?.toolCalls.length ?? 0) > 0;

    if (finishReason === 'deadline_exceeded') {
      if (lastTurnWasInterim) return '这次查得有点久，先不查了。';
      return modelText || '想得有点久，这轮我先不展开了。';
    }
    if (finishReason === 'budget_exceeded') {
      if (lastTurnWasInterim) return '这轮调用次数到上限了，先不查了，我们聊点别的？';
      return modelText || '这轮调用次数到上限了，我们换个话题？';
    }
    if (errorCode === 'model_timeout') {
      return '我这边想太久超时了，你再说一次？';
    }
    if (errorCode === 'model_error') {
      return '我这边有点卡住了，稍后再试。';
    }
    if (modelText.length > 0) return modelText;

    const anyMock = toolResults.some((result) => result.isMock);
    const failed = toolResults.filter((result) => result.status !== 'ok');
    if (failed.length > 0) {
      return `这次没查到有用的东西${anyMock ? '（mock 数据）' : ''}，我不编。`;
    }
    return '我在，继续说。';
  }
}
