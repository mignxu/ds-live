# ADR-0003：舞台播放用 renderer 租约，拒绝旧主回执

日期：2026-10-31
状态：已采纳

## 背景

设计文档要求：OBS 与控制台只允许一个音频主播放器；多浏览器连接通过带 fencing token 的
renderer lease 选主，后端拒绝旧主回执；租约切换旧播放器应停音；不能假设网络分区绝无重复播放。

## 决策

- 每个 WS 连接在握手成功后调用 `acquireRendererLease()`，拿到新的 `rendererToken`，
  并在首帧 snapshot 里下发。
- 服务端只保留最新租约；`handleReceipt` 校验 `rendererToken`，不匹配返回
  `{ accepted: false, reason: 'stale_renderer_lease' }`。
- 前端收到 `receipt.rejected` **不重连**，只停止本地播放并提示，避免“回执被拒 → 重连 → 抢租约”的抖动。
- 服务端主动结束/取消语音时，前端停止本地播放但**不回执**（`suppressReceiptRef`），避免重复结束。

## 影响

- 新连接即接管：这是首版简化（OBS 重启即可夺回）。真正的“主播手动选主”留给控制台功能扩展。
- 无法完全排除网络分区导致的重复出声，但旧主回执会被拒绝，状态不会错乱。
- 控制台目前根本不创建播放器，因此“控制台不抢音”由代码结构保证，不靠配置。

## 验证

- `apps/server/test/ws.test.ts`：旧 renderer 回执被拒。
- `apps/server/test/runtime.test.ts`：租约切换、播完清空 activeSpeech、mock 标记透传。
- `tests/e2e/stage.spec.ts`：手动停止回到待机。

## 补充（同日）：前端抑制回执必须按 speechId

最初实现用一个布尔 `suppressReceiptRef` 表示“这次本地停止不要回执”。实际会出问题：

服务端在同一帧里可能先广播 `speech.cancelled`（旧句）再广播 `speech.ready`（新句）。
旧句的 `handle.done` 回调在新句启动之后才执行，而新句启动会把布尔重置为 false，
于是旧句仍然发出回执 → 服务端返回 `unknown_speech` → 前端按“回执被拒”停止本地播放 → 误停新句。

修正：

- 用 `Set<speechId>` 记录被服务端结束的句子；
- 用 `playingSpeechIdRef` 判断“服务端取消的是不是当前正在播的这句”，不是就只记抑制、不动播放。

这个缺陷没有单元测试能直接覆盖 React 时序，因此额外验证了 outlet 的单出口语义
（新 play 会 stop 旧句，两个 `done` 各自独立结算），并在 e2e 里保留“手动停止回到待机”用例。
