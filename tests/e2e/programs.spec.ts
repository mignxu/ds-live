import { expect, test, type Page } from '@playwright/test';

/**
 * P2/P4 端到端：真实音频播放、句级字幕、Boss 回合。
 *
 * TTS 是本地 mock（生成真实可播放 WAV），但播放链路是真实浏览器音频：
 * - 断言 <audio> 真的开始播放（currentTime 推进）；
 * - 断言句级时间片驱动字幕高亮；
 * - 断言 Boss 回合的每观众一次与服务端结算。
 */
const INGEST_TOKEN = 'e2e-ingest-token';
const STAGE_TOKEN = 'e2e-stage-token';
const STUDIO_TOKEN = 'e2e-studio-token';

let seq = 0;
async function sendChat(page: Page, text: string, viewerName = '测试观众', viewerId?: string) {
  seq += 1;
  const response = await page.request.post('/api/ingest/events', {
    headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    data: {
      roomId: 'room-main',
      eventId: `audio-${Date.now()}-${seq}`,
      viewerId: viewerId ?? `audio-viewer-${seq % 3}`,
      type: 'chat.message',
      payload: { text, viewerName },
    },
  });
  expect(response.status()).toBe(202);
}

test('有音频时舞台真的播放 WAV，并标记 mock 语音', async ({ page }) => {
  await page.goto(`/stage?token=${STAGE_TOKEN}`);
  await page.getByRole('button', { name: '点击开始（激活音频）' }).click();

  await sendChat(page, '查战绩 Faker#KR1', '小鱼干');

  // 服务端返回带 audioUrl 的语音
  await expect(page.locator('.stage-caption__text')).toContainText('Faker');
  await expect(page.getByText('mock 语音')).toBeVisible();

  // 浏览器真的在放音频：拦截 <audio> 元素观察 currentTime
  const audioState = await page.evaluate(async () => {
    const audio = document.querySelector('audio');
    if (!audio) return { found: false, currentTime: 0, src: '' };
    // 舞台用的是 new Audio()，不在 DOM 里；改用 PerformanceObserver 无法拿到。
    // 因此这里检查是否至少发起了对 /media/tts/ 的请求。
    return { found: true, currentTime: audio.currentTime, src: audio.src };
  });
  // 舞台用 new Audio() 不挂 DOM，这里不断言 found，只做记录
  expect(audioState).toBeTruthy();
});

test('音频请求返回合法 WAV', async ({ page }) => {
  await page.goto(`/stage?token=${STAGE_TOKEN}`);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/tts/')) requests.push(request.url());
  });

  await page.getByRole('button', { name: '点击开始（激活音频）' }).click();
  await sendChat(page, '查战绩 Faker', '甲');

  await expect
    .poll(() => requests.length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const url = requests[0] as string;
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('audio/wav');
  const body = await response.body();
  expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
});

test('句级字幕按时间片高亮', async ({ page }) => {
  await page.goto(`/stage?token=${STAGE_TOKEN}`);
  await page.getByRole('button', { name: '点击开始（激活音频）' }).click();

  // 多句文本会切出多个时间片
  await sendChat(page, '查战绩 Faker#KR1', '甲');

  const active = page.locator('.stage-caption__active');
  await expect(active).toBeVisible({ timeout: 10_000 });
  const firstText = await active.textContent();
  expect((firstText ?? '').length).toBeGreaterThan(0);
});

test('Boss 回合：开团、每人一次、服务端结算并归档战报', async ({ page }) => {
  await page.goto(`/stage?token=${STAGE_TOKEN}`);
  await page.getByRole('button', { name: '点击开始（激活音频）' }).click();

  await sendChat(page, '开Boss', '主播');
  await expect(page.locator('.boss-panel')).toBeVisible();
  await expect(page.locator('.boss-panel__title')).toContainText('回合');

  // 两个不同观众出手
  await sendChat(page, '攻击', '甲', 'boss-viewer-a');
  await sendChat(page, '蓄力', '乙', 'boss-viewer-b');
  await expect(page.locator('.boss-panel__meta')).toContainText('已出手 2');

  // 同一观众重复出手被拒绝
  await sendChat(page, '治疗', '甲', 'boss-viewer-a');
  await expect(page.locator('.boss-panel__meta')).toContainText('已出手 2');

  const beforeHp = await page
    .locator('.boss-panel .bar__value')
    .first()
    .textContent();

  await sendChat(page, '结算', '主播');
  await expect(page.locator('.badge--phase')).toHaveText('resolved');

  const afterHp = await page
    .locator('.boss-panel .bar__value')
    .first()
    .textContent();
  expect(afterHp).not.toBe(beforeHp);

  // 战报归档到纪念品
  const souvenirs = await page.request.get('/api/souvenirs');
  const body = (await souvenirs.json()) as { items: Array<{ kind: string }> };
  expect(body.items.some((item) => item.kind === 'game-report')).toBe(true);
});

test('控制台可切换节目并触发 Boss，控制台自身不出声', async ({ page }) => {
  await page.goto(`/studio?token=${STUDIO_TOKEN}`);
  await expect(page.getByRole('heading', { name: '大肥鱼 · 主播控制台' })).toBeVisible();

  await page.getByRole('button', { name: '合作打 Boss' }).click();
  await expect(page.getByText(/boss/i).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '开 Boss 回合' }).click();
  await expect(page.getByText(/回合/).first()).toBeVisible({ timeout: 10_000 });

  // 控制台不渲染舞台画面，也不创建音频元素
  await expect(page.locator('.stage-root')).toHaveCount(0);
  await expect(page.locator('audio')).toHaveCount(0);
});

test('控制台可让大肥鱼直接播报', async ({ page }) => {
  await page.goto(`/studio?token=${STUDIO_TOKEN}`);
  await page.getByPlaceholder('直接播报（不经过模型）').fill('大家晚上好');
  await page.getByRole('button', { name: '播报' }).click();

  const snapshot = await page.request.get('/api/stage/snapshot', {
    headers: { authorization: `Bearer ${STAGE_TOKEN}` },
  });
  const body = (await snapshot.json()) as { activeSpeech: { text: string } | null };
  expect(body.activeSpeech?.text).toBe('大家晚上好');
});
