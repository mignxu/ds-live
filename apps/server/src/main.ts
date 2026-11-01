import { describeConfig, loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createRuntime } from './runtime.js';

/**
 * 进程入口：启动、信号处理与优雅退出。
 * 只做装配，不含业务规则。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = (event: Record<string, unknown>) => {
    // 结构化单行日志；不打印密钥或完整观众文本。
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  };

  const runtime = createRuntime({ config, logger });
  const app = await buildApp({ runtime });

  await app.listen({ host: config.host, port: config.port });

  logger({ event: 'server.started', config: describeConfig(config) });
  logger({
    event: 'server.urls',
    stage: `http://${config.host}:${config.port}/stage`,
    studio: `http://${config.host}:${config.port}/studio`,
    souvenirs: `http://${config.host}:${config.port}/souvenirs`,
    note: config.devAllowMockIngest
      ? '开发模式：/api/ingest/events 可用 dev-only-ingest 令牌注入模拟事件'
      : '生产模式：模拟注入已禁用',
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger({ event: 'server.shutdown', signal });
    try {
      await app.close();
      await runtime.shutdown();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'server.fatal',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
