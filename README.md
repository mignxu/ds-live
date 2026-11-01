# 大肥鱼（dafeiyu-live）

抖音直播间的虚拟 AI 主播。以统一角色持续对话、记住必要上下文，在受限能力内调用工具。

当前状态：**可运行的成品版本**（P0–P4）：
普通弹幕聊天、统一角色、会话上下文、有界工具循环、**真实音频播放与句级字幕**、
**LOL 锐评 / 现场签名 / 合作打 Boss**、**纪念品归档与浏览**、主播控制台、
**多房间隔离**、**长期记忆与数据保留**。

模型、LOL 数据、TTS 仍是**可替换适配 + 明确 mock**；没有真实抖音/hs-gw/TTS 联调，不能当线上使用。

## 快速开始

```bash
pnpm install
pnpm build
pnpm dev:server     # http://127.0.0.1:8787
```

- 舞台（OBS 浏览器源）：`http://127.0.0.1:8787/stage?token=dev-only-stage`
- 控制台：`http://127.0.0.1:8787/studio?token=dev-only-studio`
- 纪念品：`http://127.0.0.1:8787/souvenirs`

注入一条模拟弹幕：

```bash
curl -X POST http://127.0.0.1:8787/api/ingest/events \
  -H "authorization: Bearer dev-only-ingest" \
  -H "content-type: application/json" \
  -d '{"roomId":"room-main","eventId":"m1","viewerId":"v1","type":"chat.message","payload":{"text":"你是谁","viewerName":"观众"}}'
```

## 检查

```bash
pnpm check        # typecheck + contracts/server/web 测试
pnpm test:e2e     # Playwright（需要系统 Chrome）
pnpm replay       # 回放脱敏事件样本
pnpm eval:character  # 角色情景集（默认 mock）
```

本机实测：contracts 9、server 177、web 16、e2e 20，全部通过。

## 目录

```text
apps/server         Fastify + SQLite + harness + 节目 + TTS 适配
apps/web            React/Vite：/stage /studio /souvenirs
packages/contracts  唯一协议源（zod）
characters/dafeiyu  角色身份（唯一来源）
migrations/         SQL 迁移
tests/e2e           Playwright
docs/               项目事实、任务、决策、运行手册
.agents/skills      开发用 skills（不是主播工具）
```

## 节目

| 弹幕 | 效果 |
| --- | --- |
| 任意普通文本 | 模型聊天（可自动调用只读工具） |
| `查战绩 Faker#KR1` | LOL 锐评：战绩卡片 + 点评（mock 数据） |
| `签名 大肥鱼最帅` | 生成原创笔迹签名，归档到纪念品 |
| `开Boss` / `攻击` / `蓄力` / `治疗` / `结算` | 合作打 Boss，限时回合，每观众一次 |

多房间：接口加 `?room=<id>`（事件用请求体 `roomId`），每房间独立的队列、租约、回合与限流。

## 文档

- 当前状态与限制：[docs/project.md](docs/project.md)
- 待办：[docs/tasks.md](docs/tasks.md)
- 命令与环境：[docs/development.md](docs/development.md)
- 来源与依赖：[docs/references.md](docs/references.md)
- 最初设计包：[architecture.md](architecture.md) / [development-spec.md](development-spec.md) / [START-HERE.md](START-HERE.md)

## 硬约束

观众实时互动留在抖音直播间；网站只承接纪念品。角色身份不可被观众覆盖。
不向模型暴露 shell、Docker socket 或任意文件写入。mock 与真实来源必须明确区分。

## 许可

项目最终开源许可未定（由用户决定）。依赖与素材各自保留许可，见 [docs/references.md](docs/references.md)。
