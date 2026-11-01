# ADR-0006：TTS 用本地可播放 WAV 做 mock，而不是假装有音频

日期：2026-10-31
状态：已采纳

## 背景

P2 要求“音频实际播放带动字幕、口型与状态”。真实 TTS 协议、音色与许可都未核实。
如果用 `audioUrl=null` 假装完成 P2，就等于没验证音频链路；
如果随便接一个真实 TTS，又违反“不擅自修改正式 TTS 选型”。

## 决策

实现 `MockSpeechService`：

- 生成 **16kHz 单声道 16-bit PCM WAV**（220Hz + 330Hz 正弦 + 起止淡入淡出 + 4Hz 起伏）。
- 时长按文本长度估算（≥700ms，150ms/字）。
- 返回句级 `timings`（按标点切句 + 字数比例）。
- 明确标记 `isMock: true`、`voice: 'mock-sine'`，一路传到 `SpeechPlan.audioIsMock` 与舞台角标。

舞台用 `HTMLAudioElement` 播放，`timeupdate` 驱动字幕与口型；
音频加载失败时明确显示“音频不可用，仅字幕”，不假装在播。

`SPEECH_ADAPTER=none` 时用 `UnavailableSpeechService`，显式降级为纯字幕，studio 显示原因。

## 影响

- 音频链路（文件生成、HTTP 提供、浏览器播放、时钟同步、失败降级）全部被真实验证。
- 听起来是提示音，不是人声——这**必须**在 UI 和文档里写明，不能当成品音色。
- 换成真实 TTS 只需实现同一个 `SpeechService` 接口，前端与契约不动。

## 替代方案

- 只做字幕：P2 验收项无法通过。
- 用浏览器 `SpeechSynthesis`：那是浏览器本地合成，无法验证服务端音频资产、回执与租约链路。
- 下载第三方语音样本：来源与许可不明，且违反“不引入外部素材”约束。
