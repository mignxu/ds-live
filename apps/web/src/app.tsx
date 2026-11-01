import { useEffect, useState } from 'react';
import { StagePage } from './pages/stage/StagePage.js';
import { StudioPage } from './pages/studio/StudioPage.js';
import { SouvenirsPage } from './pages/souvenirs/SouvenirsPage.js';

/**
 * 三个页面严格区分：
 * - /stage     给 OBS，观众看到的画面
 * - /studio    主播内部操作台，默认不播放音频
 * - /souvenirs 访客浏览纪念品
 *
 * 不做前端路由库：首版只有三个固定入口，避免为路由引入额外依赖。
 */
export type Route = 'stage' | 'studio' | 'souvenirs';

export function resolveRoute(pathname: string): Route {
  if (pathname.startsWith('/studio')) return 'studio';
  if (pathname.startsWith('/souvenirs')) return 'souvenirs';
  return 'stage';
}

export function App() {
  const [route, setRoute] = useState<Route>(() => resolveRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(resolveRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  switch (route) {
    case 'studio':
      return <StudioPage />;
    case 'souvenirs':
      return <SouvenirsPage />;
    default:
      return <StagePage />;
  }
}
