---
name: add-capability
description: 给大肥鱼新增主播工具或节目（LOL 查询、签名、游戏、搜索等）时使用。先区分“工具事实”与“节目规则”，定义 schema、权限、预算、失败/取消、mock/真实来源，再接 harness 与舞台，最后验证中断与重复事件。
---

# 新增能力

## 第一步：先分清两件事

| | 工具（tools/） | 节目（programs/） |
| --- | --- | --- |
| 职责 | 返回结构化事实与来源 | 维护确定性的玩法状态 |
| 能否调用模型 | 不能 | 不能（通过 runtime 提交命令） |
| 能否改分数 | 不能 | 能，但只能按程序规则 |
| 失败表现 | `ToolResult.status=error` | 明确的节目错误状态 |

模型只能**请求**工具；执行、授权和结果封装永远在宿主。

## 第二步：定义工具契约

1. 在 `packages/contracts/src/tools.ts` 的 `ToolNameSchema` 里加名字（这是白名单，不是装饰）。
2. 在 `apps/server/src/tools/` 新建实现，导出 `ToolImpl`：
   - `definition`：描述 + JSON Schema 参数 + `readOnly`
   - `argumentsSchema`：**宿主侧** zod 校验（模型参数不可信）
   - `execute`：返回 `ToolExecution`，必须带 `source` 与 `isMock`
3. 在 `runtime.ts` 注册，并加入 `ToolExecutor.allowedTools` 白名单。
4. 失败要明确：`errorCode` 用契约里的枚举，`data` 必须为 `null`，不编造。

## 第三步：检查清单

见 `references/capability-checklist.md`。

## 第四步：接 harness 与舞台

- 工具结果自动作为 `trusted=false` 的 tool 消息回灌，无需改 harness。
- 舞台卡片由 `StageService.buildEffects` 生成；如果新工具的结果形态特殊，
  在那里加分支，**不要**在舞台组件里判断工具名。
- mock 标记必须一路传到卡片：`ToolResult.isMock → StageEffect.isMock`。

## 第五步：验证

必须新增的行为测试：

1. 成功路径：结果带 source/isMock。
2. 参数非法：`invalid_arguments`，不执行。
3. 未授权：`permission_denied`。
4. 超时：`timeout`，`data=null`。
5. 取消：`cancelled`。
6. 重复事件/重复 callId 不会重复执行或重复结算。
7. 若是节目：中途取消后状态不残留。

跑：`pnpm check`，涉及页面再加 `pnpm test:e2e`。

## 第六步：写回文档

- 行为与验收 → `docs/features/<领域>.md`
- 新外部来源与许可 → `docs/references.md`
- 新取舍 → `docs/decisions/`
- 完成项从 `docs/tasks.md` 移除

## 禁止

- 不给模型 shell、Docker socket、任意文件写入、数据库管理工具。
- 不为了跑 demo 改正式模型/平台/TTS 默认选型。
- 不把 mock 结果说成真实联调。
- 不在生产进程 eval 模型生成的代码。
