import { useEffect, useState } from 'react';
import type { Souvenir, SouvenirList } from '@dafeiyu/contracts';

/**
 * 纪念品页：访客浏览已公开的作品（签名照、战报）。
 *
 * 硬约束：
 * - 观众实时互动留在直播间；本页不提供任何游戏控制或计分入口。
 * - 只展示明确公开的作品；不暴露服务器路径、token 或观众私有记忆。
 * - 领取纪念品不影响当场参与、计分或结算。
 */
export function SouvenirsPage() {
  const [list, setList] = useState<SouvenirList | null>(null);
  const [detail, setDetail] = useState<Souvenir | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/souvenirs?limit=24');
        if (!response.ok) throw new Error(`返回 ${response.status}`);
        const body = (await response.json()) as SouvenirList;
        if (!cancelled) setList(body);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openDetail = async (publicId: string) => {
    try {
      const response = await fetch(`/api/souvenirs/${publicId}`);
      if (!response.ok) throw new Error(`返回 ${response.status}`);
      setDetail((await response.json()) as Souvenir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="panel">
      <header className="panel__header">
        <h1>大肥鱼 · 纪念品</h1>
        <span className="hint">直播间的签名照与战报，事后回看</span>
      </header>

      <div className="alert">
        参与游戏、提交指令等实时操作只在抖音直播间进行；本页只用于事后浏览。
        领取纪念品不影响当场参与、计分或结算。
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {list === null ? (
        <p className="hint">加载中…</p>
      ) : list.items.length === 0 ? (
        <div className="alert alert--warn">
          还没有公开的纪念品。等大肥鱼签出第一张，或打完第一场 Boss 就会出现在这里。
        </div>
      ) : (
        <>
          <p className="hint">共 {list.total} 件，显示最近 {list.items.length} 件。</p>
          <div className="souvenir-grid">
            {list.items.map((item) => (
              <article className="souvenir" key={item.publicId}>
                {item.imageUrl ? (
                  <img className="souvenir__image" src={item.imageUrl} alt={item.title} />
                ) : (
                  <div className="souvenir__placeholder">{kindLabel(item.kind)}</div>
                )}
                <div className="souvenir__body">
                  <h2>
                    {item.title}
                    {item.isMock ? <span className="badge badge--mock">mock</span> : null}
                  </h2>
                  <p className="souvenir__text">{item.text}</p>
                  <div className="souvenir__meta">
                    <span>{kindLabel(item.kind)}</span>
                    <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  <button type="button" onClick={() => void openDetail(item.publicId)}>
                    查看详情
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {detail ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__body">
            <h2>{detail.title}</h2>
            {detail.imageUrl ? (
              <img className="modal__image" src={detail.imageUrl} alt={detail.title} />
            ) : null}
            <p>{detail.text}</p>
            {detail.isMock ? (
              <p className="hint">这件作品包含 mock 数据，不代表真实战绩或真实手写。</p>
            ) : null}
            <div className="row">
              {detail.imageUrl ? (
                <a className="link" href={detail.imageUrl} download>
                  下载图片
                </a>
              ) : null}
              <button type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function kindLabel(kind: Souvenir['kind']): string {
  switch (kind) {
    case 'signature':
      return '签名';
    case 'lol-report':
      return '战报';
    case 'game-report':
      return '游戏结算';
    default:
      return kind;
  }
}
