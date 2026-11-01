import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { loadCharacter } from '../conversation/character.js';
import { Harness } from '../harness/harness.js';
import { HsGwModelGateway } from '../harness/hs-gw-model.js';
import { MockModelGateway } from '../harness/mock-model.js';
import type { ModelGateway } from '../harness/model.js';
import { resolveDataPath, findRepoRoot } from '../paths.js';
import { openDb } from '../storage/db.js';
import { Repository } from '../storage/repository.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createLolLookupTool } from '../tools/lol-lookup.js';
import { webSearchTool } from '../tools/web-search.js';

/**
 * 角色情景集评估。
 *
 * 用途：用真实模型跑 characters/dafeiyu/examples.json 的情景，
 * 记录模型/角色版本与每次结果，便于人工判断角色是否漂移。
 *
 * 明确边界：
 * - 不做自动打分，也不做单次字符串匹配断言（设计文档明确禁止用单次匹配证明角色不漂移）；
 * - 输出结构化记录（含工具调用与最终文本）供人工 review；
 * - 默认用 mock 模型跑通流程，真实模型需显式指定。
 *
 * 用法：
 *   pnpm eval:character                      # mock 模型，验证流程
 *   pnpm eval:character -- --model hs-gw     # 真实模型（需配置 HS_GW_*）
 *   pnpm eval:character -- --out result.json
 */
type Scenario = {
  id: string;
  input: string;
  expectation: string;
};

type ScenarioResult = {
  id: string;
  input: string;
  expectation: string;
  text: string;
  toolCalls: string[];
  finishReason: string;
  degraded: boolean;
  errorCode: string | null;
  modelCalls: number;
  toolCallsCount: number;
  durationMs: number;
};

type EvalReport = {
  generatedAt: string;
  modelId: string;
  characterVersion: string;
  promptDigest: string;
  adapter: string;
  results: ScenarioResult[];
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelArg = readArg(args, '--model') ?? 'mock';
  const outArg = readArg(args, '--out');

  const config = loadConfig();
  const character = loadCharacter();
  const root = findRepoRoot() ?? process.cwd();
  const examplesPath = resolve(root, 'characters/dafeiyu/examples.json');
  const examples = JSON.parse(readFileSync(examplesPath, 'utf8')) as { scenarios: Scenario[] };

  let model: ModelGateway;
  if (modelArg === 'mock') {
    model = new MockModelGateway();
  } else if (modelArg === 'hs-gw') {
    if (!config.model.baseUrl || !config.model.apiKey || !config.model.modelId) {
      process.stderr.write(
        'eval:character 需要 HS_GW_BASE_URL / HS_GW_API_KEY / HS_GW_MODEL。\n' +
          '未配置时请使用 --model mock 验证流程。\n',
      );
      process.exit(1);
    }
    model = new HsGwModelGateway({
      baseUrl: config.model.baseUrl,
      apiKey: config.model.apiKey,
      modelId: config.model.modelId,
    });
  } else {
    process.stderr.write(`未知模型适配器：${modelArg}（可选 mock / hs-gw）\n`);
    process.exit(1);
    return;
  }

  const db = openDb({ file: ':memory:' });
  const repository = new Repository(db);
  repository.ensureRoom('eval-room');

  const registry = new ToolRegistry();
  registry.register(createLolLookupTool({ adapter: 'mock' }));
  registry.register(webSearchTool);
  const tools = new ToolExecutor({
    registry,
    allowedTools: ['lol.lookup', 'web.search'],
    defaultTimeoutMs: config.budget.toolTimeoutMs,
  });

  const harness = new Harness({
    model,
    tools,
    repository,
    character,
    budget: config.budget,
    contextMaxMessages: config.contextMaxMessages,
  });

  const results: ScenarioResult[] = [];

  for (const scenario of examples.scenarios) {
    const sessionId = repository.ensureSession('eval-room');
    const turnId = `eval_${randomUUID()}`;
    const startedAt = Date.now();
    const outcome = await harness.runTurn({
      turnId,
      traceId: `trace_${randomUUID()}`,
      sessionId,
      roomId: 'eval-room',
      triggerEventId: null,
      viewerId: 'eval-viewer',
      viewerName: '观众',
      text: scenario.input,
      signal: new AbortController().signal,
    });

    results.push({
      id: scenario.id,
      input: scenario.input,
      expectation: scenario.expectation,
      text: outcome.text,
      toolCalls: outcome.toolResults.map((r) => `${r.name}:${r.status}`),
      finishReason: outcome.finishReason,
      degraded: outcome.degraded,
      errorCode: outcome.errorCode,
      modelCalls: outcome.modelCalls,
      toolCallsCount: outcome.toolCalls,
      durationMs: Date.now() - startedAt,
    });
  }

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    modelId: model.capabilities.modelId,
    characterVersion: character.profile.version,
    promptDigest: character.promptDigest,
    adapter: modelArg,
    results,
  };

  // 人工 review 用：按情景打印，不做自动判定。
  for (const result of report.results) {
    process.stdout.write(`\n=== ${result.id} ===\n`);
    process.stdout.write(`输入：${result.input}\n`);
    process.stdout.write(`期望：${result.expectation}\n`);
    process.stdout.write(`实际：${result.text}\n`);
    process.stdout.write(
      `工具：${result.toolCalls.length > 0 ? result.toolCalls.join(', ') : '（未调用）'}\n`,
    );
    process.stdout.write(
      `状态：${result.finishReason} · 模型 ${result.modelCalls} 次 · 工具 ${result.toolCallsCount} 次 · ${result.durationMs}ms\n`,
    );
  }

  process.stdout.write(
    `\n模型：${report.modelId} · 角色：${report.characterVersion} · ${report.promptDigest}\n`,
  );
  process.stdout.write(`共 ${report.results.length} 个情景。需要人工判断是否符合期望。\n`);

  if (outArg) {
    const target = resolveDataPath(outArg);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`报告已写入：${target}\n`);
  }

  db.close();
}

function readArg(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `eval:character 失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
