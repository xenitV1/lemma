# Development Guide

## Setup

```bash
git clone https://github.com/xenitV1/lemma
cd Lemma
npm install
```

## Commands

```bash
npm test            # Run all test files (node --test)
npm run typecheck   # TypeScript type checking
npm run build       # Compile to dist/
lemma -lib          # Library Mode (knowledge base snapshot)
```

## Project Structure

```
src/
├── index.ts              # CLI entry point (-lib flag handling, server launch)
├── types.ts              # Shared TypeScript interfaces
├── logger.ts             # Structured logging (daily rotation, ~/.lemma/logs/)
├── db/
│   ├── index.ts          # Database initialization + JSONL migration
│   ├── database.ts       # SQLite connection, statement cache, WAL mode
│   ├── schema.ts         # Schema definitions + migrations
│   ├── migration.ts      # Migration runner, JSONL → SQLite migration
│   ├── memory-store.ts   # Targeted SQL: addMemory, updateMemory, searchMemories, etc.
│   └── library-store.ts  # Library Mode: snapshot collection, analysis signals, formatting
├── memory/
│   ├── core.ts           # Core memory logic, decay, search, dedup, relations
│   ├── config.ts         # User configuration loader
│   ├── seed.ts           # Built-in seed knowledge fragments
│   ├── privacy.ts        # Secret scanning and redaction (17 regex patterns)
│   └── index.ts          # Barrel exports
├── guides/
│   ├── core.ts           # Guides logic, fuzzy dedup, source_memories, validated_by
│   └── index.ts          # Barrel exports
├── intelligence/
│   ├── conflict.ts       # Conflict detection: negation patterns + topic overlap
│   ├── proactive.ts      # Proactive suggestions: recurring patterns, distill, stale, orphan
│   ├── session-analytics.ts  # Cross-session project analytics, health scoring
│   ├── semantic.ts       # TF-IDF vector search + cosine similarity
│   ├── types.ts          # Shared types (ProactiveSuggestion, ConflictPair, ProjectProgress)
│   └── index.ts          # Barrel exports
├── server/
│   ├── index.ts          # Server setup, memory injection, notifications, lifecycle
│   ├── handlers.ts       # 26 tool handlers + intelligence hooks + response hooks
│   ├── tools.ts          # MCP tool definitions (26 tools)
│   ├── hooks.ts          # Hook system & prompt modifiers
│   ├── system-prompt.ts  # Dynamic system prompt generation
│   ├── agents-md.ts      # Auto-cleans stale Lemma AGENTS.md blocks (legacy); no injection
│   └── traffic-log.ts    # MCP traffic logging
├── sessions/
│   ├── core.ts           # Formal session lifecycle (session_start/end)
│   └── virtual.ts        # Virtual session auto-tracking (idle detection)
tests/                    # node:test + tsx
├── memory/               # 14 test files
├── guides/               # 6 test files
├── sessions/             # 2 test files
├── server/               # 16 test files
├── intelligence/         # 4 test files (conflict, proactive, semantic, session-analytics)
├── db/                   # Database tests
└── _setup.ts             # Global setup (logger disabled)
```

## Architecture

### Database

All data is stored in a single SQLite database (`~/.lemma/lemma.db`) with WAL mode, statement caching, and FTS5 full-text search. Legacy JSONL files are automatically migrated on first run.

Key tables: `memories`, `guides`, `sessions`, `relations`, `guide_learnings`, `guide_memory_links`. Semantic search runs over TF-IDF vectors computed in-process (no vector table).

### Memory Injection

Memories are injected into MCP tool descriptions at `tools/list` time:

1. `buildToolsWithMemory()` — Injects full content + summary index + guides into tool descriptions
2. `buildDynamicInstructions()` — Builds 3-layer context (rules → memories → guides)
3. `getDynamicSystemPrompt()` — Dynamic system prompt with project context

All injection paths use `injectionScore()` ranking: `confidence * 0.7 + recency * 0.3`.

### Prompt-Layer Injection (no project files)

