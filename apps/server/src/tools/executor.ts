import type { ToolName, ToolRequest, ToolResult } from '@dafeiyu/contracts';
import type { ToolContext, ToolRegistry } from './registry.js';
import { errorResult } from './registry.js';

/**
 * 工具执行器：模型提出的请求在这里被校验、授权、限时执行并封装成 ToolResult。
 * 关键边界：
 * - 工具名必须在注册表中，否则拒绝；
 * - 参数按宿主 schema 校验，模型无法绕过；
 * - 遵守 AbortSignal，超时/取消有明确结果，不无限重试；
 * - 结果始终带 source 与 isMock，失败不返回伪造数据。
 */
export type ToolExecutorOptions = {
  registry: ToolRegistry;
  /** 允许模型调用的工具白名单；空数组表示不允许任何工具。 */
  allowedTools: readonly ToolName[];
  defaultTimeoutMs: number;
  now?: () => number;
};

export class ToolExecutor {
  private readonly now: () => number;

  constructor(private readonly options: ToolExecutorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get registry(): ToolRegistry {
    return this.options.registry;
  }

  /** 模型可见的工具定义：只暴露白名单内的工具。 */
  definitions() {
    return this.options.registry
      .definitions()
      .filter((definition) => this.options.allowedTools.includes(definition.name));
  }

  async execute(request: ToolRequest, context: ToolContext): Promise<ToolResult> {
    const started = this.now();

    if (!this.options.allowedTools.includes(request.name)) {
      return errorResult(request.name, request.callId, 'permission_denied', '该工具未对本节目开放', {
        durationMs: this.now() - started,
      });
    }

    const impl = this.options.registry.get(request.name);
    if (!impl) {
      return errorResult(request.name, request.callId, 'unknown_tool', '工具未注册', {
        durationMs: this.now() - started,
      });
    }

    const parsed = impl.argumentsSchema.safeParse(request.arguments);
    if (!parsed.success) {
      return errorResult(
        request.name,
        request.callId,
        'invalid_arguments',
        `参数不合法：${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`,
        { durationMs: this.now() - started },
      );
    }

    if (context.signal.aborted) {
      return errorResult(request.name, request.callId, 'cancelled', '执行前已取消', {
        durationMs: this.now() - started,
      });
    }

    const timeoutMs = Math.min(context.timeoutMs, this.options.defaultTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    // 竞态窗口：检查之后、监听器注册之前信号可能已经中止，addEventListener 不会再触发。
    if (context.signal.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let rejectOnAbort: (() => void) | null = null;

    try {
      const execution = await Promise.race([
        impl.execute(parsed.data, { ...context, signal: controller.signal, timeoutMs }),
        new Promise<never>((_, reject) => {
          rejectOnAbort = () => reject(new AbortLikeError(timedOut ? 'timeout' : 'cancelled'));
          controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
          // 同理：注册前已中止时手动触发一次，避免工具忽略信号时永久挂起。
          if (controller.signal.aborted) rejectOnAbort();
        }),
      ]);

      const durationMs = this.now() - started;
      return {
        callId: request.callId,
        name: request.name,
        status: execution.status === 'ok' ? 'ok' : 'error',
        data: execution.status === 'ok' ? execution.data : null,
        source: execution.source,
        isMock: execution.isMock,
        errorCode: execution.errorCode,
        retryable: execution.retryable,
        durationMs,
        message: execution.message,
      };
    } catch (error) {
      const durationMs = this.now() - started;
      if (error instanceof AbortLikeError) {
        return error instanceof AbortLikeError && error.reason === 'timeout'
          ? errorResult(request.name, request.callId, 'timeout', `工具执行超过 ${timeoutMs}ms`, {
              durationMs,
              retryable: true,
            })
          : errorResult(request.name, request.callId, 'cancelled', '工具执行被取消', {
              durationMs,
              retryable: false,
            });
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(request.name, request.callId, 'upstream_error', message.slice(0, 300), {
        durationMs,
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }
}

class AbortLikeError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled') {
    super(reason);
    this.name = 'AbortLikeError';
  }
}
