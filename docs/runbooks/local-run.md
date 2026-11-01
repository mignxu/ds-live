# 本地启动与回放

## 启动（开发）

```bash
pnpm install
pnpm build                      # 首次需要：contracts + server + web
pnpm dev:server                 # http://127.0.0.1:8787
```

浏览器打开：

- 舞台：`http://127.0.0.1:8787/stage?token=dev-only-stage`
- 控制台：`http://127.0.0.1:8787/studio?token=dev-only-studio`
- 纪念品：`http://127.0.0.1:8787/souvenirs`

## 注入模拟弹幕

```bash
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" \
  -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"manual-1","viewerId":"v1","type":"chat.message","payload":{"text":"你是谁","viewerName":"观众"}}'
```

或用回放脚本：

```bash
pnpm replay                       # 回放 tests/fixtures/events.sample.json
pnpm replay -- --file my.json
```

## 预期现象（实测）

1. 舞台收到 `speech.ready`，字幕出现，点击“开始”后进度条推进。
2. 问到战绩时，右侧出现卡片并带 `mock` 标记。
3. 播放结束（无音频时约 1s 起按文本长度推进）后回到“待机中…”。
4. 控制台显示最近轮次的阶段、模型/工具调用次数、结束原因。

## 验证脚本（本机实测通过）

```bash
pnpm check        # typecheck + 全部单元/集成测试
pnpm test:e2e     # 8 项浏览器 e2e
pnpm build        # 三个包构建
```

## 停止

`Ctrl+C` 会触发 `SIGINT`：关闭 HTTP、调度器取消当前轮、SQLite 正常关闭。
重启时 `markInterruptedTurns` 把未结束的轮次标为 `FAILED/interrupted`，不重播。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面 404 | 未构建前端 | `pnpm --filter @dafeiyu/web build` |
| 舞台一直“未连接” | 令牌错误 | 检查 URL 的 `?token=` |
| 舞台提示“缺少舞台令牌” | URL 没有 token 且 localStorage 为空 | 补 `?token=dev-only-stage` |
| 控制台 401 | 用了舞台令牌 | 用 `dev-only-studio` |
| 事件返回 429 | 限流或队列满 | 降低注入频率，或调 `QUEUE_MAX_PENDING` |

## 生产模式冒烟（本机实测 2026-10-31）

用真实 logger 起一次生产配置，确认日志不落令牌：

```bash
cd apps/server
NODE_ENV=production PORT=8799 DATA_DIR=runtime/probe \
STAGE_TOKEN=probe-stage-token INGEST_TOKEN=probe-ingest-token STUDIO_TOKEN=probe-studio-token \
DEV_ALLOW_MOCK_INGEST=false node dist/main.js
```

实测结果：

- 启动成功，`tokensFromEnv: true`，`devAllowMockIngest: false`；
- 带 `?token=probe-stage-token` 的请求日志只记录 `{"method":"GET","path":"/api/stage/snapshot"}`；
- `grep -c probe-stage-token` 结果为 0，令牌未落盘；
- 未带 Header 的 `/api/stage/snapshot` 返回 401（URL query 只对 WS 握手生效）。

注意：这是**本机生产模式冒烟**，不是线上部署验证。

## 节目演示（本机实测 2026-10-31）

起服务后，在舞台页点「开始」，然后：

```bash
# 1) LOL 锐评（mock 数据，带卡片）
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"demo-lol","viewerId":"v1","type":"chat.message","payload":{"text":"查战绩 Faker#KR1","viewerName":"小鱼干"}}'

# 2) 现场签名（生成 SVG 并归档纪念品）
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"demo-sig","viewerId":"v1","type":"chat.message","payload":{"text":"签名 大肥鱼最帅","viewerName":"小鱼干"}}'

# 3) 合作打 Boss
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"demo-boss-open","viewerId":"host","type":"chat.message","payload":{"text":"开Boss","viewerName":"主播"}}'
# 观众出手（同一 viewerId 第二次会被拒绝）
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"demo-boss-a1","viewerId":"a","type":"chat.message","payload":{"text":"攻击","viewerName":"甲"}}'
# 结算
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"demo-boss-settle","viewerId":"host","type":"chat.message","payload":{"text":"结算","viewerName":"主播"}}'

# 4) 看纪念品
curl -s http://127.0.0.1:8787/api/souvenirs | head -c 800
```

预期现象：

- LOL：右侧出现战绩卡片，角标 `mock`；语音带 `mock 语音` 角标。
- 签名：舞台出现签名卡片（米色底 SVG）；`/souvenirs` 里能看到并下载。
- Boss：左侧血条面板，`已出手 N`；重复出手提示“已经出过手”；结算后状态变 `resolved`，纪念品多一条战报。

## 音频相关

- 默认 `SPEECH_ADAPTER=mock`：本地生成 16kHz WAV，可在浏览器真实播放。
- 想验证纯字幕模式：`SPEECH_ADAPTER=none`，舞台只显示字幕，studio 会提示 TTS 不可用。
- 音频文件在 `STORAGE_ROOT/tts/`，通过 `/media/tts/<file>.wav` 提供。