Memory is injected through the MCP prompt layer only — the dynamic system prompt (`buildInstructions` in `prompt-content.ts`) and behavioral nudges appended to tool descriptions. Lemma does **not** write to `AGENTS.md` or any project file (changed in v0.12.0). `agents-md.ts` now only auto-cleans stale `<!-- lemma:start -->` / `<!-- lemma:end -->` blocks left by older versions on startup.

The prompt layer teaches the LLM:
- The two-layer knowledge system (memories + guides)
- The knowledge pipeline (raw → pattern → skill)
- Mandatory rules (read memory first, save immediately, store in English)
- Maintenance workflows (update, merge, forget, relate, feedback)
- Session management

### Intelligence Layer

The `src/intelligence/` module provides autonomous background intelligence:

- **Conflict Detection** (`conflict.ts`): Negation pattern matching + topic overlap scoring. Runs automatically on every `memory_add`. Full scans available via `conflict_scan` tool.
- **Proactive Suggestions** (`proactive.ts`): Detects recurring patterns, distill candidates, stale memories, low-performing guides. Runs automatically after `memory_add` and `guide_practice`. Full analysis via `proactive_analysis` tool.
- **Project Analytics** (`session-analytics.ts`): Cross-session health scoring, knowledge growth rate, skill coverage trends. Via `project_analytics` tool.
- **Semantic Search** (`semantic.ts`): TF-IDF vector space model with cosine similarity. Via `semantic_search` tool.

### Memory Lifecycle

- **Confidence decay**: Only unused fragments decay (-0.002/session). Accessed fragments are shielded.
- **Boost on access**: +0.015 confidence, context tagging, association tracking
- **Negative feedback**: -0.02 confidence
- **Dedup**: FTS5 BM25-based with keyword overlap fallback
- **Auto-linking**: Co-read memories and topic-overlapping fragments automatically connected

### Virtual Sessions

Automatic session correlation without explicit `session_start`/`session_end`:

- Auto-starts on first tool call
- Idle detection: 10s mark → finalize on next call if >30s idle
- 30min absolute timeout (configurable)
- Tracks tools, technologies, guides, memories
- Sessions persisted to `~/.lemma/sessions/vs_*.json`

### Response Hooks

Tool responses include contextual `SUGGESTED ACTIONS`:
- Topic overlap → `memory_relate`
- Type `pattern`/`lesson` → `guide_distill`
- Conflict detected → `memory_relate` with `contradicts`
- Proactive suggestions → distill, merge, refine actions
- Session end → full review with relate + distill + practice suggestions

### CLI: Library Mode (`-lib`)

Running `lemma -lib` initializes the database and outputs a full Library Mode snapshot to stderr, then exits without starting the MCP server. This provides:
- Complete fragment inventory with confidence, age, access counts
- Guide summary with success rates
- Relation graph analysis (orphans, hubs, isolated)
- Analysis signals (stale, similarity candidates, distill candidates, low-performing guides)
- Prioritized suggested actions

Useful for periodic maintenance — the LLM reads the snapshot and takes action via normal tools.

## Data Storage

All data in `~/.lemma/`:

| File | Format | Purpose |
|------|--------|---------|
| `lemma.db` | SQLite | Primary data store (memories, guides, sessions, relations) |
| `config.json` | JSON | User configuration |
| `sessions/vs_*.json` | JSON | Virtual session details |
| `logs/lemma-YYYY-MM-DD.log` | Text | Structured logs (7-day rotation) |
| `*.migrated.bak` | JSONL | Backup of migrated legacy data |

## Testing

Tests use Node.js built-in test runner (`node:test`) with `tsx` for TypeScript:

```bash
npm test                                    # All test files
npm run test:memory                         # Memory tests only
npm run test:guides                         # Guide tests only
npm run test:sessions                       # Session tests only
npm run test:server                         # Server tests only
```

`tests/_setup.ts` disables logger globally to prevent disk I/O during tests. Each test file uses temp directories via `os.tmpdir()` for isolation.

## Adding New Features

New tools can be added as needed. The current tool count is 26 (24 core memory/guide/session tools + `session_attempt` and `suggestion_respond` for the reasoning-continuity self-critique loop).

## Dependencies

| Package | Type | Purpose |
|---------|------|---------|
| `@modelcontextprotocol/sdk` | required | MCP protocol |
| `better-sqlite3` | required | SQLite database |
