# ADR-0004：令牌传输与日志脱敏

日期：2026-10-31
状态：已采纳

## 背景

舞台页面要给 OBS 浏览器源使用，配置令牌最方便的方式是 URL query（`/stage?token=...`）。
但令牌出现在 URL 会带来两个真实风险：

1. **日志泄露**：Fastify 默认 pino 序列化会记录完整 `req.url`，包括 query。
2. **Referer / 缓存泄露**：浏览器可能把带令牌的 URL 带给第三方或写入缓存。

控制台另有 CSRF 风险：如果写操作接受 Cookie，浏览器会自动带同站 Cookie，
是否安全就取决于浏览器默认 SameSite 策略。

## 决策

1. 舞台页面从 URL 读取令牌后**立即用 `history.replaceState` 移除 query**（`stripTokenFromUrl`）。
2. 服务端请求日志使用 `safeRequestSerializer`，只记录 `path`（不含 query）。
3. 所有响应带 `cache-control: no-store`、`referrer-policy: no-referrer`；
   `/api/*` 额外带 `x-frame-options: DENY`。
4. 写操作（`POST /api/studio/control`）**只接受 Header 令牌**，不接受 Cookie。
   读状态允许 Cookie，仅为本机调试方便。
5. WS 握手允许 `?token=`（浏览器 WS API 不能自定义 Header），
   但该 URL 不进入 HTTP 请求日志（WS 升级请求的 path 已被剥离 query）。

## 影响

- OBS 配置方便，但令牌会短暂出现在地址栏；已用 replaceState 立即清除。
- 本机实测：生产模式日志 `grep probe-stage-token` 结果为 0。
- 仍然建议生产用反向代理 + 私有网络，不要直接暴露 8787。

## 替代方案

- 只允许 Header：OBS 浏览器源无法设置自定义 Header，不可行。
- Cookie 鉴权 + CSRF token：更完整，但首版没有用户体系，成本不匹配。
