# 活动任务

只列未完成的事。完成的任务把结论写进 `docs/features/` 或 `docs/project.md`，然后从这里删除。

## 已交付（不再列在这里）

- P0 角色聊天、P1 有界工具循环、P2 音频与句级字幕
- P3 LOL 锐评、P4 签名 / 合作打 Boss / 纪念品
- ENG-001 多房间、ENG-002 记忆与保留、ENG-003 定时清理、ENG-004 eval、ENG-005 组件测试、ENG-006 并发
详见 `docs/project.md` 与 `docs/features/`。

---

## 真实联调（阻塞项都在用户侧）

- [ ] **REAL-001 hs-gw 协议核实**
  拿到真实 base URL/认证/模型名后，按真实响应修正 `apps/server/src/harness/hs-gw-model.ts`，
  并把 `test/hs-gw-model.test.ts` 的假设形状换成真实样本。
- [ ] **REAL-002 真实 TTS 适配器**
  实现 `SpeechService` 的第二个实现（HTTP TTS）。需要：协议、音色 ID、
  可直播使用条件、输出格式、时间戳能力。验收：`audioIsMock=false`，时间片来自真实服务。
- [ ] **REAL-003 抖音弹幕接入**
  写 `ingress/` 的真实适配器，把平台 payload 映射成 `IngressSubmission`。
  需要：允许的接入方式、真实 payload、事件与观众标识可用性。
- [ ] **REAL-004 LOL 真实接口**
  `LOL_ADAPTER=http` 已就绪但未联调。需要外部地址、鉴权、查询参数、响应样本。
- [ ] **REAL-005 用真实模型跑 eval**
  `pnpm eval:character --model hs-gw`，把结果与 `characters/dafeiyu/examples.json`
  的期望逐条人工比对，记录模型版本与偏差。

---

## 工程债

- [ ] **ENG-009 房间空闲回收**
  当前房间创建后常驻。需要 `lastActiveAt` + 空闲超时回收，
  并确保回收时取消队列、中断合成、清理租约。
- [ ] **ENG-010 记忆的观众自助入口**
  当前只有控制台可查看/清除。需要一个带短期凭证的观众页面（不能靠 viewerId 授权）。
- [ ] **ENG-011 敏感信息识别**
  记忆入库前识别手机号/地址等，默认不存或脱敏。
- [ ] **ENG-012 Studio / Souvenirs 组件测试**
  当前只有 StagePage 有 RTL 测试，其余靠 e2e。
- [ ] **ENG-013 保留清理的可观测性**
  目前只记日志；需要指标（清理耗时、删除行数）供监控。
- [ ] **ENG-014 多实例部署**
  需要 Redis 或粘性会话做房间路由；当前明确是单进程。
- [ ] **ENG-015 CI**
  用户未授权前不配；需要时直接调用 `pnpm check` + `pnpm test:e2e`。
- [ ] **ENG-016 部署**
  Dockerfile / compose / 反向代理 / 健康检查 / 回滚路径。**本轮未授权，未做。**

---

## 待用户提供

- hs-gw：base URL、认证方式、模型名、tools/结构化输出能力、超时与限额
- TTS：协议、音色、许可、输出格式、时间戳能力
- 弹幕：允许的接入方式、真实 payload、事件与观众标识
- LOL：外部 HTTP 地址、鉴权、查询参数、响应样本
- 角色：风格选择、正式外形素材来源、正式音色
- 部署：ts1 当前负载、Windows OBS 音视频接入方式
