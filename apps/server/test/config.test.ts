import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../src/config.js';

describe('配置校验', () => {
  it('生产环境缺令牌时拒绝启动', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/STAGE_TOKEN/);
  });

  it('生产环境禁止模拟注入', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        STAGE_TOKEN: 'stage-token-123',
        INGEST_TOKEN: 'ingest-token-123',
        STUDIO_TOKEN: 'studio-token-123',
        DEV_ALLOW_MOCK_INGEST: 'true',
      }),
    ).toThrow(/DEV_ALLOW_MOCK_INGEST/);
  });

  it('生产环境配置齐全时可加载，且脱敏摘要不含密钥', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      STAGE_TOKEN: 'stage-token-123',
      INGEST_TOKEN: 'ingest-token-123',
      STUDIO_TOKEN: 'studio-token-123',
      DEV_ALLOW_MOCK_INGEST: 'false',
      HS_GW_API_KEY: 'super-secret-key',
    });
    expect(config.isProduction).toBe(true);
    expect(config.tokensFromEnv).toBe(true);
    const summary = JSON.stringify(describeConfig(config));
    expect(summary).not.toContain('stage-token-123');
    expect(summary).not.toContain('super-secret-key');
  });

  it('开发环境缺令牌时用显式 dev-only 值', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.tokens.stage).toBe('dev-only-stage');
    expect(config.tokensFromEnv).toBe(false);
  });

  it('预算超出范围被拒绝', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', BUDGET_MAX_MODEL_CALLS: '99' })).toThrow();
  });
});
