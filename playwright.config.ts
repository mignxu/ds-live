import { defineConfig } from '@playwright/test';

/**
 * 浏览器端到端验证：真实后端 + mock 外部服务。
 *
 * 使用系统安装的 Chrome（channel: 'chrome'），不额外下载浏览器。
 * 若本机没有 Chrome，先 `pnpm exec playwright install chromium`。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
    channel: 'chrome',
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'pnpm --filter @dafeiyu/server exec tsx src/main.ts',
    url: 'http://127.0.0.1:8790/health',
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: '.',
    env: {
      NODE_ENV: 'development',
      PORT: '8790',
      DATA_DIR: 'runtime/e2e',
      STORAGE_ROOT: 'runtime/e2e/storage',
      // e2e 用 mock TTS（本地生成可播放 WAV），验证真实音频链路。
      SPEECH_ADAPTER: 'mock',
      ROOM_ID: 'room-main',
      STAGE_TOKEN: 'e2e-stage-token',
      INGEST_TOKEN: 'e2e-ingest-token',
      STUDIO_TOKEN: 'e2e-studio-token',
    },
  },
});
