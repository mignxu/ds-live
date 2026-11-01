# 外部来源与依赖记录

## 实现来源

本项目从仓库根的设计包（`README.md`、`architecture.md`、`development-spec.md`、`START-HERE.md`）
独立实现。**未带入任何外部主播项目、旧项目代码、测试或配置**；没有克隆、fork 或复制其他主播仓库。

本轮（P0/P1）全部业务代码、提示词、节目规则、页面与测试由本次开发按需求编写。

不把“AI 生成”“新建仓库”“没有 import 对方包”作为法律意义的原创证明。
后续若引入外部实现或素材，必须在下面登记。

## 依赖清单（本轮实际安装，版本已锁定在 pnpm-lock.yaml）

| 依赖 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| fastify | 5.12.7 | MIT | HTTP 服务与测试注入 |
| @fastify/cookie | 11.1.5 | MIT | 控制台 Cookie 令牌读取 |
| @fastify/static | 10.1.8 | MIT | 生产分发前端构建 |
| @fastify/websocket | 11.3.5 | MIT | 舞台 WS 订阅与回执 |
| ws | 8.22.0 | MIT | 服务端 WS 集成测试客户端（dev） |
| better-sqlite3 | 13.0.3 | MIT | SQLite 驱动（同步、单进程） |
| zod | 4.6.7 | MIT | 运行时契约校验（唯一协议源） |
| react / react-dom | 19.3.1 | MIT | 三个页面 |
| vite | 8.3.5 | MIT | 前端构建与开发服务器 |
| @vitejs/plugin-react | 6.1.2 | MIT | React JSX 转换 |
| vitest | 5.0.5 | MIT | 单元/集成测试 |
| jsdom | 27.4.0 | MIT | 前端测试环境 |
| typescript | 5.9.3 | Apache-2.0 | 类型检查 |
| eslint | 10.14.0 | MIT | 静态检查（真实缺陷类规则） |
| typescript-eslint | 8.72.1 | MIT | TS 规则集 |
| tsx | 4.23.15 | MIT | 开发与 e2e 启动 TS 入口 |
| @playwright/test | 1.64.1 | Apache-2.0 | 浏览器端到端测试 |

未安装：向量库、多 agent 框架、消息中间件、本地大模型、Redis、Live2D SDK。

## 素材

无第三方素材文件进入仓库。角色视觉为代码绘制，字体使用系统字体栈。
详见 [assets/SOURCES.md](../assets/SOURCES.md)。

## 官方资料（用于能力与约束核对，未复制示例代码）

- Fastify TypeScript — https://fastify.dev/docs/latest/Reference/TypeScript/
- Vite 指南 — https://vite.dev/guide/
- SQLite WAL — https://www.sqlite.org/wal.html
- OBS 浏览器源 — https://obsproject.com/kb/browser-source
- OBS 虚拟摄像头 — https://obsproject.com/kb/virtual-camera-guide
- MediaMTX 发布与读取 — https://mediamtx.org/docs/features/publish-and-read

## 未核实的外部接口（当前均为 mock）

| 接口 | 现状 | 需要的信息 |
| --- | --- | --- |
| hs-gw 模型网关 | `HsGwModelGateway` 按「OpenAI 兼容 chat completions + tools」假设实现，**未联调** | base URL、认证、模型名、tools 能力、超时与限额 |
| TTS | `MockSpeechService` 本地合成 WAV（真实可播放，但**不是真人语音**） | 协议、音色、许可、输出格式、时间戳能力 |
| 抖音弹幕 | 未接入，只有带令牌的 `/api/ingest/events` | 允许的接入方式、真实 payload、观众标识 |
| LOL 查询 | mock 数据源；`LOL_ADAPTER=http` 有 egress 校验骨架但未联调 | 外部 HTTP 地址、鉴权、参数、响应样本、额度语义 |

这些未核实项不阻止继续 mock 开发，但真实上线验收必须单独完成，不能把 mock 当线上。

## 记录规则

引入外部资源时登记：来源 URL/版本、只借鉴何种思路、是否带入代码或资产、许可、涉及本地模块、检查结果。
无外部实现引用也如实注明。
