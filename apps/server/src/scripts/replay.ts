import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 离线回放：把脱敏事件 POST 到本地开发服务的 /api/ingest/events。
 * 不连接真实抖音平台；开发模式默认令牌为 dev-only-ingest。
 *
 * 用法：
 *   pnpm replay                       # 回放 tests/fixtures/events.sample.json
 *   pnpm replay -- --file x.json      # 指定文件
 *   BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=... pnpm replay
 */
type FixtureEvent = {
  roomId: string;
  eventId?: string;
  viewerId?: string;
  type: string;
  payload: Record<string, unknown>;
  delayMs?: number;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const file =
    fileIndex >= 0 && args[fileIndex + 1]
      ? resolve(args[fileIndex + 1] as string)
      : defaultFixturePath();
  const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
  const token = process.env.INGEST_TOKEN ?? 'dev-only-ingest';

  const events = JSON.parse(readFileSync(file, 'utf8')) as FixtureEvent[];
  process.stdout.write(`回放 ${events.length} 条事件 → ${baseUrl}\n`);

  for (const event of events) {
    // 用 Buffer 显式按 UTF-8 编码，避免 Windows 终端把中文变成 GBK 乱码。
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    const response = await fetch(`${baseUrl}/api/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: payload,
    });
    const body = await response.text();
    process.stdout.write(`${response.status} ${event.type} ${body}\n`);
    if (event.delayMs) await new Promise((r) => setTimeout(r, event.delayMs));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`回放失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

/** 从 apps/server 或仓库根运行都能找到样本事件。 */
function defaultFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'tests/fixtures/events.sample.json'),
    resolve(process.cwd(), '../../tests/fixtures/events.sample.json'),
    resolve(here, '../../../../tests/fixtures/events.sample.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`未找到 events.sample.json，已尝试：${candidates.join(', ')}`);
}
