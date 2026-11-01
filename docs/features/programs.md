# 领域行为：节目（LOL / 签名 / Boss）

## 共同边界

- 节目维护**确定性事实与状态**：分数、回合、签名文件。
- 模型只负责“怎么说”，且只在 `chat` / `lol` 节目里参与。
- 节目不能调用模型供应商，也不能自己创建播放线程。
- 节目执行器与模型执行器**分开**：模型白名单只有只读工具（`lol.lookup`、`web.search`），
  写工具（`signature.create`）只挂在节目执行器上，模型永远拿不到。

## 命令解析（不劫持普通聊天）

`apps/server/src/programs/program-manager.ts` 的 `parseCommand`：

| 输入 | 结果 |
| --- | --- |
| `查战绩 Faker#KR1` / `战绩 xxx` / `查 xxx` | `lol` |
| `签名 大肥鱼` / `签名`（无文字时用昵称） | `signature` |
| `开Boss` / `开团` / `开始打boss` | `boss.open`（**节目入口，任何时候都认**） |
| `攻击` / `蓄力` / `治疗` / `结算` | 仅当**当前在 boss 节目**或带 `/` `#` 前缀时生效 |
| `/攻击`、`/签名 xxx` 等显式前缀 | 任何时候都生效 |
| 其它任何文本 | `chat`（走模型） |

**为什么这样设计**：`治疗一下我的菜`、`打`、`奶`、`查了下天气预报`、`签名怎么弄啊`
这类普通聊天不能被当成命令。裸词只在对应节目里生效；`开Boss` 因为语义明确，作为入口随时可用。

有测试守护：`programs.test.ts` 的「chat 节目里的裸动作词不会被劫持」「裸“查”不再被当作战绩查询」
「“签名怎么弄啊”不会被当作签名申请」。

## LOL 锐评

1. 弹幕命令 → `lol.lookup`（节目执行器）。
2. 成功：证据卡片（段位/位置）+ 台词，带 `mock` 标记。
3. 失败：明确说“没查到”，**不编造战绩**。
4. 超时：说“服务超时”，`retryable=true` 但不在本轮自动重试。

真实 HTTP 适配器（`LOL_ADAPTER=http`）已包含统一 egress 校验：
只允许 https、拒绝 loopback/内网/链路本地/云元数据、`redirect:'error'`、响应体上限 256KB。
**但未与真实服务联调**，契约未核实。

## 现场签名

1. 弹幕 `签名 xxx` → `signature.create`。
2. 生成原创 SVG 笔迹（每个字符确定性贝塞尔路径，同文本可复现）。
3. 写入 `souvenirs` 表 + `STORAGE_ROOT/souvenirs/`，返回公开 `publicId` 与 `/souvenirs/<id>`。
4. 舞台显示签名卡片（带图），纪念品页可查看与下载。

明确标注：**原创笔迹占位，不是真人手写**。

## 合作打 Boss

状态机：`idle → open → settling → resolved`。

| 规则 | 值 |
| --- | --- |
| 输入窗口 | 20s（可配置） |
| 每观众每回合 | 1 次（内存 Map + **数据库唯一约束**双保险） |
| attack | 每票 6 伤 |
| charge | 每票 10 伤 |
| heal | 每票回 5 血 |
| Boss 反击 | 4 + floor(回合/3) |

关键行为：

- 窗口到点后提交被拒绝，并**自动结算**；迟到输入不进入已结束回合。
- 重复结算返回同一结果，不重复扣血、不重复归档。
- Boss/队伍阵亡后开新回合会重置血量。
- 结算后归档 `game-report` 纪念品；**不影响当场计分**（结算本身就是计分）。
- 蓄力有代价：每个 `charge` 让队伍额外自损 1 点（有测试）。
- 回合 ID 带随机后缀：`reset` 后同一毫秒开新回合不会与旧主键冲突。
- **窗口到期自动结算**：runtime 每 1s 调 `programs.tick()`，不依赖下一个观众提交。
- **结算只有一条路径**：`BossProgram.onSettled` 回调统一做「更新 run 记录 + 广播 + 播报 + 归档」，
  手动结算与自动结算行为一致。
- **先校验后写库**：被拒绝的动作不会写进 `game_actions`；写库失败会回滚内存提交。

## TTS 与音画同步

- `MockSpeechService` 生成 16kHz 单声道 WAV（正弦 + 包络），真实可播放。
- 返回句级 `timings`（按标点切句 + 字数比例分配时长）。
- 舞台用 `HTMLAudioElement` 播放，`timeupdate` + 兜底定时器驱动字幕高亮与口型。
- 音频加载/播放失败：明确标记 `音频不可用，仅字幕`，不假装在播。
- `SPEECH_ADAPTER=none` 时显式降级为纯字幕，studio 状态显示原因。

## 验收

- `apps/server/test/programs.test.ts`（21）：状态机、窗口、去重、结算幂等、签名可复现、命令解析。
- `apps/server/test/program-manager.test.ts`（9）：LOL/签名/Boss 端到端、TTS 失败降级。
- `apps/server/test/programs-http.test.ts`（15）：HTTP 命令入口、纪念品接口、媒体安全、studio 控制。
- `apps/server/test/speech.test.ts`（11）：WAV 头、非零采样、时间片、复用、取消。
- `tests/e2e/programs.spec.ts`（6）：真实音频请求、句级高亮、Boss 全流程、控制台。
