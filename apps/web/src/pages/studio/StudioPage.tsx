import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BossState, ProgramInfo, StudioStatus } from '@dafeiyu/contracts';
import { persistToken, readToken } from '../../connection/token.js';

/**
 * 主播控制台。
 * - 默认不播放音频（避免与 OBS 抢音）；
 * - 只发控制指令，不渲染观众画面；
 * - 显示降级状态、队列、预算、TTS、当前节目与最近轮次。
 */
export function StudioPage() {
  const [token, setToken] = useState<string | null>(() => readToken('studio'));
  const [tokenInput, setTokenInput] = useState('');
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [programs, setPrograms] = useState<ProgramInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sayText, setSayText] = useState('');

  const headers = useMemo<Record<string, string>>(
    () => (token ? { authorization: `Bearer ${token}` } : {}),
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/studio/status', { headers });
      if (response.status === 401) {
        setError('控制台令牌无效');
        setStatus(null);
        return;
      }
      if (!response.ok) throw new Error(`状态接口返回 ${response.status}`);
      setStatus((await response.json()) as StudioStatus);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [headers, token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, token]);

  useEffect(() => {
    // 节目列表是静态常量，直接从前端复用同一份定义，避免多一次请求。
    setPrograms([
      { id: 'chat', label: '闲聊', description: '普通弹幕聊天', usesModel: true },
      { id: 'lol', label: 'LOL 锐评', description: '查战绩并点评', usesModel: true },
      { id: 'signature', label: '现场签名', description: '原创笔迹签名', usesModel: false },
      { id: 'boss', label: '合作打 Boss', description: '限时回合结算', usesModel: false },
    ]);
  }, []);

  const control = async (payload: Record<string, unknown>) => {
    if (!token) return;
    setMessage(null);
    try {
      const response = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Record<string, unknown>;
      setMessage(`${String(payload.action)} → ${response.status} ${JSON.stringify(body)}`);
      void refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveToken = () => {
    persistToken('studio', tokenInput.trim());
    setToken(tokenInput.trim());
    setTokenInput('');
  };

  if (!token) {
    return (
      <div className="panel">
        <h1>大肥鱼 · 主播控制台</h1>
        <p className="hint">请输入控制台令牌（仅保存在本机浏览器，不进 Git）。</p>
        <div className="row">
          <input
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="studio token"
          />
          <button type="button" onClick={saveToken}>
            保存
          </button>
        </div>
      </div>
    );
  }

  const bossState = (status?.program.state as BossState | null) ?? null;

  return (
    <div className="panel">
      <header className="panel__header">
        <h1>大肥鱼 · 主播控制台</h1>
        <span className="hint">控制台不播放音频，避免与 OBS 抢音</span>
      </header>

      {error ? <div className="alert alert--error">{error}</div> : null}
      {status?.degraded.active ? (
        <div className="alert alert--warn">
          降级模式：{status.degraded.reason ?? '模型能力受限'}
        </div>
      ) : null}
      {status && !status.speech.available ? (
        <div className="alert alert--warn">
          TTS 不可用：{status.speech.reason ?? '未配置'}（当前为纯字幕模式）
        </div>
      ) : null}

      {status ? (
        <>
          <section className="grid">
            <Stat label="角色" value={`${status.characterName} v${status.characterVersion}`} />
            <Stat label="模型" value={status.modelId} />
            <Stat
              label="TTS"
              value={
                status.speech.available
                  ? `${status.speech.voice ?? '未知音色'}${status.speech.isMock ? '（mock）' : ''}`
                  : '不可用'
              }
            />
            <Stat label="排队" value={String(status.queue.queued)} />
            <Stat label="执行中" value={String(status.queue.planning)} />
            <Stat label="播放中" value={String(status.queue.speaking)} />
            <Stat
              label="预算"
              value={`模型 ${status.budget.maxModelCallsPerTurn} / 工具 ${status.budget.maxToolCallsPerTurn} / ${status.budget.turnDeadlineMs}ms`}
            />
          </section>

          <section>
            <h2>节目</h2>
            <div className="row">
              {programs.map((program) => (
                <button
                  key={program.id}
                  type="button"
                  className={status.program.id === program.id ? 'button--active' : ''}
                  onClick={() => void control({ action: 'switch_program', program: program.id })}
                  title={program.description}
                >
                  {program.label}
                </button>
              ))}
            </div>
            {bossState && bossState.roundId ? (
              <div className="alert">
                {bossState.bossName} · 第 {bossState.round} 回合 · {bossState.phase} · Boss{' '}
                {bossState.bossHp}/{bossState.bossMaxHp} · 队伍 {bossState.partyHp}/
                {bossState.partyMaxHp} · 已出手 {bossState.submitted}
              </div>
            ) : null}
            <div className="row">
              <button type="button" onClick={() => void control({ action: 'boss_open' })}>
                开 Boss 回合
              </button>
              <button type="button" onClick={() => void control({ action: 'boss_settle' })}>
                结算
              </button>
              <button type="button" onClick={() => void control({ action: 'boss_reset' })}>
                重置
              </button>
            </div>
          </section>

          <section>
            <h2>让大肥鱼说一句</h2>
            <div className="row">
              <input
                value={sayText}
                onChange={(event) => setSayText(event.target.value)}
                placeholder="直接播报（不经过模型）"
                maxLength={200}
              />
              <button
                type="button"
                onClick={() => {
                  void control({ action: 'say', text: sayText });
                  setSayText('');
                }}
              >
                播报
              </button>
            </div>
          </section>

          <section className="row">
            <button type="button" onClick={() => void control({ action: 'cancel' })}>
              停止当前回应
            </button>
            <button type="button" onClick={() => void control({ action: 'clear_queue' })}>
              清空队列
            </button>
            <button type="button" onClick={() => void refresh()}>
              刷新
            </button>
          </section>

          {message ? <div className="alert">{message}</div> : null}

          <section>
            <h2>最近轮次</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>模型</th>
                  <th>工具</th>
                  <th>结束原因</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {status.recentTurns.map((turn) => (
                  <tr key={turn.turnId}>
                    <td>{turn.phase}</td>
                    <td>{turn.modelCalls}</td>
                    <td>{turn.toolCalls}</td>
                    <td>{turn.finishReason ?? '-'}</td>
                    <td>{turn.errorCode ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <p className="hint">加载中…</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}
