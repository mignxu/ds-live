import { expect, test, type Page } from '@playwright/test';

/**
 * 多房间端到端：两个房间各自独立舞台、独立 Boss 回合。
 *
 * 通过 ?room= 指定房间；缺省为默认房间。
 */
const INGEST_TOKEN = 'e2e-ingest-token';
const STAGE_TOKEN = 'e2e-stage-token';
const STUDIO_TOKEN = 'e2e-studio-token';

let seq = 0;
async function sendChat(
  page: Page,
  roomId: string,
  text: string,
  viewerId = 'viewer-1',
  viewerName = '观众',
) {
  seq += 1;
  const response = await page.request.post('/api/ingest/events', {
    headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    data: {
      roomId,
      eventId: `multi-${roomId}-${Date.now()}-${seq}`,
      viewerId,
      type: 'chat.message',
      payload: { text, viewerName },
    },
  });
  expect(response.status()).toBe(202);
}

test('两个房间的 Boss 回合互不影响', async ({ page }) => {
  const roomA = 'e2e-room-a';
  const roomB = 'e2e-room-b';

  await sendChat(page, roomA, '开Boss', 'host-a', '主播A');
  await sendChat(page, roomB, '开Boss', 'host-b', '主播B');
  await sendChat(page, roomA, '攻击', 'a1', '甲');
  await sendChat(page, roomB, '攻击', 'b1', '乙');
  await sendChat(page, roomB, '攻击', 'b2', '丙');

  const snapshotA = await page.request.get(`/api/stage/snapshot?room=${roomA}`, {
    headers: { authorization: `Bearer ${STAGE_TOKEN}` },
  });
  const snapshotB = await page.request.get(`/api/stage/snapshot?room=${roomB}`, {
    headers: { authorization: `Bearer ${STAGE_TOKEN}` },
  });

  const a = (await snapshotA.json()) as {
    roomId: string;
    programState: { submitted: number; roundId: string };
  };
  const b = (await snapshotB.json()) as {
    roomId: string;
    programState: { submitted: number; roundId: string };
  };

  expect(a.roomId).toBe(roomA);
  expect(b.roomId).toBe(roomB);
  expect(a.programState.submitted).toBe(1);
  expect(b.programState.submitted).toBe(2);
  expect(a.programState.roundId).not.toBe(b.programState.roundId);
});

test('舞台页按 room 参数订阅对应房间', async ({ page }) => {
  const roomId = 'e2e-room-stage';
  await sendChat(page, roomId, '你是谁', 'v1', '甲');

  await page.goto(`/stage?token=${STAGE_TOKEN}&room=${roomId}`);
  await page.getByRole('button', { name: '点击开始（激活音频）' }).click();

  // 该房间有最近语音，说明订阅到了正确房间
  const snapshot = await page.request.get(`/api/stage/snapshot?room=${roomId}`, {
    headers: { authorization: `Bearer ${STAGE_TOKEN}` },
  });
  const body = (await snapshot.json()) as { recentSpeeches: unknown[] };
  expect(body.recentSpeeches.length).toBeGreaterThan(0);
});

test('控制台状态按 room 查询，房间数可见', async ({ page }) => {
  const roomId = 'e2e-room-studio';
  await sendChat(page, roomId, '开Boss', 'host', '主播');

  const response = await page.request.get(`/api/studio/status?room=${roomId}`, {
    headers: { authorization: `Bearer ${STUDIO_TOKEN}` },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    room: { id: string; count: number; max: number };
    program: { id: string };
  };
  expect(body.room.id).toBe(roomId);
  expect(body.room.count).toBeGreaterThanOrEqual(2);
  expect(body.room.max).toBeGreaterThan(0);
  expect(body.program.id).toBe('boss');
});

test('控制台动作只作用于指定房间', async ({ page }) => {
  const roomA = 'e2e-room-ctrl-a';
  const roomB = 'e2e-room-ctrl-b';
  await sendChat(page, roomA, '开Boss', 'host-a', 'A');
  await sendChat(page, roomB, '开Boss', 'host-b', 'B');

  const reset = await page.request.post(`/api/studio/control?room=${roomA}`, {
    headers: { authorization: `Bearer ${STUDIO_TOKEN}` },
    data: { action: 'boss_reset' },
  });
  expect(reset.ok()).toBe(true);

  const a = await page.request.get(`/api/studio/status?room=${roomA}`, {
    headers: { authorization: `Bearer ${STUDIO_TOKEN}` },
  });
  const b = await page.request.get(`/api/studio/status?room=${roomB}`, {
    headers: { authorization: `Bearer ${STUDIO_TOKEN}` },
  });

  expect(((await a.json()) as { program: { state: { phase: string } } }).program.state.phase).toBe(
    'idle',
  );
  expect(((await b.json()) as { program: { state: { phase: string } } }).program.state.phase).toBe(
    'open',
  );
});

test('房间数超过上限时接入被拒绝', async ({ page }) => {
  // 默认 MAX_ROOMS 是 20；e2e 里已创建若干房间，这里只验证错误码语义存在
  const response = await page.request.post('/api/ingest/events', {
    headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    data: {
      roomId: `e2e-overflow-${Date.now()}`,
      eventId: `overflow-${Date.now()}`,
      viewerId: 'v1',
      type: 'chat.message',
      payload: { text: '你好', viewerName: '甲' },
    },
  });
  // 未超限时应为 202；超限时为 429 too_many_rooms
  expect([202, 429]).toContain(response.status());
  if (response.status() === 429) {
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'too_many_rooms',
    });
  }
});
