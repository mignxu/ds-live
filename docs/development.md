# 开发命令与环境

## 环境（本机已验证）

| 项 | 值 |
| --- | --- |
| OS | Windows（Git Bash / PowerShell） |
| Node | v22.23.2（`>=22.12.0`，`better-sqlite3@13` 要求 `>=22`） |
| pnpm | 12.16.1（`packageManager` 已固定） |
| 浏览器 | 系统安装的 Chrome（Playwright 用 `channel: 'chrome'`，不下载 Chromium） |

未使用 Node 24：本机 nvm 未安装 24.x，22.23.2 满足全部依赖的 engines 要求。
切换 Node 大版本前先跑 `pnpm check && pnpm test:e2e`。

## 命令（全部实测通过）

```bash
pnpm install            # 安装依赖（allowBuilds 已限定 better-sqlite3 / esbuild）
pnpm build              # contracts → server → web 依次构建
pnpm lint               # eslint（真实缺陷类规则，不含风格争论）
pnpm typecheck          # 三个包分别 tsc --noEmit
pnpm test               # contracts + server + web 单元/集成测试
pnpm check              # check-context + lint + typecheck + test
pnpm test:e2e           # Playwright（自动起后端，端口 8790）
pnpm replay             # 向本地服务回放脱敏事件样本
pnpm eval:character     # 角色情景集（默认 mock；--model hs-gw 用真实模型）
```

### 本地开发

```bash
pnpm dev:server         # 后端 http://127.0.0.1:8787
pnpm dev:web            # 前端 http://127.0.0.1:5173（/api 代理到 8787）
```

`pnpm dev` 会并行启动两者；Vite 代理已包含 WS。

实测（2026-10-31）：`pnpm dev` 能同时拉起 `apps/server`（8787）与 `apps/web`（5173）。
若 8787 已被占用会报 `EADDRINUSE` 并以 143 退出——先停掉旧进程再启动。

### 环境变量（本轮新增）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROOM_ID` | `room-main` | 单房间 ID |
| `SPEECH_ADAPTER` | `mock` | `mock` 生成本地 WAV；`none` 纯字幕 |
| `SPEECH_VOICE` | `mock-sine` | 音色标识（mock 固定） |
| `MAX_ROOMS` | `20` | 同时存在的房间上限 |
| `RETENTION_*_DAYS` | 7/7/30/30 | 各类数据保留天数（0=不清理） |
| `RETENTION_INTERVAL_MINUTES` | `60` | 清理间隔（0=关闭） |

### 页面入口

| 页面 | 用途 | 令牌 |
| --- | --- | --- |
| `/stage?token=...` | OBS 浏览器源，观众画面 | `STAGE_TOKEN` |
| `/studio?token=...` | 主播控制台，不播放音频 | `STUDIO_TOKEN` |
| `/souvenirs` | 访客浏览已公开的签名与战报 | 无（只读公开数据） |

开发模式默认令牌为 `dev-only-stage` / `dev-only-ingest` / `dev-only-studio`。
**生产必须通过环境变量显式配置，否则进程拒绝启动。**

## 环境变量

见 `.env.example`。要点：

- `MODEL_ADAPTER=mock|hs-gw`：`hs-gw` 缺凭证时会显式降级并标记，不会静默假装可用。
- `LOL_ADAPTER=mock|http`：目前只有 mock 实现。
- 预算：`BUDGET_*`，默认每轮 3 次模型、3 次工具、整轮 30s。
- `DEV_ALLOW_MOCK_INGEST`：生产强制为 false，否则拒绝启动。

## 文档与边界检查

`pnpm check-context` 会校验：

- 15 个必需文档/配置入口存在；
- `AGENTS.md` 指向 project/tasks/docs 索引；
- 角色名固定为「大肥鱼」；
- contracts 导出四个协议模块；
- 两个 skill 有 `name`/`description` 元数据；
- **web 与 contracts 不 import server、不读 `process.env`、不含服务端令牌名或 `dev-only-` 字面量。**

最后一条是防止令牌/密钥泄漏到前端 bundle 的自动化闸门，已用注入探针验证会失败退出。

## 数据位置

- 默认 `DATA_DIR=runtime`，相对**仓库根**解析（`apps/server/src/paths.ts`），
  所以从 `apps/server` 启动也不会把数据库落在子目录。
- 运行产物不进 Git（`.gitignore` 已排除 `runtime/`）。

## 常见问题

- **`ERR_PNPM_IGNORED_BUILDS`**：`pnpm-workspace.yaml` 的 `allowBuilds` 需要包含 `better-sqlite3`、`esbuild`。
- **e2e 报 “Executable doesn't exist”**：本机没有 Chrome 时执行 `pnpm exec playwright install chromium`，
  并把 `playwright.config.ts` 的 `channel: 'chrome'` 去掉。
- **改了前端但 e2e 没变化**：e2e 用 `apps/web/dist`，先 `pnpm --filter @dafeiyu/web build`。
