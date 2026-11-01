import { z } from 'zod';

/**
 * 环境变量校验。凭证只从环境读取，不写死、不打印。
 * 缺凭证不阻断开发：对应适配器降级为 mock 并显式标记。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  /** 开发模式才允许无凭证的 mock 注入入口。 */
  DEV_ALLOW_MOCK_INGEST: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** 舞台只读令牌；生产必须显式配置。 */
  STAGE_TOKEN: z.string().min(8).optional(),
  /** 弹幕适配器令牌；生产必须显式配置。 */
  INGEST_TOKEN: z.string().min(8).optional(),
  /** 主播控制台令牌；生产必须显式配置。 */
  STUDIO_TOKEN: z.string().min(8).optional(),

  /** 数据与作品目录。 */
  DATA_DIR: z.string().default('runtime'),
  STORAGE_ROOT: z.string().default('runtime/storage'),

  /** 房间 ID；首版单房间，多房间见 docs/tasks.md ENG-001。 */
  ROOM_ID: z.string().trim().min(1).max(64).default('room-main'),

  /** TTS 适配器：mock 生成本地可播放 WAV；none 为纯字幕模式。 */
  SPEECH_ADAPTER: z.enum(['mock', 'none']).default('mock'),
  SPEECH_VOICE: z.string().min(1).max(64).optional(),

  /** 模型适配器：mock 为确定性替身，hs-gw 走真实 HTTP（未核实前不可用）。 */
  MODEL_ADAPTER: z.enum(['mock', 'hs-gw']).default('mock'),
  HS_GW_BASE_URL: z.string().url().optional(),
  HS_GW_API_KEY: z.string().min(1).optional(),
  HS_GW_MODEL: z.string().min(1).optional(),

  /** 工具数据源：mock 为本地替身。 */
  LOL_ADAPTER: z.enum(['mock', 'http']).default('mock'),
  LOL_HTTP_BASE_URL: z.string().url().optional(),
  LOL_HTTP_TOKEN: z.string().min(1).optional(),

  /** 预算，初始调参值，不是性能承诺。 */
  BUDGET_MAX_MODEL_CALLS: z.coerce.number().int().min(1).max(10).default(3),
  BUDGET_MAX_TOOL_CALLS: z.coerce.number().int().min(0).max(10).default(3),
  BUDGET_MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  BUDGET_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8_000),
  BUDGET_TURN_DEADLINE_MS: z.coerce.number().int().min(500).max(180_000).default(30_000),

  /** 保留期限（天）。0 表示不自动清理。 */
  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  RETENTION_MESSAGES_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  RETENTION_TURNS_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  RETENTION_SOUVENIRS_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  RETENTION_MEMORIES_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(0),
  /** 清理任务间隔（分钟）；0 表示关闭定时清理。 */
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),

  /** 同时存在的房间上限，防止外部 roomId 撑爆内存。 */
  MAX_ROOMS: z.coerce.number().int().min(1).max(1000).default(20),

  /** 队列与限流。 */
  QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(1000).default(32),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  CONTEXT_MAX_MESSAGES: z.coerce.number().int().min(2).max(50).default(12),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  devAllowMockIngest: boolean;
  tokens: {
    stage: string;
    ingest: string;
    studio: string;
  };
  /** 生产环境是否全部显式配置了令牌。 */
  tokensFromEnv: boolean;
  roomId: string;
  dataDir: string;
  storageRoot: string;
  speech: {
    adapter: 'mock' | 'none';
    voice: string | null;
  };
  model: {
    adapter: 'mock' | 'hs-gw';
    baseUrl: string | null;
    apiKey: string | null;
    modelId: string | null;
  };
  lol: {
    adapter: 'mock' | 'http';
    baseUrl: string | null;
    token: string | null;
  };
  budget: {
    maxModelCallsPerTurn: number;
    maxToolCallsPerTurn: number;
    modelTimeoutMs: number;
    toolTimeoutMs: number;
    turnDeadlineMs: number;
  };
  queue: {
    maxPending: number;
    rateLimitPerMinute: number;
  };
  maxRooms: number;
  contextMaxMessages: number;
  retention: {
    processedEventsDays: number;
    messagesDays: number;
    turnsDays: number;
    souvenirsDays: number;
    memoriesGraceDays: number;
    intervalMinutes: number;
  };
};

