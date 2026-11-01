-- 0001_init: P0/P1 所需最小表集合。
-- 尚未开发的节目表（game_rounds、souvenirs 等）等到真正实现时再加迁移。

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  summary TEXT,
  summary_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  viewer_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  turn_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  room_id TEXT NOT NULL,
  trigger_event_id TEXT,
  phase TEXT NOT NULL,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  error_code TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  trace_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  is_mock INTEGER NOT NULL,
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);

-- 去重表：按保留期限清理，避免无限增长。
CREATE TABLE IF NOT EXISTS processed_events (
  dedupe_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  room_id TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_events_time ON processed_events(processed_at);
