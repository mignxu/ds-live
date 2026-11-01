# 领域行为：纪念品

## 是什么

直播结束后仍可访问的公开作品：签名图、LOL 战报、游戏结算。

## 硬约束

1. **观众实时互动留在直播间。** `/souvenirs` 不提供任何游戏控制、提交指令或计分入口。
2. **领取纪念品不影响当场参与、计分或结算。** 纪念品是事后归档，不参与回合结算。
3. **只展示明确公开的作品。** 数据库 `is_public = 1` 才可读。
4. **publicId 随机且不可枚举。** 不是平台 `viewerId`，不能用观众身份直接授权。
5. **不暴露服务器路径。** 对外只有相对媒体 URL（`/media/souvenirs/...`）。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/souvenirs?limit=&offset=` | 公开列表，最多 50 条 |
| `GET /api/souvenirs/:publicId` | 单件详情，非法/不存在返回 404 |
| `GET /media/souvenirs/:file` | 图片，只允许 `[A-Za-z0-9_-]+.(svg|wav)` |

## 三种作品

| kind | 来源 | 是否含 mock |
| --- | --- | --- |
| `signature` | 签名节目，原创 SVG 笔迹 | 是（笔迹是占位，不是真人手写） |
| `lol-report` | 预留（当前 LOL 节目只出卡片，不归档） | 视数据源 |
| `game-report` | Boss 结算自动归档 | 否（结算是程序确定的） |

## 页面

`/souvenirs`：

- 列表卡片：图/占位、标题、正文、类型、时间、mock 角标。
- 详情弹窗：大图 + 全文 + 下载链接 + mock 说明。
- 空状态：明确说“还没有公开的纪念品”，不显示示例作品。

## 验收

- `apps/server/test/program-manager.test.ts`：签名与战报写入后可读回；非法 publicId 返回 null。
- `apps/server/test/programs-http.test.ts`：列表/详情/媒体路由；路径穿越与非白名单扩展名被拒。
- `tests/e2e/stage.spec.ts`：纪念品页没有游戏控制按钮；签名可查看与下载。
