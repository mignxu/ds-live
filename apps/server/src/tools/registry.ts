import { z } from 'zod';
import type { ToolDefinition, ToolName, ToolResult } from '@dafeiyu/contracts';

/** 工具执行上下文：由宿主注入，模型无法伪造。 */
export type ToolContext = {
  traceId: string;
  turnId: string;
  signal: AbortSignal;
  timeoutMs: number;
};

export type ToolExecution = {
  status: 'ok' | 'error';
  data: unknown;
  source: ToolResult['source'];
  isMock: boolean;
  errorCode: ToolResult['errorCode'];
  retryable: boolean;
  message: string | null;
};

export type ToolImpl = {
  definition: ToolDefinition;
  /** 宿主侧 zod 校验，模型参数一律不可信。 */
  argumentsSchema: z.ZodType<unknown>;
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolExecution>;
};

export class ToolRegistry {
  private readonly tools = new Map<ToolName, ToolImpl>();

  register(impl: ToolImpl): void {
    if (this.tools.has(impl.definition.name)) {
      throw new Error(`工具重复注册：${impl.definition.name}`);
    }
    this.tools.set(impl.definition.name, impl);
  }

  has(name: string): boolean {
    return this.tools.has(name as ToolName);
  }

  get(name: string): ToolImpl | undefined {
    return this.tools.get(name as ToolName);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  names(): ToolName[] {
    return [...this.tools.keys()];
  }
}

export function errorResult(
  name: ToolName,
  callId: string,
  errorCode: NonNullable<ToolResult['errorCode']>,
  message: string,
  options: { durationMs: number; retryable?: boolean; source?: ToolResult['source'] },
): ToolResult {
  return {
    callId,
    name,
    status: errorCode === 'timeout' ? 'timeout' : errorCode === 'cancelled' ? 'cancelled' : 'error',
    data: null,
    source: options.source ?? 'local',
    isMock: (options.source ?? 'local') === 'mock',
    errorCode,
    retryable: options.retryable ?? false,
    durationMs: options.durationMs,
    message,
  };
}
