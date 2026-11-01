import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 仓库根定位：从 cwd 向上找 pnpm-workspace.yaml。
 * 这样 `pnpm --filter @dafeiyu/server dev`（cwd 在 apps/server）
 * 和从仓库根启动都能找到 migrations、characters、web/dist。
 */
export function findRepoRoot(start = process.cwd()): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 运行数据与作品目录：相对路径按仓库根解析，避免落在 apps/server 下。 */
export function resolveDataPath(path: string, fallbackRoot = findRepoRoot() ?? process.cwd()): string {
  return resolve(fallbackRoot, path);
}

export function defaultWebDistDir(): string {
  const root = findRepoRoot();
  return root ? resolve(root, 'apps/web/dist') : resolve(here, '../../../web/dist');
}