const DEV_TOKEN_PREFIX = 'dev-only-';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const isProduction = parsed.NODE_ENV === 'production';

  const fromEnv = Boolean(parsed.STAGE_TOKEN && parsed.INGEST_TOKEN && parsed.STUDIO_TOKEN);
  if (isProduction && !fromEnv) {
    throw new Error('生产环境必须显式配置 STAGE_TOKEN / INGEST_TOKEN / STUDIO_TOKEN');
  }
  if (isProduction && parsed.DEV_ALLOW_MOCK_INGEST) {
    throw new Error('生产环境禁止开启 DEV_ALLOW_MOCK_INGEST');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    host: parsed.HOST,
    port: parsed.PORT,
    devAllowMockIngest: parsed.DEV_ALLOW_MOCK_INGEST,
    tokens: {
      stage: parsed.STAGE_TOKEN ?? `${DEV_TOKEN_PREFIX}stage`,
      ingest: parsed.INGEST_TOKEN ?? `${DEV_TOKEN_PREFIX}ingest`,
      studio: parsed.STUDIO_TOKEN ?? `${DEV_TOKEN_PREFIX}studio`,
    },
    tokensFromEnv: fromEnv,
    roomId: parsed.ROOM_ID,
    dataDir: parsed.DATA_DIR,
    storageRoot: parsed.STORAGE_ROOT,
    speech: {
      adapter: parsed.SPEECH_ADAPTER,
      voice: parsed.SPEECH_VOICE ?? null,
    },
    model: {
      adapter: parsed.MODEL_ADAPTER,
      baseUrl: parsed.HS_GW_BASE_URL ?? null,
      apiKey: parsed.HS_GW_API_KEY ?? null,
      modelId: parsed.HS_GW_MODEL ?? null,
    },
    lol: {
      adapter: parsed.LOL_ADAPTER,
      baseUrl: parsed.LOL_HTTP_BASE_URL ?? null,
      token: parsed.LOL_HTTP_TOKEN ?? null,
    },
    budget: {
      maxModelCallsPerTurn: parsed.BUDGET_MAX_MODEL_CALLS,
      maxToolCallsPerTurn: parsed.BUDGET_MAX_TOOL_CALLS,
      modelTimeoutMs: parsed.BUDGET_MODEL_TIMEOUT_MS,
      toolTimeoutMs: parsed.BUDGET_TOOL_TIMEOUT_MS,
      turnDeadlineMs: parsed.BUDGET_TURN_DEADLINE_MS,
    },
    queue: {
      maxPending: parsed.QUEUE_MAX_PENDING,
      rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
    },
    maxRooms: parsed.MAX_ROOMS,
    contextMaxMessages: parsed.CONTEXT_MAX_MESSAGES,
    retention: {
      processedEventsDays: parsed.RETENTION_EVENTS_DAYS,
      messagesDays: parsed.RETENTION_MESSAGES_DAYS,
      turnsDays: parsed.RETENTION_TURNS_DAYS,
      souvenirsDays: parsed.RETENTION_SOUVENIRS_DAYS,
      memoriesGraceDays: parsed.RETENTION_MEMORIES_GRACE_DAYS,
      intervalMinutes: parsed.RETENTION_INTERVAL_MINUTES,
    },
  };
}

/** 启动时打印的脱敏配置摘要，不含任何密钥。 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    listen: `${config.host}:${config.port}`,
    tokensFromEnv: config.tokensFromEnv,
    devAllowMockIngest: config.devAllowMockIngest,
    roomId: config.roomId,
    modelAdapter: config.model.adapter,
    speechAdapter: config.speech.adapter,
    modelConfigured: Boolean(config.model.baseUrl && config.model.apiKey && config.model.modelId),
    lolAdapter: config.lol.adapter,
    lolConfigured: Boolean(config.lol.baseUrl),
    budget: config.budget,
    queue: config.queue,
    retention: config.retention,
  };
}
