import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './storage/db.js';
import { loadConfig, type AppConfig } from './config.js';
import { createRuntime, type Runtime } from './runtime.js';
import type { ModelGateway } from './harness/model.js';
import { MockModelGateway } from './harness/mock-model.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ NODE_ENV: 'test' });
  return { ...base, ...overrides };
}

export type TestRuntime = {
  runtime: Runtime;
  db: Db;
  cleanup: () => Promise<void>;
};

export function makeRuntime(
  options: {
    model?: ModelGateway;
    config?: AppConfig;
    budget?: Partial<AppConfig['budget']>;
    /** 固定 storageRoot，避免测试写进仓库 runtime/。 */
    storageRoot?: string;
    roomId?: string;
    maxRooms?: number;
  } = {},
): TestRuntime {
  const base = options.config ?? testConfig();
  const storageRoot =
    options.storageRoot ?? mkdtempSync(join(tmpdir(), 'dafeiyu-test-storage-'));
  const config: AppConfig = {
    ...base,
    budget: { ...base.budget, ...options.budget },
    storageRoot,
  };
  const db = openDb({ file: ':memory:' });
  const runtime = createRuntime({
    config,
    db,
    model: options.model ?? new MockModelGateway(),
    ...(options.roomId ? { roomId: options.roomId } : {}),
    ...(options.maxRooms ? { maxRooms: options.maxRooms } : {}),
  });
  return {
    runtime,
    db,
    cleanup: async () => {
      await runtime.shutdown();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

/** 等待调度器把队列跑空，带超时保护。 */
export async function waitForIdle(runtime: Runtime, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while ((runtime.scheduler.queueDepth > 0 || runtime.scheduler.isBusy) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // 让 onTurnFinished 的舞台广播完成
  await new Promise((resolve) => setTimeout(resolve, 10));
}
