# 多房间

## 为什么

单房间时 `StageService` / `Scheduler` / `ProgramManager` 都是单例，`ROOM_ID` 写死。
真实直播可能同时开多个直播间，或需要“彩排房间 + 正式房间”隔离。

## 结构

```text
Runtime（进程级，共享）
├── db / repository          单写入，共用
├── model                    网关无状态，共用
├── tools / programTools     工具执行器无状态，共用
├── speech                   TTS 适配器，共用（文件按 speechId 命名，不冲突）
├── souvenirs / memories     跨房间查询，共用
└── rooms: RoomRegistry      按需创建，最多 MAX_ROOMS 个
    ├── room-a
    │   ├── StageService     独立 revision / 租约 / programState
    │   ├── Scheduler        独立队列 / 取消
    │   ├── ProgramManager   独立节目 / Boss 回合
    │   └── IngressNormalizer 独立限流桶
    └── room-b
        └── ...
```

**隔离的是有状态的**：队列、租约、回合、限流、节目。**共享的是无状态的**：数据库、模型、工具、TTS。

## 路由

| 接口 | 房间参数 |
| --- | --- |
| `POST /api/ingest/events` | 请求体 `roomId`（必填） |
| `GET /api/stage/snapshot` | `?room=`，缺省默认房间 |
| `WS /api/stage/events` | `?room=`，缺省默认房间 |
| `GET /api/studio/status` | `?room=` |
| `POST /api/studio/control` | `?room=` |

房间**按需创建**：第一次出现 `roomId` 时创建运行时；超过 `MAX_ROOMS`（默认 20）时
`POST /api/ingest/events` 返回 `429 too_many_rooms`，**不静默丢弃**。

## 为什么限制房间数

外部事件可以带任意 `roomId`。不设上限的话，一个恶意/错误适配器就能让进程创建无数
Stage/Scheduler 实例，撑爆内存。上限是资源保护，不是业务限制。

## 关键不变量

1. **租约不跨房间**：A 房间的 `rendererToken` 在 B 房间一定被拒（`stale_renderer_lease`）。
2. **回合 ID 不冲突**：`boss_${时间}_${回合}_${随机后缀}`，跨房间/重置都不撞主键。
3. **队列独立**：A 房间卡住不影响 B 房间出话。
4. **限流独立**：A 房间的观众刷屏不会让 B 房间被限流。
5. **Boss 自动结算覆盖所有房间**：1s tick 遍历 `rooms.all()`。

## 验收

- `apps/server/test/rooms.test.ts`（9）：状态隔离、计分隔离、队列隔离、租约不跨房间、
  上限拒绝、控制台按房间查询与操作。
- `apps/server/test/concurrency.test.ts`（4）：200 观众并发提交、同观众并发去重、
  并发结算只结算一次、5 房间并发互不串台。
- `tests/e2e/rooms.spec.ts`（5）：两个房间 Boss 互不影响、舞台按 room 订阅、
  控制台按 room 查询与操作、超限拒绝。

## 未做

- 房间空闲回收（当前创建后常驻，便于复盘）。
- 跨进程/多实例的房间路由（需要 Redis 或粘性会话；当前单进程）。
- 每房间独立的预算/限流配置（当前共用全局配置）。
