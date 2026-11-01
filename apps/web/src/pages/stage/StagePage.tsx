import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BossState, SpeechPlan, StageSnapshot } from '@dafeiyu/contracts';
import { createAudioOutlet, estimateDurationMs, type PlaybackHandle } from '../../audio/outlet.js';
import { createCharacterRenderer, type CharacterRenderer } from '../../renderer/character.js';
import { createStageConnection, type ConnectionState } from '../../connection/stage-connection.js';
import { readToken, stripTokenFromUrl } from '../../connection/token.js';

/**
 * 舞台页：给 OBS 浏览器源使用。
 * - 只读订阅，不发控制指令；
 * - 需要一次显式点击“开始”激活音频（浏览器自动播放策略）；
 * - 单一音频出口；有音频时由真实播放时钟驱动字幕与口型，无音频时用估算时钟；
 * - 回执带 rendererToken，后端拒绝旧主。
 */
export function StagePage() {
  const token = useMemo(() => readToken('stage'), []);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const [snapshot, setSnapshot] = useState<StageSnapshot | null>(null);
  const [current, setCurrent] = useState<SpeechPlan | null>(null);
  const [activated, setActivated] = useState(false);
  const [captionProgress, setCaptionProgress] = useState(0);
  const [activeTimingIndex, setActiveTimingIndex] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CharacterRenderer | null>(null);
  const rendererTokenRef = useRef<string>('');
  const connectionRef = useRef<ReturnType<typeof createStageConnection> | null>(null);
  const outletRef = useRef(createAudioOutlet());
  const playbackRef = useRef<PlaybackHandle | null>(null);

  /**
   * 服务端已经结束/取消的 speechId 集合：这些本地停止不再回执。
   * 必须按 speechId 记录，不能用单个布尔：服务端可能在同一帧内
   * “取消旧句 + 推送新句”，旧句的 done 回调晚于新句启动，
   * 全局标志会被新句重置，导致旧 speechId 回执被拒、进而误停新句。
   */
  const suppressedSpeechIdsRef = useRef(new Set<string>());
  /** 当前本地正在播放的 speechId，用来判断“服务端取消的是不是这一句”。 */
  const playingSpeechIdRef = useRef<string | null>(null);
  /** 是否已点击“开始”。用 ref 而非 state，避免激活时重建 WS 连接、丢掉租约。 */
  const activatedRef = useRef(false);

  useEffect(() => {
    stripTokenFromUrl();
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = createCharacterRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.start();
    return () => {
      renderer.stop();
      rendererRef.current = null;
    };
  }, []);

  const playSpeech = useCallback((speech: SpeechPlan) => {
    playbackRef.current?.stop();
    setCurrent(speech);
    setCaptionProgress(0);
    setActiveTimingIndex(-1);
    setAudioFailed(false);

    const handle = outletRef.current.play({
      speechId: speech.speechId,
      text: speech.text,
      audioUrl: speech.audioUrl,
      audioDurationMs: speech.audioDurationMs,
    });
    playbackRef.current = handle;
    playingSpeechIdRef.current = speech.speechId;

    const rendererToken = rendererTokenRef.current;
    // 重连时 speech.ready 可能先于 snapshot 到达：此时还没有租约，
    // 发回执只会被拒（stale_renderer_lease），进而误停这一句。
    if (rendererToken.length > 0) {
      connectionRef.current?.sendReceipt({
        speechId: speech.speechId,
        rendererToken,
        state: 'started',
        positionMs: 0,
      });
    }

    const total = speech.audioDurationMs ?? estimateDurationMs(speech.text);
    const progressTimer = setInterval(() => {
      const positionMs = handle.positionMs;
      setCaptionProgress(Math.min(1, positionMs / total));
      // 句级时间片驱动字幕高亮；没有时间片时用整体进度。
      if (speech.timings.length > 0) {
        const index = speech.timings.findIndex(
          (timing) => positionMs >= timing.startMs && positionMs < timing.endMs,
        );
        setActiveTimingIndex(index >= 0 ? index : speech.timings.length - 1);
      }
      rendererRef.current?.setMouthOpen(0.15 + Math.abs(Math.sin(positionMs / 90)) * 0.75);
      rendererRef.current?.setEnergy(1);
    }, 80);

    void handle.done.then((reason) => {
      clearInterval(progressTimer);
      if (playingSpeechIdRef.current === speech.speechId) {
        playingSpeechIdRef.current = null;
      }
      rendererRef.current?.setMouthOpen(0);
      rendererRef.current?.setEnergy(0);
      setCaptionProgress(1);

      if (reason === 'failed' && speech.audioUrl !== null) {
        // 音频失败：退回纯字幕，并明确提示，不假装在播。
        setAudioFailed(true);
      }

      if (suppressedSpeechIdsRef.current.has(speech.speechId)) {
        suppressedSpeechIdsRef.current.delete(speech.speechId);
        return;
      }
      if (rendererToken.length === 0) {
        // 没有租约就不回执；服务端会因 unknown_speech/stale_lease 拒绝。
        return;
      }
      connectionRef.current?.sendReceipt({
        speechId: speech.speechId,
        rendererToken,
        state: reason === 'ended' ? 'ended' : reason === 'failed' ? 'failed' : 'cancelled',
        positionMs: handle.positionMs,
      });
    });
  }, []);

  /** 快照里的 activeSpeech 是连接时刻的状态，事件推进后必须同步清掉。 */
  const clearSnapshotActiveSpeech = useCallback(() => {
    setSnapshot((previous) => (previous ? { ...previous, activeSpeech: null } : previous));
  }, []);

  /** 服务端主动结束当前语音：停止本地播放但不回执，避免重复结束。 */
  const stopFromServer = useCallback((speechId?: string) => {
    // 记下具体是哪一句被服务端结束，避免误伤随后启动的新句。
    if (speechId) suppressedSpeechIdsRef.current.add(speechId);
    // 服务端取消的是旧句、本地已经在播新句时，不要停新句。
    if (speechId && playingSpeechIdRef.current && playingSpeechIdRef.current !== speechId) {
      return;
    }
    if (!playbackRef.current) return;
    playbackRef.current.stop();
    playbackRef.current = null;
    playingSpeechIdRef.current = null;
  }, []);

  useEffect(() => {
    if (!token) {
      setNotice('缺少舞台令牌：请在 URL 加 ?token=... 或先设置 localStorage');
      return;
    }

    const conn = createStageConnection({
      token,
      handlers: {
        onState: (state, detail) => {
          setConnection(state);
          if (state === 'unauthorized') setNotice(detail ?? '舞台令牌无效');
        },
        onReceiptRejected: (reason) => {
          // 回执被拒（例如租约已转移）：停止本地播放，不断开连接。
          setNotice(`回执被拒绝：${reason}`);
          stopFromServer();
          rendererRef.current?.setEnergy(0);
        },
        onSnapshot: (next, rendererToken) => {
          rendererTokenRef.current = rendererToken;
          setSnapshot(next);
        },
        onEvent: (event) => {
          switch (event.type) {
            case 'speech.ready':
              // 未激活时只显示字幕，不自动播放音频。
              if (activatedRef.current) playSpeech(event.speech);
              else setCurrent(event.speech);
              break;
            case 'speech.cancelled':
            case 'speech.completed':
              stopFromServer(event.speechId);
              setCurrent(null);
              clearSnapshotActiveSpeech();
              rendererRef.current?.setMouthOpen(0);
              rendererRef.current?.setEnergy(0);
              break;
            case 'program.changed':
              setSnapshot((previous) =>
                previous ? { ...previous, program: event.program, programState: event.state } : previous,
              );
              break;
            case 'idle':
              setCurrent(null);
              clearSnapshotActiveSpeech();
              break;
            case 'snapshot':
              setSnapshot(event.snapshot);
              break;
            default:
              break;
          }
        },
      },
    });
    connectionRef.current = conn;
    conn.connect();

    return () => {
      conn.close();
      stopFromServer();
      connectionRef.current = null;
    };
  }, [token, playSpeech, stopFromServer, clearSnapshotActiveSpeech]);

  const activate = () => {
    activatedRef.current = true;
    setActivated(true);
    void outletRef.current.activate();
    // 播放等待中的语音（如果有）；不重建连接，保留当前 renderer 租约。
    if (current && !outletRef.current.isPlaying()) {
      playSpeech(current);
    }
  };

  const activeSpeech = current ?? snapshot?.activeSpeech ?? null;
  const degraded = snapshot?.degraded;
  const bossState = (snapshot?.programState as BossState | null) ?? null;

  return (
    <div className="stage-root">
      <canvas ref={canvasRef} className="stage-character" aria-hidden="true" />

      {degraded?.active ? (
        <div className="stage-banner stage-banner--warn">
          降级模式：{degraded.reason ?? '模型能力受限'}
        </div>
      ) : null}

      {connection !== 'open' ? (
        <div className="stage-banner">
          {connection === 'connecting' || connection === 'reconnecting'
            ? '连接中…'
            : connection === 'unauthorized'
              ? '舞台令牌无效'
              : '未连接'}
        </div>
      ) : null}

      {!activated ? (
        <button className="stage-activate" onClick={activate} type="button">
          点击开始（激活音频）
        </button>
      ) : null}

      <div className="stage-name">
        {snapshot?.characterName ?? '大肥鱼'}
        {snapshot?.program && snapshot.program !== 'chat' ? (
          <span className="stage-program">{programLabel(snapshot.program)}</span>
        ) : null}
      </div>

      {bossState && bossState.roundId ? (
        <div className="boss-panel">
          <div className="boss-panel__title">
            {bossState.bossName} · 第 {bossState.round} 回合
            <span className={`badge badge--phase badge--${bossState.phase}`}>{bossState.phase}</span>
          </div>
          <Bar label="Boss" value={bossState.bossHp} max={bossState.bossMaxHp} tone="boss" />
          <Bar label="队伍" value={bossState.partyHp} max={bossState.partyMaxHp} tone="party" />
          <div className="boss-panel__meta">
            已出手 {bossState.submitted}
            {bossState.phase === 'open'
              ? ` · 剩 ${Math.ceil(bossState.windowRemainingMs / 1000)}s`
              : ''}
          </div>
        </div>
      ) : null}

      {activeSpeech ? (
        <div className="stage-caption">
          <p className="stage-caption__text">
            {activeSpeech.timings.length > 0 && activeTimingIndex >= 0 ? (
              <span className="stage-caption__active">
                {activeSpeech.timings[activeTimingIndex]?.text}
              </span>
            ) : (
              activeSpeech.text
            )}
          </p>
          {activeSpeech.isMock ? <span className="badge badge--mock">mock 数据</span> : null}
          {activeSpeech.audioIsMock ? <span className="badge badge--mock">mock 语音</span> : null}
          {audioFailed ? <span className="badge badge--warn">音频不可用，仅字幕</span> : null}
          <div className="stage-caption__progress">
            <div style={{ width: `${Math.round(captionProgress * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="stage-caption stage-caption--idle">
          <p>待机中…</p>
        </div>
      )}

      <div className="stage-cards">
        {(activeSpeech?.effects ?? [])
          .filter((effect) => effect.kind !== 'speech')
          .map((effect, index) => (
            <div className={`card card--${effect.kind}`} key={`${effect.kind}-${effect.text}-${index}`}>
              <strong>{effect.text}</strong>
              {effect.isMock ? <span className="badge badge--mock">mock</span> : null}
              {effect.imageUrl ? (
                <img className="card__image" src={effect.imageUrl} alt={effect.text} />
              ) : null}
              {effect.data !== undefined ? (
                <pre className="card__data">{JSON.stringify(effect.data, null, 2)}</pre>
              ) : null}
            </div>
          ))}
      </div>

      {notice ? <div className="stage-notice">{notice}</div> : null}
      <div className="stage-debug">
        rev {snapshot?.revision ?? 0} · {connection}
        {activeSpeech?.audioUrl ? ' · audio' : ' · 字幕'}
      </div>
    </div>
  );
}

function programLabel(program: string): string {
  switch (program) {
    case 'lol':
      return 'LOL 锐评';
    case 'signature':
      return '现场签名';
    case 'boss':
      return '合作打 Boss';
    default:
      return program;
  }
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar">
      <span className="bar__label">{label}</span>
      <div className="bar__track">
        <div className={`bar__fill bar__fill--${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="bar__value">
        {value}/{max}
      </span>
    </div>
  );
}
