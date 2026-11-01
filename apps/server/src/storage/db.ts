import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findRepoRoot } from '../paths.js';

export type Db = Database.Database;

/** 迁移目录默认从仓库根读取；测试可显式覆盖。 */
export function defaultMigrationsDir(): string {
  const root = findRepoRoot();
  const candidates = [
    root ? resolve(root, 'migrations') : resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'migrations'),
  ];
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  throw new Error(`未找到 migrations 目录，已尝试：${candidates.join(', ')}`);
}

export type OpenDbOptions = {
  /** ':memory:' 用于测试。 */
  file: string;
  migrationsDir?: string;
  /** 测试可关闭 WAL，避免临时目录残留文件。 */
  wal?: boolean;
};

/**
 * 打开数据库并应用未执行的迁移。
 * WAL 只在真实文件库启用，单进程串行写入。
 */
export function openDb(options: OpenDbOptions): Db {
  const isMemory = options.file === ':memory:';
  if (!isMemory) {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const db = new Database(options.file);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory && options.wal !== false) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }

  applyMigrations(db, options.migrationsDir ?? defaultMigrationsDir());
  return db;
}

export function applyMigrations(db: Db, migrationsDir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => (row as { id: string }).id),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });
    run();
    newlyApplied.push(file);
  }
  return newlyApplied;
}
