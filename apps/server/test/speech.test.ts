import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockSpeechService,
  UnavailableSpeechService,
  buildToneWav,
  splitSentenceTimings,
} from '../src/speech/speech-service.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-tts-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WAV 生成', () => {
  it('生成合法 WAV 头与正确的数据长度', () => {
    const wav = buildToneWav(1000, 16_000);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    // 1000ms @ 16kHz mono 16-bit = 32000 字节
    expect(wav.readUInt32LE(40)).toBe(32_000);
    expect(wav.length).toBe(44 + 32_000);
  });

  it('采样数据不是全零（真的可播放）', () => {
    const wav = buildToneWav(200, 16_000);
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
    const maxAbs = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(maxAbs).toBeGreaterThan(1000);
  });
});

describe('句级时间片', () => {
  it('按标点切句并按字数分配时长', () => {
    const timings = splitSentenceTimings('第一句话。第二句话！', 2000);
    expect(timings).toHaveLength(2);
    expect(timings[0]?.startMs).toBe(0);
    expect(timings[1]?.startMs).toBe(timings[0]?.endMs);
    expect(timings[1]?.endMs).toBeLessThanOrEqual(2000);
  });

  it('没有标点时只有一句，覆盖全时长', () => {
    const timings = splitSentenceTimings('一句话没有标点', 1200);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 1200 });
  });
});

describe('mock TTS 服务', () => {
  it('生成文件并返回可播放地址，标记 isMock', async () => {
    const outputDir = tempDir();
    const service = new MockSpeechService({ outputDir, publicPrefix: '/media/tts' });
    const result = await service.synthesize({
      speechId: 'speech_test_1',
      text: '你好，我是大肥鱼。',
      signal: new AbortController().signal,
    });

    expect(result.isMock).toBe(true);
    expect(result.source).toBe('mock');
    expect(result.audioUrl.startsWith('/media/tts/')).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(700);
    expect(result.timings.length).toBeGreaterThan(0);

    const fileName = result.audioUrl.split('/').pop() ?? '';
    const filePath = join(outputDir, fileName);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath);
    expect(content.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('相同文本复用同一文件，不重复写盘', async () => {
    const outputDir = tempDir();
    const service = new MockSpeechService({ outputDir });
    const first = await service.synthesize({
      speechId: 'speech_a',
      text: '重复文本',
      signal: new AbortController().signal,
    });
    const second = await service.synthesize({
      speechId: 'speech_a',
      text: '重复文本',
      signal: new AbortController().signal,
    });
    expect(second.audioUrl).toBe(first.audioUrl);
  });

  it('取消后不生成音频', async () => {
    const outputDir = tempDir();
    const service = new MockSpeechService({ outputDir });
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.synthesize({ speechId: 's', text: 'x', signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('未配置 TTS 时显式不可用', () => {
  it('available=false 且给出原因，不假装有音频', async () => {
    const service = new UnavailableSpeechService('TTS 未配置');
    expect(service.available).toBe(false);
    expect(service.isMock).toBe(false);
    expect(service.unavailableReason).toContain('未配置');
    await expect(service.synthesize()).rejects.toThrow(/未配置/);
  });
});

describe('超长文本的内存保护', () => {
  it('时长被夹在上限内，WAV 不会超过约 2MB', async () => {
    const outputDir = tempDir();
    const service = new MockSpeechService({ outputDir });
    const longText = '很长的文本。'.repeat(500); // 3000 字
    const result = await service.synthesize({
      speechId: 'speech_long',
      text: longText,
      signal: new AbortController().signal,
    });

    // 60s @ 16kHz 16-bit mono = 1_920_000 字节数据
    expect(result.durationMs).toBe(60_000);
    const fileName = result.audioUrl.split('/').pop() ?? '';
    const bytes = readFileSync(join(outputDir, fileName));
    expect(bytes.length).toBe(44 + 60_000 * 32);
    expect(bytes.length).toBeLessThan(2_100_000);
  });

  it('时间片数量受文本截断限制', async () => {
    const outputDir = tempDir();
    const service = new MockSpeechService({ outputDir });
    const result = await service.synthesize({
      speechId: 'speech_many',
      text: '句子。'.repeat(2000),
      signal: new AbortController().signal,
    });
    // 截断到 400 字，最多 400 个时间片
    expect(result.timings.length).toBeLessThanOrEqual(400);
  });
});

describe('时间片完整覆盖音频', () => {
  it('最后一句的 endMs 必须等于 durationMs', () => {
    for (const text of ['一句。两句。三句。', '无标点的一句话', 'a。b！c？d；e…']) {
      for (const duration of [700, 1234, 5000]) {
        const timings = splitSentenceTimings(text, duration);
        const last = timings.at(-1);
        expect(last?.endMs).toBe(duration);
        // 时间片首尾相接，没有空洞
        for (let i = 1; i < timings.length; i += 1) {
          expect(timings[i]?.startMs).toBe(timings[i - 1]?.endMs);
        }
      }
    }
  });
});
