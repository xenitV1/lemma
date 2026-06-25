export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id TEXT UNIQUE,
  title TEXT NOT NULL,
  fragment TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK(type IN ('fact', 'pattern', 'lesson', 'warning', 'context')),
  project TEXT,
  source TEXT DEFAULT 'ai' NOT NULL,
  confidence REAL DEFAULT 0.5 NOT NULL,
  context_tags TEXT,
  access_count INTEGER DEFAULT 0 NOT NULL,
  last_accessed_at TEXT,
  negative_hits INTEGER DEFAULT 0 NOT NULL,
  positive_feedback INTEGER DEFAULT 0 NOT NULL,
  negative_feedback INTEGER DEFAULT 0 NOT NULL,
  quality_score REAL,
  refinement_count INTEGER DEFAULT 0 NOT NULL,
  parent_id INTEGER REFERENCES memories(id),
  session_id TEXT,
  task_type TEXT,
  distill_candidate INTEGER DEFAULT 0,
  related_guides TEXT,
  associated_with TEXT,
  last_refined TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL,
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project, type);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_legacy_id ON memories(legacy_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  fragment,
  description,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, title, fragment, description)
  VALUES (new.id, new.title, new.fragment, new.description);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, fragment, description)
  VALUES ('delete', old.id, old.title, old.fragment, old.description);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, fragment, description)
  VALUES ('delete', old.id, old.title, old.fragment, old.description);
  INSERT INTO memory_fts(rowid, title, fragment, description)
  VALUES (new.id, new.title, new.fragment, new.description);
END;

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('supports', 'contradicts', 'supersedes', 'superseded_by', 'related_to')),
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);

CREATE TRIGGER IF NOT EXISTS relations_reverse_ai AFTER INSERT ON relations BEGIN
  INSERT OR IGNORE INTO relations(source_id, target_id, type, note, created_at)
  SELECT
    new.target_id,
    new.source_id,
    CASE new.type
      WHEN 'supports' THEN 'supports'
      WHEN 'contradicts' THEN 'contradicts'
      WHEN 'supersedes' THEN 'superseded_by'
      WHEN 'superseded_by' THEN 'supersedes'
      WHEN 'related_to' THEN 'related_to'
    END,
    'Auto-reverse of: ' || COALESCE(new.note, ''),
    datetime('now')
  WHERE new.source_id != new.target_id
  AND new.type != 'superseded_by';
END;

CREATE TABLE IF NOT EXISTS guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  mission TEXT,
  protocol TEXT,
  anti_patterns TEXT,
  pitfalls TEXT,
  deprecated INTEGER DEFAULT 0 NOT NULL,
  superseded_by TEXT,
  usage_count INTEGER DEFAULT 0 NOT NULL,
  success_count INTEGER DEFAULT 0 NOT NULL,
  failure_count INTEGER DEFAULT 0 NOT NULL,
  last_used_at TEXT,
  depends_on TEXT,
  enables TEXT,
  source_memories TEXT,
  validated_by TEXT,
  last_refined TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guides_category ON guides(category);
CREATE INDEX IF NOT EXISTS idx_guides_deprecated ON guides(deprecated);

CREATE VIRTUAL TABLE IF NOT EXISTS guides_fts USING fts5(
  guide,
  description,
  content='guides',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS guides_ai AFTER INSERT ON guides BEGIN
  INSERT INTO guides_fts(rowid, guide, description)
  VALUES (new.id, new.guide, new.description);
END;

CREATE TRIGGER IF NOT EXISTS guides_ad AFTER DELETE ON guides BEGIN
  INSERT INTO guides_fts(guides_fts, rowid, guide, description)
  VALUES ('delete', old.id, old.guide, old.description);
END;

CREATE TRIGGER IF NOT EXISTS guides_au AFTER UPDATE ON guides BEGIN
  INSERT INTO guides_fts(guides_fts, rowid, guide, description)
  VALUES ('delete', old.id, old.guide, old.description);
  INSERT INTO guides_fts(rowid, guide, description)
  VALUES (new.id, new.guide, new.description);
END;

CREATE TABLE IF NOT EXISTS guide_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  UNIQUE(guide_id, context)
);

CREATE INDEX IF NOT EXISTS idx_guide_contexts_guide ON guide_contexts(guide_id);

CREATE TABLE IF NOT EXISTS guide_learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide_id INTEGER NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  learning TEXT NOT NULL,
  UNIQUE(guide_id, learning)
);

CREATE INDEX IF NOT EXISTS idx_guide_learnings_guide ON guide_learnings(guide_id);

CREATE TABLE IF NOT EXISTS guide_memory_links (
  guide_id INTEGER NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK(link_type IN ('source', 'validated_by', 'related')),
  PRIMARY KEY (guide_id, memory_id, link_type)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_type TEXT,
  technologies TEXT,
  initial_approach TEXT,
  final_approach TEXT,
  approach_changed INTEGER DEFAULT 0,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('success', 'partial', 'failure', 'abandoned')),
  refinement_attempts INTEGER DEFAULT 0,
  self_critique_count INTEGER DEFAULT 0,
  lessons TEXT,
  tool_calls INTEGER DEFAULT 0 NOT NULL,
  memory_count INTEGER DEFAULT 0 NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned')),
  project TEXT,
  started_at TEXT DEFAULT (datetime('now')) NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_outcome ON sessions(outcome);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS session_guide_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  guide_id INTEGER NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, guide_id)
);

CREATE TABLE IF NOT EXISTS session_memory_links (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL CHECK(interaction_type IN ('read', 'created', 'updated')),
  PRIMARY KEY (session_id, memory_id, interaction_type)
);

CREATE TABLE IF NOT EXISTS feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  useful INTEGER NOT NULL CHECK(useful IN (0, 1)),
  context TEXT,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_memory ON feedback_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_log(created_at);
`;

export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS session_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  approach TEXT NOT NULL,
  rationale TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('rejected','partial','promising')),
  critique TEXT,
  related_memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  confidence REAL DEFAULT 0.5 NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER DEFAULT 0 NOT NULL,
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  UNIQUE(session_id, seq),
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_attempts_session ON session_attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON session_attempts(outcome);

CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  suggestion TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','dismissed')),
  created_at TEXT DEFAULT (datetime('now')) NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestions_status ON improvement_suggestions(status);
`;

export const SCHEMA_V3 = `
-- Normalize stored project keys so per-project isolation actually works.
-- Fixes historical data written before write-side normalization: mixed-case
-- duplicates ("Ailyro" vs "ailyro"), full paths stored as project
-- ("/home/x/Projeler/scroll/mobil"), and the literal string "global" used to
-- mean global scope. Applied once, gated by schema_version. Idempotent: a
-- second run is a no-op (already-lowercased, no slash, no "global").

UPDATE memories SET project = replace(project, '\\', '/') WHERE project LIKE '%\\%';
UPDATE memories SET project = replace(project, rtrim(project, replace(project, '/', '')), '') WHERE project LIKE '%/%';
UPDATE memories SET project = lower(project) WHERE project IS NOT NULL;
UPDATE memories SET project = NULL WHERE project = 'global';

UPDATE sessions SET project = replace(project, '\\', '/') WHERE project LIKE '%\\%';
UPDATE sessions SET project = replace(project, rtrim(project, replace(project, '/', '')), '') WHERE project LIKE '%/%';
UPDATE sessions SET project = lower(project) WHERE project IS NOT NULL;
UPDATE sessions SET project = NULL WHERE project = 'global';
`;

export const MIGRATIONS: [number, string][] = [[1, SCHEMA_V1], [2, SCHEMA_V2], [3, SCHEMA_V3]];
