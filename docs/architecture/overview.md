# 模块边界与事件流

## 进程内模块

```text
ingress/      事件归一化、去重、限流
scheduler/    有界队列、单讲话者、取消
harness/      角色上下文、模型循环、工具观察（model.ts 是抽象）
conversation/ 角色加载、上下文窗口装配
tools/        注册表、参数校验、执行器、lol/web/signature 工具
programs/     Boss 状态机、签名笔迹、命令解析与节目协调
speech/       TTS 适配（mock WAV / 未配置替身）
stage/        舞台快照、事件广播、renderer 租约
souvenirs/    公开纪念品读取与边界
storage/      SQLite 连接、迁移、仓储
auth/         最小权限令牌比较
config.ts     环境变量校验与脱敏摘要
paths.ts      仓库根定位（数据目录、迁移、角色、前端产物）
runtime.ts    装配依赖，创建唯一的 Harness/Scheduler/Stage/Programs
app.ts        路由、鉴权、媒体、静态资源
main.ts       进程启动、信号、优雅退出
```

依赖方向：`app → runtime → (harness, tools, programs, speech, stage, scheduler, storage)`。
`harness` 只依赖 `ModelGateway` / `ToolExecutor` / `Repository` / `CharacterBundle` 抽象，
不直接读平台 Cookie、不执行 shell、不操控播放器。

**两个工具执行器**：

| 执行器 | 白名单 | 调用方 |
| --- | --- | --- |
| 模型执行器 | `lol.lookup`、`web.search`（只读） | harness |
| 节目执行器 | 上面两个 + `signature.create`（写） | ProgramManager / 控制台 |

这样“模型永远拿不到写权限”是结构保证，不是配置约定。

## 事件流

```text
POST /api/ingest/events
  → IngressNormalizer（校验/限流/去重键）
  → Repository.markEventProcessed（重复则 200 duplicate）
  → parseCommand
      ├─ 确定性节目（lol / signature / boss / program 切换）
      │    → ProgramManager → ToolExecutor(节目) / BossProgram
      │    → SpeechService.synthesize（可选音频）
      │    → StageService.publishSpeech
      └─ chat
           → Scheduler.enqueue（满则 429 queue_full）
           → Harness.runTurn
               → ModelGateway.complete（可请求工具）
               → ToolExecutor(模型，只读)
               → 再 complete
           → SpeechService.synthesize（可选音频）
           → StageService.publishSpeech
  → WS 推送 speech.ready / program.changed
  → 舞台回执 started/ended → StageService.handleReceipt
```

## 媒体路由

`GET /media/:bucket/:file`，`bucket ∈ {tts, souvenirs}`。

- 只允许 `[A-Za-z0-9_-]{1,96}` + 已知扩展名（`.wav`、`.svg`）。
- 原始 URL 含 `..` 或 `%2e%2e` 直接 400。
- 不列目录、不暴露服务器路径。
- 不用 `@fastify/static` 挂媒体目录：目录可能在启动后才生成。

## 权限模型

| 令牌 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| `INGEST_TOKEN` | POST `/api/ingest/events` | 读舞台、读控制台 |
| `STAGE_TOKEN` | GET snapshot、WS 订阅、发回执 | 注入事件、控制 |
| `STUDIO_TOKEN` | GET status（Header 或 Cookie）、POST control（**仅 Header**） | 注入事件、发舞台回执 |

令牌比较用 `timingSafeEqual`；生产缺任一令牌则拒绝启动。
`DEV_ALLOW_MOCK_INGEST` 在生产强制为 false。

写操作（`POST /api/studio/control`）只接受 Header 令牌，不接受 Cookie：
浏览器会自动带同站 Cookie，用 Cookie 做写鉴权等于依赖浏览器默认 SameSite 挡 CSRF，不可靠。
读状态允许 Cookie 只是为了本机调试方便。

所有响应带 `cache-control: no-store`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer`；
`/api/*` 额外带 `x-frame-options: DENY`。原因：舞台令牌可能通过 URL 传递，不能被缓存或随 Referer 外泄。

## 契约

`packages/contracts` 是唯一协议源（zod schema + 推导类型）。
web 通过 Vite alias 直接读 `packages/contracts/src`，不 import server。

## 日志

请求日志只保留 `method` + `path`（丢掉 query）+ `remoteAddress` + `statusCode`。
原因：舞台令牌可通过 `?token=` 传递，Fastify 默认 pino 序列化会记录完整 `req.url`，
把令牌写进日志。序列化器在 `app.ts` 的 `safeRequestSerializer`，有测试守护。
