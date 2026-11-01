-- 0003_memories_and_retention: 长期记忆 + 保留期限所需的索引。

-- 长期记忆：只保存有用偏好与明确同意的信息，可查看、纠正、清除。
-- 不用模型“记住”替代业务数据（分数、战绩仍在 program_runs / game_actions）。
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  -- 记忆作用域：会话级（仅本场）或观众级（同一 viewerId 跨会话）。
  scope TEXT NOT NULL CHECK (scope IN ('session', 'viewer')),
  session_id TEXT,
  viewer_id TEXT,
  -- 结构化事实：key 为短标识，value 为 JSON。
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  -- 来源与置信度，便于观众质疑时追溯。
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  -- 过期时间；NULL 表示不过期（仍需遵守保留策略）。
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(room_id, scope, viewer_id, session_id);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);

-- 保留期限清理需要的索引（processed_events 已有 processed_at 索引）。
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_souvenirs_public ON souvenirs(is_public, created_at DESC);
