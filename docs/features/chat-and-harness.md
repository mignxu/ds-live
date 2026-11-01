# 领域行为：聊天与 harness

## 行为

普通弹幕进入后，harness 执行一轮有界循环：

1. 加载角色身份（来自 `characters/dafeiyu`）与本会话最近消息。
2. 把观众输入作为 `trusted=false` 的用户消息加入上下文。
3. 调用模型，得到 `AssistantTurn`（文本 + 可选工具请求）。
4. 若有工具请求：宿主校验工具名/参数/白名单，执行并记录 `ToolResult`。
5. 把工具结果作为 `trusted=false` 的工具消息回灌，再次调用模型。
6. 模型给出最终文本 → 舞台 `speech.ready`。

## 硬边界（不可被模型或观众放宽）

| 边界 | 默认值 | 配置项 |
| --- | --- | --- |
| 每轮模型调用 | 3 | `BUDGET_MAX_MODEL_CALLS` |
| 每轮工具执行 | 3 | `BUDGET_MAX_TOOL_CALLS` |
| 单次模型超时 | 15s | `BUDGET_MODEL_TIMEOUT_MS` |
| 单次工具超时 | 8s | `BUDGET_TOOL_TIMEOUT_MS` |
| 整轮截止 | 30s（优先于分项） | `BUDGET_TURN_DEADLINE_MS` |
| 队列上限 | 32 | `QUEUE_MAX_PENDING` |
| 每观众每分钟 | 30 | `RATE_LIMIT_PER_MINUTE` |
| 限流桶清理 | 每 60s 清一次过期桶 | 无（防止 Map 无限增长） |

其他规则：

- 重复 `callId` 不重复执行（防止模型自激）。
- 工具失败不自动重试，不编造数据。
- 工具参数按宿主 zod schema 校验，模型无法绕过。
- 工具结果带 `source` 与 `isMock`，一路传到舞台卡片。

## 验收（确定性测试）

`apps/server/test/harness.test.ts`：

- 普通聊天不调用工具
- 需要事实时调用工具并基于结果回答
- 第二轮引用当前会话
- 工具失败不编造
- 工具预算耗尽后停止
- 模型超时有明确失败
- 取消后停止
- 整轮截止优先于分项预算
- 注入系统指令不改变身份
- 工具结果不进系统消息
- 重复 callId 只执行一次

`tests/e2e/stage.spec.ts` 覆盖同样的行为在浏览器里的可见结果。

## 不覆盖

- 真实模型是否会稳定遵守这些规则 → 需要 `eval:character`（未实现）。
- 真实抖音弹幕的 payload 形态。

## 日志与脱敏

- 运行日志只记录 `turnId`、`traceId`、模型/工具名、状态、错误码、耗时。
- **不记录**观众原文、角色提示词正文、工具返回的完整数据。
- 有测试守护：`apps/server/test/harness.test.ts` 的「日志不含观众原文与提示词内容」。
- 前端 bundle 不含任何令牌或密钥（`grep dev-only-*` 为空）；令牌由使用者在 URL 或 localStorage 提供。

## 取消语义

- 被取消的轮次：`turns.phase = CANCELLED`，**不写助手消息、不推送到舞台**。
  没有完成的回应不应该被说出来。
- 服务端主动取消/播完时，前端停止本地播放但不回执（避免重复结束）。

## 工具往返的上下文形状

回灌工具结果时，harness 按“轮”组织，而不是只追加结果：

```text
assistant (tool_calls: [{id, name, arguments}])
tool      (tool_call_id: id, content: <JSON>)
```

原因：OpenAI 兼容网关要求 `assistant.tool_calls` 与 `tool.tool_call_id` 成对，
缺任何一边都会 400。这个形状由 `apps/server/test/hs-gw-model.test.ts` 的假网关断言守护。

注意：这只保证“我们的假设实现自洽”，不证明 hs-gw 真实协议如此（见 tasks P3-000）。

## 中断时的台词规则

预算/截止中断时，最后一轮模型输出常常只是“我查一下，稍等”这类过渡语。
直接当成最终台词会变成空头承诺（说了要查却没查）。因此：

- 若最后一轮模型仍在请求工具 → 丢弃该过渡语，改用明确的“先不查了”类台词；
- 若最后一轮已是普通文本 → 保留它，不无谓丢弃模型的话。

有测试守护：`test/harness.test.ts` 的「预算耗尽时不说“我查一下”这类空头承诺」。
