-- 0002_programs_and_souvenirs: P3/P4 所需表。
-- 节目状态（Boss 回合、LOL 查询记录）与公开纪念品。

CREATE TABLE IF NOT EXISTS program_runs (
  id TEXT PRIMARY KEY,
  program TEXT NOT NULL,
  room_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'settling', 'resolved', 'cancelled')),
  round INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  result_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_program_runs_room ON program_runs(room_id, started_at DESC);

-- 游戏动作：每观众每回合一条（唯一约束在服务端保证不重复结算）
CREATE TABLE IF NOT EXISTS game_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL REFERENCES program_runs(id),
  viewer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (round_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS souvenirs (
  public_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signature', 'lol-report', 'game-report')),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  image_path TEXT,
  data_json TEXT,
  is_mock INTEGER NOT NULL DEFAULT 0,
  program TEXT NOT NULL,
  room_id TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_souvenirs_created ON souvenirs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_souvenirs_room ON souvenirs(room_id, created_at DESC);
