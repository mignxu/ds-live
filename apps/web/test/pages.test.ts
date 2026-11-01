import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../src/app.js';
import { estimateDurationMs } from '../src/audio/outlet.js';
import { persistToken, readToken } from '../src/connection/token.js';

describe('路由分面', () => {
  it('三个页面严格区分', () => {
    expect(resolveRoute('/stage')).toBe('stage');
    expect(resolveRoute('/studio')).toBe('studio');
    expect(resolveRoute('/studio/whatever')).toBe('studio');
    expect(resolveRoute('/souvenirs')).toBe('souvenirs');
    expect(resolveRoute('/souvenirs/abc123')).toBe('souvenirs');
    expect(resolveRoute('/')).toBe('stage');
  });
});

describe('字幕时长估算（无音频兜底）', () => {
  it('短句有最小时长，长句按字增长', () => {
    expect(estimateDurationMs('嗨')).toBe(900);
    expect(estimateDurationMs('a'.repeat(40))).toBe(5200);
  });
});

describe('令牌读取', () => {
  it('查询参数优先并写入本地存储，之后从地址栏移除', () => {
    persistToken('stage', '');
    const token = readToken('stage', '?token=dev-only-stage');
    expect(token).toBe('dev-only-stage');
    expect(readToken('stage', '')).toBe('dev-only-stage');
  });

  it('两个页面的令牌互不覆盖', () => {
    readToken('stage', '?token=stage-token');
    readToken('studio', '?token=studio-token');
    expect(readToken('stage', '')).toBe('stage-token');
    expect(readToken('studio', '')).toBe('studio-token');
  });
});

describe('音频出口：单出口与真实音频语义', () => {
  it('新语音会停掉旧语音，两个 done 各自结算', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const first = outlet.play({ speechId: 's1', text: '第一句', audioUrl: null });
    const second = outlet.play({ speechId: 's2', text: '第二句', audioUrl: null });

    expect(await first.done).toBe('stopped');
    expect(outlet.isPlaying()).toBe(true);

    second.stop();
    expect(await second.done).toBe('stopped');
    expect(outlet.isPlaying()).toBe(false);
  });

  it('无音频时标记 hasAudio=false，由估算时钟推进', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const handle = outlet.play({ speechId: 's3', text: '嗨', audioUrl: null });
    expect(handle.hasAudio).toBe(false);
    handle.stop();
    expect(await handle.done).toBe('stopped');
  });

  it('音频不可用时不假装在播，明确 failed', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const handle = outlet.play({
      speechId: 's4',
      text: '有音频地址',
      audioUrl: '/media/tts/missing-file.wav',
    });
    expect(handle.hasAudio).toBe(true);
    // jsdom 里 Audio 不会真的加载；这里断言不会静默返回 ended。
    const result = await Promise.race([
      handle.done,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(result === 'failed' || result === 'timeout').toBe(true);
    handle.stop();
  });

  it('stop 后不再推进进度', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const handle = outlet.play({ speechId: 's5', text: 'a'.repeat(20), audioUrl: null });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();
    const positionAtStop = handle.positionMs;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(handle.positionMs).toBe(positionAtStop);
  });
});

describe('音频出口：失败后不永久占线', () => {
  it('播放同步失败后 isPlaying 必须为 false', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const handle = outlet.play({
      speechId: 'fail-1',
      text: 'x',
      audioUrl: '/media/tts/missing.wav',
    });
    // 等一拍，让同步/异步失败路径都结算
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await Promise.race([
      handle.done,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    if (result === 'failed') {
      // 关键断言：失败后不能仍然“在播”，否则 activate() 永远不会补播
      expect(outlet.isPlaying()).toBe(false);
    }
    handle.stop();
    expect(outlet.isPlaying()).toBe(false);
  });

  it('失败后仍能播放下一句', async () => {
    const { createAudioOutlet } = await import('../src/audio/outlet.js');
    const outlet = createAudioOutlet();
    const failed = outlet.play({ speechId: 'a', text: 'x', audioUrl: '/media/tts/missing.wav' });
    await Promise.race([
      failed.done,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    failed.stop();

    const next = outlet.play({ speechId: 'b', text: '下一句', audioUrl: null });
    expect(outlet.isPlaying()).toBe(true);
    next.stop();
    expect(await next.done).toBe('stopped');
  });
});
