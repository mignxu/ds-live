# 数据保留与长期记忆

## 保留期限

配置项（`.env`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RETENTION_EVENTS_DAYS` | 7 | 去重表（只用于防重放） |
| `RETENTION_MESSAGES_DAYS` | 7 | 会话消息（**含观众原文**） |
| `RETENTION_TURNS_DAYS` | 30 | 轮次与工具调用（排查/审计） |
| `RETENTION_SOUVENIRS_DAYS` | 30 | 已公开纪念品 |
| `RETENTION_MEMORIES_GRACE_DAYS` | 0 | 过期记忆额外宽限 |
| `RETENTION_INTERVAL_MINUTES` | 60 | 清理间隔；0 表示关闭 |

**0 表示不自动清理**（需要运维手动处理，慎用）。

### 实现要点

- 每条 `DELETE` 都带 `LIMIT`（默认 5000/2000/1000），避免一次删除太多行长时间锁库。
- 删除轮次时**先删 `tool_calls` 再删 `turns`**，避免外键失败。
- 清理在后台定时执行（`unref()`，不阻止进程退出），失败只记日志。
- 控制台可预览（`retention_preview`）与手动执行（`retention_run`）。

### 为什么原始弹幕不长期保存

设计文档明确：原始弹幕不长期保存，普通会话 7 天。
观众原文是隐私数据，保留越久风险越大；排查问题用 7 天足够。

## 长期记忆

表 `memories`，字段包含作用域、来源、置信度、过期时间。

### 作用域

| scope | 含义 | 加载条件 |
| --- | --- | --- |
| `session` | 仅本场直播 | 同 `sessionId` |
| `viewer` | 同一 viewerId 跨会话 | 同 `viewerId` |

会话级记忆**不跨会话泄露**；观众级记忆**不跨观众泄露**（有测试）。

### 来源

| source | 含义 |
| --- | --- |
| `viewer-stated` | 观众明说（“记住 xxx”） |
| `session-derived` | 会话内推断（当前未使用） |
| `admin` | 主播在控制台设置 |

**模型推断不作为唯一来源**：模型无法直接写记忆，只能由 `MemoryService.captureExplicit`
从观众明示语句提取。

### 写入边界

- **key 白名单**：`preferred_topic`、`nickname_pref`、`play_style`、`signature_style`。
  白名单外一律拒绝，防止往记忆里塞 `system_prompt` 之类的东西。
- **身份类指令不写回**：包含「你是/你不是/改名/叫我…模型/忽略…规则」的语句直接丢弃。
- **不进角色身份**：记忆作为**独立一条 `system` 消息**附加，`trusted=false`，
  并明确标注“可能过时，观众纠正时以最新说法为准”。

### 可查看 / 纠正 / 清除

| 操作 | 接口 |
| --- | --- |
| 查看（含过期） | `GET /api/studio/memories` |
| 删除单条 | `POST /api/studio/control` `{action:'memory_delete', memoryId}` |
| 清空某观众 | `POST /api/studio/control` `{action:'memory_clear_viewer', viewerId}` |

### 不用记忆替代业务数据

游戏分数、战绩、Boss 血量都在 `program_runs` / `game_actions`，**不在记忆里**。
模型记忆只用于“这个观众喜欢聊什么”这类软偏好。

## 验收

`apps/server/test/memory-retention.test.ts`（16）：

- 只删过期行、新数据保留；0 天不清理
- 删轮次先删 tool_calls 不触发外键
- 预览统计与清理数量一致
- 记忆同 key 覆盖、白名单拒绝、过期不加载
- 观众级/会话级隔离
- 单条删除与按观众清空
- “记住 xxx”捕获、身份指令拒绝、普通聊天不写
- 摘要渲染含 key/来源/“可能过时”

## 未做

- 记忆的“观众自助查看”入口（当前只有控制台）。
- 记忆合并/去重策略（同 key 直接覆盖）。
- 敏感信息识别（如手机号、地址）后再决定是否入库。
