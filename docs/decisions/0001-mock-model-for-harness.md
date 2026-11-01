# ADR-0001：首版工具循环用确定性 mock 模型验证

日期：2026-10-31
状态：已采纳

## 背景

hs-gw 的真实协议、凭证和能力都未核实。P1 必须先证明“模型可以按输入选择调用或不调用工具，
观察结果后继续回应，并且超时/预算/取消能停下”，否则后面所有节目都建在未验证的循环上。

## 决策

实现 `MockModelGateway`：遵循与真实适配器完全相同的 `ModelGateway` 契约
（`AssistantTurn` + `toolCalls` + `capabilities`），按关键词决定是否请求工具。
`capabilities.modelId = 'mock-deterministic-v1'`，不冒充真实模型。

同时保留 `HsGwModelGateway`（OpenAI 兼容形态的假设实现），凭证缺失时用 `NotConfiguredModel`
显式抛错并把 runtime 标记为降级，**不静默切换**。

## 影响

- 优点：harness 的循环、预算、取消、工具观察、失败处理都能被确定性测试覆盖（52 项后端测试）。
- 代价：mock 模型的行为不代表真实模型；角色质量无法用这些测试证明。
- 边界：`docs/project.md` 与 `docs/references.md` 明确标注“模型是 mock”。
- 后续：`pnpm eval:character`（ENG-005）用真实模型跑 `characters/dafeiyu/examples.json`。

## 替代方案

- 先接真实 hs-gw 再写 harness：被凭证缺失阻塞，且无法确定性地测取消/超时。
- 直接在业务代码里 if/else 硬编码回应：会退化成“只会锐评的固定流水线”，被设计文档明确禁止。

## 补充（同日）：hs-gw 适配器的契约测试

`HsGwModelGateway` 按「OpenAI 兼容 chat completions + tools」假设实现，未联调。
为防止这个假设实现自身不自洽，加了本地假网关的契约测试（`apps/server/test/hs-gw-model.test.ts`）：

- assistant 的 `tool_calls` 与 tool 消息的 `tool_call_id` 必须成对，否则真实网关会 400；
- 未登记的工具名被丢弃，不进入 `toolCalls`（不能靠模型自报工具名绕过白名单）；
- 上游 5xx 抛错，不返回伪造文本；
- 错误信息不回显 API key。

这只证明“我们的假设实现内部自洽”，**不证明 hs-gw 真的长这样**。协议核实后仍需重跑。
