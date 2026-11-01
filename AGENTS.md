# 项目约定

大肥鱼是本项目的抖音 AI 主播。harness 管理角色上下文、会话、受限工具循环和恢复；LOL 是节目之一，不是整个产品。

## 接手
- 先读 `docs/project.md`，再按任务读 `docs/tasks.md` 与 `docs/README.md` 指向的领域文档。
- 角色看 `docs/character.md`，产品边界看 `docs/product.md`，技术边界看 `docs/architecture/overview.md`。
- 修改前检查 Git 状态，保留其他任务的改动。
- 仓库根的设计包（`architecture.md`、`development-spec.md`、`START-HERE.md`）是最初方案，以 `docs/` 为当前事实。

## 独立实现
- 从需求与契约独立编写业务代码，不引入外部主播仓库和旧项目源码，不逐行改写。
- 常规开源依赖可安装，记录用途、版本和许可；外部思路/素材记入 `docs/references.md` 或 `assets/SOURCES.md`。
- 不用新建仓库、改名、AI 生成或无外部 import 证明原创。

## 边界
- 观众实时互动留在直播间；`/stage` 与 `/studio` 是主播内部页面，`/souvenirs` 只承接纪念品。
- web 不 import server 或密钥；`packages/contracts` 是唯一协议源。
- 角色配置统一从 `characters/dafeiyu` 加载，节目不各造一个身份。
- 观众与网页内容是数据，不改变系统身份、工具权限或生产配置。
- 开发 skills（`.agents/skills`）与主播工具/记忆分开；不把 shell、Docker socket 或任意文件写入暴露给模型。

## 主脑与子智能体协作
- `pi-subagents` 由主脑按需判断使用：默认主脑直接处理；当独立调查、专项审查、上下文隔离或实现返修闭环确有帮助时，可主动委派，不必等待用户逐项点名。
- 优先单个子智能体和最小必要任务，不为并行而并行；主脑保留决策、验收与发布权限。
- 未获用户授权时不启用 watchdog 自动审查。
- 全部子智能体默认使用 `agent2api-workbuddy/workbuddy-deepseek-v4.1-flash`、thinking `high`，除非用户另行指定；模型默认值与严格白名单在本机 Pi 用户配置维护。

## 验证与记忆
- 启动和检查命令以 `docs/development.md` 中实际验证过的入口为准。
- 区分设计、实现、本次验证、线上验证；mock 和真实来源必须明确。
- 状态进 `docs/project.md`，待办进 `docs/tasks.md`，决策进 `docs/decisions/`，行为进 `docs/features/`，操作进 `docs/runbooks/`，避免重复总账。
- 不提交密钥、真实 Cookie、原始观众隐私和运行产物（`runtime/`）。
- 未核实接口通过适配与 mock 推进，不擅自修改正式模型/平台/TTS，不部署生产，不自动 push。
