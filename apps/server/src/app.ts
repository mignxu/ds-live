import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  IngestAcceptedSchema,
  IngressSubmissionSchema,
  PlaybackReceiptSchema,
  ProgramIdSchema,
  type StudioStatus,
} from '@dafeiyu/contracts';
import { extractToken, tokenMatches } from './auth/tokens.js';
import type { AppConfig } from './config.js';
import { defaultWebDistDir, resolveDataPath } from './paths.js';
import { parseCommand } from './programs/program-manager.js';
import { newTurnIds, type Runtime } from './runtime.js';
import type { RoomRuntime } from './rooms/room-runtime.js';

/**
 * 请求日志序列化：只保留路径，丢掉 query。
 *
 * 舞台令牌可以通过 `?token=` 传递，而 Fastify 默认 pino 序列化会记录完整 `req.url`，
 * 那会把令牌写进日志。这里显式覆盖，避免凭证落盘。
 */
export function safeRequestSerializer(request: {
  method: string;
  url: string;
  ip: string;
}): { method: string; path: string; remoteAddress: string } {
  return {
    method: request.method,
    path: request.url.split('?')[0] ?? request.url,
    remoteAddress: request.ip,
  };
}

export type BuildAppOptions = {
  runtime: Runtime;
  /** 生产由同域服务分发前端构建；开发交给 Vite。 */
  webDistDir?: string | null;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { runtime } = options;
  const config: AppConfig = runtime.config;

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.isProduction ? 'info' : 'warn',
            serializers: {
              req: safeRequestSerializer,
              res(reply) {
                return { statusCode: reply.statusCode };
              },
            },
          },
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  await app.register(websocket);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // 令牌可能在 URL 里传给舞台，禁止它随 Referer 或缓存泄露。
    // 媒体资源不含凭证，允许短缓存（见下方 /media 路由）。
    if (!request.url.startsWith('/media/')) {
      reply.header('cache-control', 'no-store');
    }
    if (request.url.startsWith('/api/')) {
      reply.header('x-frame-options', 'DENY');
    }
    return payload;
  });

  app.get('/health', async () => ({ ok: true }));

  // ---- 弹幕接入：带凭证，开发模式才允许模拟注入 ----
  app.post('/api/ingest/events', async (request, reply) => {
    const token = extractToken(request.headers as Record<string, unknown>);
    if (!tokenMatches(token, config.tokens.ingest)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = IngressSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_event',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (parsed.data.type === 'system.tick' && !config.devAllowMockIngest) {
      // 模拟事件只在开发模式开放；生产即使拿到令牌也不允许伪造时间线。
      return reply.code(403).send({ error: 'simulation_disabled' });
    }
    if (parsed.data.type === 'simulation.note' && !config.devAllowMockIngest) {
      return reply.code(403).send({ error: 'simulation_disabled' });
    }

    // 按房间取运行时；超过房间上限时明确拒绝，不静默丢弃。
    const room = runtime.rooms.get(parsed.data.roomId);
    if (!room) {
      return reply.code(429).send({ error: 'too_many_rooms' });
    }

    const normalized = room.ingress.normalize(parsed.data);
    if (!normalized.ok) {
      if (normalized.reason === 'rate_limited') {
        return reply
          .code(429)
          .header('retry-after', Math.ceil((normalized.retryAfterMs ?? 1000) / 1000))
          .send({ error: 'rate_limited' });
      }
      return reply.code(400).send({ error: 'invalid_event' });
    }

    const event = normalized.event;

    // 队列已满时先背压，不要把事件记成已处理，否则观众重试会被误判为重复。
    if (event.type === 'chat.message' && !room.scheduler.hasCapacity()) {
      return reply.code(429).send({ error: 'queue_full' });
    }

    const isNew = runtime.repository.markEventProcessed({
      dedupeKey: event.dedupeKey,
      eventId: event.eventId,
      strategy: event.dedupeStrategy,
      roomId: event.roomId,
    });

    if (!isNew) {
      const body = IngestAcceptedSchema.parse({
        accepted: false,
        duplicate: true,
        eventId: event.eventId,
        traceId: event.traceId,
        dedupeStrategy: event.dedupeStrategy,
      });
      return reply.code(200).send(body);
    }

    if (event.type === 'chat.message') {
      const payload = event.payload as { text: string; viewerName?: string };
      runtime.repository.ensureRoom(event.roomId);
      const sessionId = runtime.repository.ensureSession(event.roomId);

      // 先捕获“记住 xxx”这类明示记忆：只处理观众明说的，不做模型推断。
      room.captureMemory({
        sessionId,
        viewerId: event.viewerId,
        text: payload.text,
      });

      // 命令路由：确定性节目直接处理；普通文本才进入模型聊天。
      //
      // 关键：ingest 不能等待慢下游。节目命令（尤其 LOL 查询有 8s 超时）
      // 异步执行，接入方立刻拿到 202；失败时回滚去重记录，让观众能重试。
      const command = parseCommand(
        payload.text,
        event.viewerId,
        payload.viewerName ?? null,
        room.programs.program,
      );

      if (command.kind === 'chat') {
        const { turnId, traceId } = newTurnIds();
        const accepted = room.scheduler.enqueue({
          turnId,
          traceId,
          sessionId,
          roomId: event.roomId,
          triggerEventId: event.eventId,
          viewerId: event.viewerId,
          viewerName: payload.viewerName ?? null,
          text: payload.text,
        });
        if (!accepted) {
          runtime.repository.unmarkEventProcessed(event.dedupeKey);
          return reply.code(429).send({ error: 'queue_full' });
        }
      } else {
        // 先占位去重已完成，异步执行节目；失败回滚。
        void room.programs
          .handleCommand(command)
          .then((handled) => {
            if (!handled) {
              // 解析为节目命令但协调器选择不处理：退回聊天，避免丢消息。
              const { turnId, traceId } = newTurnIds();
              room.scheduler.enqueue({
                turnId,
                traceId,
                sessionId,
                roomId: event.roomId,
                triggerEventId: event.eventId,
                viewerId: event.viewerId,
                viewerName: payload.viewerName ?? null,
                text: payload.text,
              });
            }
          })
          .catch((error: unknown) => {
            runtime.repository.unmarkEventProcessed(event.dedupeKey);
            request.log.error(
              { event: 'program.failed', command: command.kind, message: describeError(error) },
              'program handler failed',
            );
          });
      }
    }

    const body = IngestAcceptedSchema.parse({
      accepted: true,
      duplicate: false,
      eventId: event.eventId,
      traceId: event.traceId,
      dedupeStrategy: event.dedupeStrategy,
    });
    return reply.code(202).send(body);
  });

  // ---- 舞台：只读 ----
  /** 解析目标房间：?room= 指定，缺省为默认房间。 */
  const resolveRoom = (rawUrl: string | undefined): RoomRuntime | null => {
    const url = new URL(rawUrl ?? '/', 'http://localhost');
    const roomId = url.searchParams.get('room') ?? config.roomId;
    return runtime.rooms.get(roomId);
  };

  app.get('/api/stage/snapshot', async (request, reply) => {
    const token = extractToken(request.headers as Record<string, unknown>);
    if (!tokenMatches(token, config.tokens.stage)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const room = resolveRoom(request.raw.url);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    return room.stage.snapshot();
  });

  app.get('/api/stage/events', { websocket: true }, (socket, request) => {
    const headers = request.headers as Record<string, unknown>;
    const query = request.query as { token?: string };
    const token = extractToken(headers) ?? query.token ?? null;
    if (!tokenMatches(token, config.tokens.stage)) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const room = resolveRoom(request.raw.url);
    if (!room) {
      socket.close(4404, 'room_not_found');
      return;
    }

    const lease = room.stage.acquireRendererLease();
    socket.send(
      JSON.stringify({ type: 'snapshot', snapshot: room.stage.snapshot(), rendererToken: lease.token }),
    );

    const unsubscribe = room.stage.subscribe((event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.on('message', (raw: unknown) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = PlaybackReceiptSchema.safeParse(parsedJson);
      if (!parsed.success) return;
      const result = room.stage.handleReceipt(parsed.data);
      if (!result.accepted) {
        socket.send(JSON.stringify({ type: 'receipt.rejected', reason: result.reason }));
      }
    });

    socket.on('close', () => {
      unsubscribe();
    });
  });

  // ---- 主播控制台 ----
  // 读状态允许 Cookie（便于本机调试），但写操作只接受 Header 令牌：
  // 浏览器会自动带上同站 Cookie，若用它做写鉴权就依赖浏览器默认 SameSite 挡 CSRF，不可靠。
  const requireStudioRead = (
    headers: Record<string, unknown>,
    cookies: Record<string, string | undefined>,
  ): boolean => {
    const token = extractToken(headers) ?? cookies.studio_token ?? null;
    return tokenMatches(token, config.tokens.studio);
  };

  const requireStudioWrite = (headers: Record<string, unknown>): boolean =>
    tokenMatches(extractToken(headers), config.tokens.studio);

  app.get('/api/studio/status', async (request, reply) => {
    if (!requireStudioRead(request.headers as Record<string, unknown>, request.cookies)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const query = request.query as { room?: string };
    return buildStudioStatus(runtime, query.room);
  });

  app.post('/api/studio/control', async (request, reply) => {
    if (!requireStudioWrite(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as
      | { action?: string; program?: string; text?: string; viewerId?: string; memoryId?: string }
      | null;
    const room = resolveRoom(request.raw.url);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });

    switch (body?.action) {
      case 'cancel': {
        const cancelled = room.stage.cancelActive();
        const turnCancelled = room.scheduler.cancelActive('studio');
        // 也要中断正在合成的语音，否则合成结束后仍会把已取消台词推上舞台。
        const synthesisCancelled = runtime.cancelPendingSynthesis();
        return {
          ok: true,
          cancelledSpeechId: cancelled?.speechId ?? null,
          turnCancelled,
          synthesisCancelled,
        };
      }
      case 'clear_queue': {
        const cleared = room.scheduler.clearPending();
        return { ok: true, cleared };
      }
      case 'switch_program': {
        const parsedProgram = ProgramIdSchema.safeParse(body.program);
        if (!parsedProgram.success) {
          return reply.code(400).send({ error: 'unknown_program' });
        }
        room.programs.setProgram(parsedProgram.data);
        return { ok: true, program: parsedProgram.data };
      }
      case 'boss_open': {
        await room.programs.handleCommand({
          kind: 'boss.open',
          viewerId: 'studio',
          viewerName: '主播',
        });
        return { ok: true, state: room.programs.bossState() };
      }
      case 'boss_settle': {
        await room.programs.handleCommand({
          kind: 'boss.settle',
          viewerId: 'studio',
          viewerName: '主播',
        });
        return { ok: true, state: room.programs.bossState() };
      }
      case 'boss_reset': {
        // 先把 DB 里的运行记录标为 cancelled，再清内存，避免两份事实冲突。
        const state = room.programs.resetBoss();
        return { ok: true, state };
      }
      case 'say': {
        const text = (body.text ?? '').trim();
        if (text.length === 0 || text.length > 200) {
          return reply.code(400).send({ error: 'invalid_text' });
        }
        const speech = room.stage.publishSpeech({
          turnId: `turn_${Date.now().toString(36)}`,
          text,
          toolResults: [],
          degraded: false,
        });
        return { ok: true, speechId: speech.speechId };
      }
      case 'retention_preview': {
        return { ok: true, stats: runtime.previewRetention() };
      }
      case 'retention_run': {
        return { ok: true, stats: runtime.runRetention() };
      }
      case 'memory_clear_viewer': {
        const viewerId = (body.viewerId ?? '').trim();
        if (viewerId.length === 0) {
          return reply.code(400).send({ error: 'invalid_viewer_id' });
        }
        const removed = runtime.memories.clearViewer(runtime.config.roomId, viewerId);
        return { ok: true, removed };
      }
      case 'memory_delete': {
        const id = (body.memoryId ?? '').trim();
        if (id.length === 0) {
          return reply.code(400).send({ error: 'invalid_memory_id' });
        }
        return { ok: true, removed: runtime.memories.remove(id) };
      }
      default:
        return reply.code(400).send({ error: 'unknown_action' });
    }
  });

  /** 控制台查看记忆（含过期的），用于“可查看、纠正、清除”。 */
  app.get('/api/studio/memories', async (request, reply) => {
    if (!requireStudioRead(request.headers as Record<string, unknown>, request.cookies)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 100);
    return {
      items: runtime.memories.listAll(
        runtime.config.roomId,
        Number.isFinite(limit) ? limit : 100,
      ),
    };
  });

  // ---- 纪念品：公开只读 ----
  app.get('/api/souvenirs', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Number(query.limit ?? 20);
    const offset = Number(query.offset ?? 0);
    return runtime.souvenirs.list(
      Number.isFinite(limit) ? limit : 20,
      Number.isFinite(offset) ? offset : 0,
    );
  });

  app.get('/api/souvenirs/:publicId', async (request, reply) => {
    const params = request.params as { publicId?: string };
    const souvenir = params.publicId ? runtime.souvenirs.get(params.publicId) : null;
    if (!souvenir) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return souvenir;
  });

  // ---- 媒体：TTS 音频与签名图。只读，不含目录列表。 ----
  // ---- 媒体：TTS 音频与签名图。只读，不暴露目录列表 ----
  //
  // 不用 @fastify/static 挂目录：目录可能在启动后才由 TTS/签名生成，
  // 且需要严格的路径校验（只允许单层文件名 + 已知扩展名）。
  const mediaRoots: Record<string, string> = {
    tts: resolveDataPath(join(config.storageRoot, 'tts')),
    souvenirs: resolveDataPath(join(config.storageRoot, 'souvenirs')),
  };
  const MEDIA_EXT: Record<string, string> = {
    '.wav': 'audio/wav',
    '.svg': 'image/svg+xml',
  };

  app.get('/media/:bucket/:file', async (request, reply) => {
    // Fastify 会规范化 URL；先看原始 URL 是否试图穿越，明确拒绝而不是落到 SPA 回退。
    if (request.raw.url?.includes('..') || request.raw.url?.includes('%2e%2e')) {
      return reply.code(400).send({ error: 'invalid_path' });
    }
    const params = request.params as { bucket?: string; file?: string };
    const root = params.bucket ? mediaRoots[params.bucket] : undefined;
    const file = params.file ?? '';
    if (!root) return reply.code(404).send({ error: 'not_found' });

    // 只允许 [A-Za-z0-9_-]+.<已知扩展名>，杜绝路径穿越。
    const match = /^([A-Za-z0-9_-]{1,96})(\.[A-Za-z0-9]{1,5})$/.exec(file);
    if (!match) return reply.code(404).send({ error: 'not_found' });
    const contentType = MEDIA_EXT[match[2] ?? ''];
    if (!contentType) return reply.code(404).send({ error: 'not_found' });

    const filePath = join(root, file);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'not_found' });

    return reply
      .header('content-type', contentType)
      .header('cache-control', 'public, max-age=300')
      .send(await readFile(filePath));
  });

  // ---- 生产静态资源：舞台/控制台/纪念品同域分发 ----
  // webDistDir === null 表示显式禁用（测试用），不能用 ?? 回退。
  const webDist = options.webDistDir === null ? null : (options.webDistDir ?? defaultWebDistDir());
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/media/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildStudioStatus(runtime: Runtime, roomId?: string): StudioStatus {
  const room = (roomId ? runtime.rooms.get(roomId) : runtime.defaultRoom) ?? runtime.defaultRoom;
  const turns = runtime.repository.recentTurns(10);
  const programState = room.programs.program === 'boss' ? room.programs.bossState() : null;
  return {
    characterName: runtime.character.profile.name,
    characterVersion: runtime.character.profile.version,
    modelId: runtime.modelCapabilities.modelId,
    degraded: runtime.degradation,
    room: {
      id: room.roomId,
      count: runtime.rooms.size,
      max: runtime.config.maxRooms,
    },
    queue: {
      queued: room.scheduler.queueDepth,
      planning: room.scheduler.isBusy ? 1 : 0,
      speaking: room.stage.snapshot().activeSpeech ? 1 : 0,
    },
    budget: {
      maxModelCallsPerTurn: runtime.config.budget.maxModelCallsPerTurn,
      maxToolCallsPerTurn: runtime.config.budget.maxToolCallsPerTurn,
      turnDeadlineMs: runtime.config.budget.turnDeadlineMs,
    },
    program: {
      id: room.programs.program,
      label:
        room.programs.listPrograms().find((p) => p.id === room.programs.program)?.label ??
        room.programs.program,
      state: programState,
    },
    speech: {
      available: runtime.speech.available,
      isMock: runtime.speech.isMock,
      voice: runtime.speech.voice,
      reason: runtime.speech.unavailableReason,
    },
    retention: {
      pending: runtime.previewRetention(),
      config: runtime.retention,
    },
    recentTurns: turns.map((turn) => ({
      turnId: turn.id,
      phase: turn.phase as StudioStatus['recentTurns'][number]['phase'],
      modelCalls: turn.modelCalls,
      toolCalls: turn.toolCalls,
      finishReason: turn.finishReason,
      errorCode: turn.errorCode,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    updatedAt: new Date().toISOString(),
  };
}
