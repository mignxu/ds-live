---
name: project-handoff
description: 接手、恢复或交接大肥鱼项目时使用。核对 Git 状态、docs/project.md、docs/tasks.md、相关契约与最近一次验证，把结论写回唯一事实归属处。
---

# 接手项目

## 何时用

- 新会话开始，要改这个仓库的任何东西之前。
- 上一个会话中断，需要判断哪些已完成、哪些只是设计。
- 要把工作交接给其他人或另一个 agent。

## 步骤

1. `git status` 和 `git log --oneline -10`：确认工作区是否有他人未提交的改动，**不要覆盖**。
2. 读 `docs/project.md`：看“已实现 / 最新验证 / 已知限制”。这里写的是事实，不是计划。
3. 读 `docs/tasks.md`：只列未完成项。不要重做已从这里移除的任务。
4. 按任务领域读一份文档：
   - 聊天/harness → `docs/features/chat-and-harness.md`
   - 模块边界/权限 → `docs/architecture/overview.md`
   - 命令与环境 → `docs/development.md`
   - 角色 → `docs/character.md`
5. 核对“最近验证”是否仍成立：至少跑一次 `pnpm check`（必要时 `pnpm test:e2e`）。
   如果结果与 project.md 不符，先修正文档，再动代码。
6. 确认 mock 与真实边界：当前模型、LOL、搜索、TTS 全是 mock 或未接入，不要当线上。

## 写回规则

- 状态变化 → `docs/project.md`
- 新待办 / 已完成项移除 → `docs/tasks.md`
- 新取舍 → `docs/decisions/NNNN-*.md`
- 新行为与验收 → `docs/features/*.md`
- 新命令/环境要求 → `docs/development.md`
- 新外部依赖或素材 → `docs/references.md` 或 `assets/SOURCES.md`

每个事实只写一处，其他地方链接。

## 不要做

- 不要把设计包里的方案当成已实现。
- 不要为了让状态看起来更好而修改“最新验证”结果。
- 不要提交密钥、真实 Cookie、观众隐私、`runtime/` 产物。
- 不要自动 push 或部署。
