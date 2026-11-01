import type {
  AssistantTurn,
  ModelCapabilities,
  ModelMessage,
  ToolDefinition,
} from '@dafeiyu/contracts';

/**
 * 模型适配层抽象。harness 只依赖这个接口，具体网关协议在适配器内部。
 * 适配器必须遵守 AbortSignal，并在超时/取消时拒绝或返回 cancelled。
 */
export type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  timeoutMs: number;
};

export interface ModelGateway {
  readonly capabilities: ModelCapabilities;
  complete(request: ModelRequest): Promise<AssistantTurn>;
}

export class ModelAbortError extends Error {
  constructor(message = 'model call aborted') {
    super(message);
    this.name = 'ModelAbortError';
  }
}

export class ModelTimeoutError extends Error {
  constructor(message = 'model call timed out') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

/** 在超时与外部取消之间做竞速，供适配器复用。 */
export function raceWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal.aborted) {
    controller.abort();
  } else {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      fn();
    };

    controller.signal.addEventListener(
      'abort',
      () => {
        finish(() => {
          reject(
            options.signal.aborted
              ? new ModelAbortError()
              : new ModelTimeoutError(),
          );
        });
      },
      { once: true },
    );

    work(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
