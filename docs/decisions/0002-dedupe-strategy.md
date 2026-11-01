# ADR-0002：去重策略与误判边界

日期：2026-10-31
状态：已采纳

## 背景

设计文档要求“服务端分配可信字段”“平台若无可靠事件 ID，记录后备去重的误判边界，
不能承诺 exactly-once”。真实抖音弹幕 payload 尚未核实，不知道是否提供稳定事件 ID。

## 决策

两条路径，且**把用的哪条如实写进响应**：

1. 适配器提供 `eventId` → `pid:{roomId}:{eventId}`，视为可信。
2. 没有 `eventId` → `fp:{roomId}:{viewerId}:{15s 窗口}:{payload 的 sha256 前缀}`，
   响应里 `dedupeStrategy: 'content-fingerprint'`。

`processed_events` 表带 `processed_at`，由 `pruneProcessedEvents` 清理（保留期见配置）。

## 影响与边界

- 内容指纹的误判：同一观众在 15 秒内重复发完全相同的内容会被当成重复事件丢掉。
  这是可接受的取舍（防刷屏优先），但**必须**在接入文档里写清，不能宣称 exactly-once。
- 没有 `eventId` 时服务端生成 `srv_{uuid}` 作为内部 eventId，不代表平台侧身份。
- `viewerId` 缺失时退化为 `anon_{roomId}`，即全房间共用一个桶：限流更严，去重更粗。

## 替代方案

- 只支持 `eventId`：真实接入可能完全不可用。
- 用时间戳做唯一键：客户端时间不可信，重放会失败。
