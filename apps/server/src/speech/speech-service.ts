import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeechTiming } from '@dafeiyu/contracts';

/**
 * TTS 适配层。
 *
 * 真实 TTS 服务协议、音色与可直播使用条件均未核实（见 docs/references.md），
 * 因此这里只定义接口 + 一个**明确标记为 mock** 的本地合成实现：
 * 生成可播放的 WAV（按文本长度决定时长，正弦波 + 轻微包络），
 * 让 P2 的音画同步链路可以被真实浏览器播放验证，而不是假装有音频。
 *
 * 真实适配器接入时只替换实现，不动舞台契约与前端。
 */
export type SynthesizeInput = {
  speechId: string;
  text: string;
  signal: AbortSignal;
};

export type SynthesizeResult = {
  /** 相对 URL，例如 /media/tts/xxx.wav */
  audioUrl: string;
  durationMs: number;
  /** 句级时间片；真实 TTS 若不给词级时间戳，也只到这里。 */
  timings: SpeechTiming[];
  /** 音色标识，写进 trace 与 studio 状态。 */
  voice: string;
  isMock: boolean;
  source: 'mock' | 'tts';
};

export interface SpeechService {
  readonly available: boolean;
  readonly isMock: boolean;
  readonly voice: string | null;
  /** 不可用的原因，供 studio 展示；可用时为 null。 */
  readonly unavailableReason: string | null;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

const SAMPLE_RATE = 16_000;
const MIN_DURATION_MS = 700;
const MS_PER_CHAR = 150;
/**
 * 单段音频时长上限。WAV 是未压缩 PCM：16kHz 16-bit 单声道约 32KB/s，
 * 60s 已经接近 2MB。不设上限时，一段超长文本会让进程分配巨量内存。
 */
const MAX_DURATION_MS = 60_000;
/** 文本长度上限：超过就截断（同时防止时间片数量爆炸）。 */
const MAX_TEXT_CHARS = 400;

export type MockSpeechOptions = {
  /** 音频文件输出目录（相对 URL 前缀固定为 /media/tts/）。 */
  outputDir: string;
  publicPrefix?: string;
  voice?: string;
  now?: () => Date;
};

/**
 * 本地 mock TTS：生成真实可播放的 WAV。
 *
 * 它不伪装成真实语音：返回 `isMock: true`、`voice: 'mock-sine'`，
 * 一路传到 SpeechPlan.audioIsMock 与舞台角标。
 */
export class MockSpeechService implements SpeechService {
  readonly available = true;
  readonly isMock = true;
  readonly voice: string;
  readonly unavailableReason = null;
  private readonly publicPrefix: string;

  constructor(private readonly options: MockSpeechOptions) {
    this.voice = options.voice ?? 'mock-sine';
    this.publicPrefix = options.publicPrefix ?? '/media/tts';
    mkdirSync(options.outputDir, { recursive: true });
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    if (input.signal.aborted) throw new Error('tts cancelled');

    // 截断超长文本，并把时长夹在 [MIN, MAX]，避免生成超大 WAV 拖垮进程。
    const text = input.text.slice(0, MAX_TEXT_CHARS);
    const durationMs = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, text.length * MS_PER_CHAR),
    );
    const fileName = `${sanitize(input.speechId)}-${hash(text).slice(0, 8)}.wav`;
    const filePath = join(this.options.outputDir, fileName);

    if (!existsSync(filePath)) {
      writeFileSync(filePath, buildToneWav(durationMs, SAMPLE_RATE));
    }

    return {
      audioUrl: `${this.publicPrefix}/${fileName}`,
      durationMs,
      timings: splitSentenceTimings(text, durationMs),
      voice: this.voice,
      isMock: true,
      source: 'mock',
    };
  }
}

/**
 * 未配置真实 TTS 时的显式替身：不合成、不假装可用。
 * 上层据此把 SpeechPlan.audioUrl 置为 null（纯字幕模式）。
 */
export class UnavailableSpeechService implements SpeechService {
  readonly available = false;
  readonly isMock = false;
  readonly voice = null;

  constructor(readonly unavailableReason: string) {}

  async synthesize(): Promise<SynthesizeResult> {
    throw new Error(this.unavailableReason);
  }
}

/** 句级时间片：按标点切句，按字数比例分配时长。 */
export function splitSentenceTimings(text: string, durationMs: number): SpeechTiming[] {
  const sentences = text
    .split(/(?<=[。！？!?；;…])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const share = Math.round((sentence.length / totalChars) * durationMs);
    const startMs = cursor;
    // 最后一句强制覆盖到音频结束：逐句取整的误差不能留出“无人覆盖”的尾巴。
    const isLast = index === sentences.length - 1;
    const endMs = isLast ? durationMs : Math.min(durationMs, startMs + share);
    cursor = endMs;
    return { text: sentence, startMs, endMs };
  });
}

/**
 * 生成单声道 16-bit PCM WAV。
 * 用两段正弦 + 起止淡入淡出，保证是可听、可测时长的真实音频文件。
 */
export function buildToneWav(durationMs: number, sampleRate = SAMPLE_RATE): Buffer {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.min(sampleCount / 4, sampleRate * 0.05);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const fadeIn = Math.min(1, i / fadeSamples);
    const fadeOut = Math.min(1, (sampleCount - i) / fadeSamples);
    const envelope = fadeIn * fadeOut;
    // 220Hz 基音 + 轻微 330Hz，模拟“说话”的起伏而不是纯音。
    const wave =
      Math.sin(2 * Math.PI * 220 * t) * 0.6 +
      Math.sin(2 * Math.PI * 330 * t) * 0.2 +
      Math.sin(2 * Math.PI * 4 * t) * 0.05;
    const sample = Math.max(-1, Math.min(1, wave * envelope * 0.35));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buffer;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
