<p align="center">
  <img src="assets/logo.png" width="200" alt="Lemma Logo">
</p>

# Lemma — Persistent Memory for LLMs via MCP

[![npm version](https://img.shields.io/npm/v/lemma-mcp.svg)](https://www.npmjs.com/package/lemma-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [Türkçe](docs/README.tr.md)

Lemma is an MCP server that gives LLMs persistent, cross-session memory. Memories are injected automatically into every session — no explicit tool call needed. Knowledge evolves through use: frequently accessed memories strengthen, unused ones fade, and patterns are promoted into reusable skills. An autonomous intelligence layer runs in the background — detecting conflicts, suggesting actions, and auto-linking related knowledge. **Reasoning continuity** captures tried/rejected approaches and recalls dead ends at the start of each new session, so the same failed path is never explored twice.

<p align="center">
  <img src="assets/visualizer-demo.gif" width="700" alt="Lemma Memory Visualizer Demo">
</p>

<p align="center"><em>Memory Visualizer — <code>lemma -vis</code></em></p>

## Quick Start

Add Lemma to your MCP client configuration:

**Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
**Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Claude Code (Linux):** `~/.claude.json` or `~/.claude/settings.json`
**opencode:** `~/.config/opencode/opencode.json` (Linux/macOS) or `%APPDATA%\opencode\opencode.json` (Windows)

```json
{
  "mcpServers": {
    "lemma": {
      "command": "npx",
      "args": ["-y", "lemma-mcp@latest"]
    }
  }
}
```

> Using `@latest` ensures npx always fetches the newest version.

**Requirements:** Node.js 20.0.0 or higher

### CLI Usage

```bash
lemma -lib    # Library Mode: snapshot of your entire knowledge base
lemma -vis    # Visualizer: interactive memory graph in browser
lemma -vis -p 8080  # Visualizer on custom port (default: 3456)
```

**Library Mode** (`-lib`) outputs a full analysis of all memories, guides, relations, stale fragments, distill candidates, and suggested actions. Useful for periodic maintenance and review.

**Visualizer** (`-vis`) starts a localhost-only HTTP server (token-authenticated) and opens an interactive D3.js force-directed graph of your memory fragments in the browser. Nodes represent memories (sized by confidence + access count, colored by type). Links show relations and associations. All changes (edit, delete, link, unlink) write directly to the SQLite database in real-time. Cross-platform: works on macOS, Linux, and Windows.

## How It Works

Memories are injected into tool descriptions via `tools/list`. The LLM starts every session already knowing its most important memories — works on every MCP client.

**3-layer injection:**
- Full content for top memories (token-budgeted)
- Summary index for remaining memories
- Active guides with learnings

**Memory types:** `fact`, `pattern`, `lesson`, `warning`, `context`

**Knowledge pipeline:** Memory (what you know, `memory_add`) → Pattern (`type: "pattern"`) → Guide (how you work, `guide_distill` → `guide_practice`)

**No project-file modification:** Lemma injects memory through the MCP prompt layer — the system prompt and tool descriptions — and never writes to `AGENTS.md` or any project file. This works identically on every MCP client. (Legacy `<!-- lemma:* -->` blocks left by older versions are auto-cleaned on startup.)

## Autonomous Intelligence

Lemma runs intelligence in the background — no manual triggering needed:

- **Conflict Detection:** Automatically checks new memories against existing knowledge for contradictions. Reports conflicts with suggestions to resolve.
- **Proactive Suggestions:** After adding memories or practicing guides, suggests actions like distilling patterns, merging duplicates, or refining low-performing guides.
- **Auto-linking:** Frequently co-read memories and topic-overlapping fragments are automatically connected with relations.

Manual deep analysis is also available via dedicated tools.

## Tools (29)

Lemma exposes short MCP tool names such as `memory_read`, `memory_add`, and `session_start`. Most clients display tools with the server namespace prepended, so you may see names like `mcp_lemma_memory_add`; that is expected. Redundant doubled names like `mcp_lemma_lemma_memory_add` are not used.

### Memory (10)

| Tool | Purpose |
|------|---------|
| `memory_read` | Read/search fragments. Summary mode or full detail by ID |
| `memory_add` | Save findings. Auto-redacts secrets, detects duplicates and conflicts |
| `memory_update` | Update fragment by ID |
| `memory_feedback` | Positive/negative feedback, adjusts confidence |
| `memory_forget` | Delete fragment |
| `memory_merge` | Merge fragments, inherit relations & guide links |
| `memory_relate` | Create typed links (`contradicts`, `supersedes`, `supports`, `related_to`) |
| `memory_stats` | Fragment counts, confidence, project breakdown |
| `memory_audit` | Integrity check for orphans, duplicates, anomalies |
| `memory_library` | Full knowledge base snapshot with analysis signals and suggestions |

### Guides (7)

| Tool | Purpose |
|------|---------|
| `guide_get` | Get guides sorted by usage, filter by category or task |
| `guide_practice` | Record guide usage. Auto-creates guide if missing |
| `guide_create` | Create guide with detailed manual |
| `guide_distill` | Transform memory → guide learning (bidirectional link) |
| `guide_update` | Update guide properties, anti-patterns, pitfalls |
| `guide_forget` | Remove guide |
| `guide_merge` | Merge guides, inherit source memories |

### Sessions (5)

| Tool | Purpose |
|------|---------|
| `session_start` | Start traced session, pre-loads relevant context |
| `session_attempt` | Record a tried approach (rejected/partial/promising) — dead ends are valuable memory |
| `session_end` | End session with review, auto-linking, and suggestions |
| `session_stats` | Virtual session statistics |
| `suggestion_respond` | Accept or dismiss a surfaced improvement suggestion (teaches Lemma your preferences) |

### Intelligence (4)

| Tool | Purpose |
|------|---------|
| `conflict_scan` | Scan all memories for contradictions |
| `proactive_analysis` | Full knowledge base analysis: stale, orphan, distill, deprecated |
| `project_analytics` | Cross-session project health, growth rate, skill coverage |
| `semantic_search` | TF-IDF similarity search across memories |

### Backup and restore (3)

| Tool | Purpose |
|------|---------|
| `backup_create` | Create and verify one portable backup of all database records |
| `backup_preview` | Validate a backup, compare record counts, and prepare a confirmation token |
| `backup_restore` | Replace memory after explicit confirmation, with a mandatory safety backup |

## Backup and restore through MCP

No terminal command is needed. Ask your assistant **"Back up my Lemma memory to this folder"** or **"Restore my Lemma memory from this backup file"**. The assistant uses the three tools above.

1. **Back up:** `backup_create` accepts an optional absolute `directory` (also supports `~/...`). It returns the path of a verified `.lemma-backup` file. By default files go to `~/.lemma/backups/`, with unique timestamped names; existing backups are never overwritten.
2. **Move:** copy that file to your external drive or chosen storage. On a new computer, install a compatible Lemma MCP release and make the file available locally. The format is independent of Windows, macOS and Linux; it contains no destination directory paths.
3. **Preview:** the assistant calls `backup_preview` with the file's absolute `path`. It shows backup/current record counts and explains that restore **replaces all projects and global memory**, rather than merging them. It also reports connection readiness: `ready` means no other cooperating connections were detected; `blocked` explains the connection blocker. A blocked preview returns no confirmation token, invalidates earlier tokens, and does not ask for approval. Close the other Lemma connections or visualizers as indicated, keep the assistant's current MCP connection open, and preview again. Once ready, explicitly approve that preview. Open conversation tabs alone do not determine readiness; registered database connections do. This check cannot detect older Lemma versions or external SQLite tools.
4. **Restore:** the assistant passes the preview's `confirmation_token` and `confirm: true` to `backup_restore`. Lemma first creates and verifies a `before-restore-*.lemma-backup` of the current database, then restores and checks the records in one SQLite transaction. On failure before commit the old database remains intact. The returned `safety_backup_path` can be used in the same preview/restore flow to undo a restore.

The current MCP connection stays usable. Its old in-memory session is discarded so it cannot overwrite restored history. Sessions that were active when the backup was taken become abandoned history. Existing conversation text is not erased; start a new conversation when you need a fresh context.

The preview identifies the serving connection in `readiness.current_connection` and lists every detected live peer in `readiness.blocking_connections`, with process IDs and distinct connection IDs. `same_process` flags another connection inside the current process: do not terminate that process. Conversation names and IDs cannot be inferred from these registrations (`conversation_mapping: "unavailable"`). Unverifiable registrations and inspection failures remain blockers and are reported separately. These are diagnostic details, not instructions to terminate processes; close other connections through their application and preview again.

**Included:** all persisted database records, including global/project memories, invalidated fragments, archives, guides and learnings, relationships, evidence, feedback, fragment versions, session history, attempts, suggestions and search cache. Search indexes are rebuilt during restore. Paths quoted *inside* memory/evidence remain unchanged; project folder names and evidence paths may need attention after moving computers.

**Excluded:** `config.json`, raw session/traffic logs, diagnostic logs, installed skills/models, and the MCP client's own configuration. These are machine-specific settings or auxiliary files and are left unchanged on restore. This is a database recovery feature, not a full installation backup or cloud synchronization service. `lemma -lib` is a readable report, not a restorable backup.

**Limits and safeguards:**

Upgraded installations may retain the unused `memory_vectors` / `vec0` scaffold removed in Lemma 0.15.0. Backups accept only its known table definitions, version metadata and empty payload tables with no prior write counters. The original snapshot retains these legacy structures. Restore preserves them if already present on the target, but does not recreate the retired index on a fresh installation. Memories, guides and current search data are restored normally. Nonempty vectors, altered scaffolding and other unknown schema changes are rejected; the live database is never cleaned up automatically.

- Backups are unencrypted and contain private knowledge. Keep them in trusted storage. A backup on the disk being formatted will also be lost; keep a copy elsewhere.
- This initial format supports databases up to 128 MiB. Backups in this format with known database schemas 1–8 can be restored to the current schema (8). Older schemas are matched against their exact known definitions and complete migration history, then upgraded and verified on an in-memory copy using only bundled migrations. The original file is unchanged. Preview reports `schema_upgrade` with the version range and notes; show these before requesting confirmation. Upgrades from schema 1 or 2 normalize project paths/names and global scope, just as the corresponding application migration does. Unknown/newer formats or schemas, changed definitions, failed checksums, broken relationships and invalid SQLite/search indexes are rejected before replacement. This does not import arbitrary old SQLite or JSONL files and does not guarantee compatibility with future releases.
- Confirmation tokens expire after 10 minutes, are single-use, and are bound to both the exact file and current database state. If memory changes while you are deciding, or the MCP connection restarts, preview and confirm again.
- SQLite snapshots include committed WAL data while Lemma is running. Restore holds the SQLite writer lock; other cooperating Lemma connections block restore and newly opening clients wait for that lock. Older Lemma versions and external SQLite programs do not register as clients, so close them before confirming. SQLite still performs the replacement atomically; it never swaps a database file underneath an open connection.
- A checksum detects damaged data; it is not a signature proving who created the backup. Import files only from a trusted source.

## Why was a memory recalled?

Ask your assistant to explain a recall, or pass `explain: true` to `memory_read` or `semantic_search`. It is off by default and adds no new tool. For example:

```json
{"query":"retry policy","project":"my-project","explain":true,"response_format":"json"}
```

The optional `recall_explanation` shows the actual selection method and score, recorded source/session, citations, and evidence-check status. Keyword search reports BM25; browsing reports confidence ordering; semantic search reports TF-IDF; hybrid search exposes its rank-fusion components and distinguishes the score from diversity ordering. Direct ID reads say that the ID was requested, and graph expansion reports its root/depth. Ranks refer to the current filtered search window, subject to existing candidate limits.

This explains **the current call**, not why an earlier conversation or automatic context injection selected a memory. Metadata is captured before this read boosts access/confidence. Scores and source labels do not establish correctness, and last access is not last verification. Citation checks run only when `verification.stale_check` is enabled, check at most five citations per record, and report truncation. A present snippet is not proof that the claim is true; without evidence or with verification disabled the result says so. Both readable text and JSON are supported.

No correction is applied by asking for an explanation. After reviewing it, use `memory_update` to correct content, `memory_forget` with `invalidate: true` to hide outdated knowledge while preserving history, or `memory_relate` to record a replacement/contradiction.

## Configuration

Optional config at `~/.lemma/config.json`:

```json
{
  "token_budget": {
    "full_content": 5000,
    "summary_index": 1000,
    "guides_detail": 1000
  },
  "injection": {
    "max_full_content_fragments": 15,
    "max_summary_fragments": 30,
    "max_guides": 20
  },
  "virtual_session": {
    "timeout_minutes": 30
  }
}
```

## File Locations

| OS | Path |
|---|---|
| **Windows** | `C:\Users\{username}\.lemma\` |
| **macOS/Linux** | `~/.lemma/` |

Files: `lemma.db` (SQLite), `config.json`, `sessions/`, `logs/`

## Search

Lemma uses **SQLite FTS5** full-text search for memory lookup, dedup, and topic overlap detection.

**Architecture:**
- `searchAndSortFragments()` — FTS5 full-text search, fallback to in-memory ranking
- `findSimilarFragment()` — FTS5 BM25-based dedup with keyword overlap fallback
- `findTopicOverlaps()` — FTS5 search + word overlap scoring for related fragment detection

## Data Storage

All data is stored in a single SQLite database (`~/.lemma/lemma.db`):

| Table | Purpose |
|-------|---------|
| `memories` | Memory fragments (FTS5 + metadata) |
| `guides` | Procedural knowledge with learnings |
| `sessions` | Session tracking and outcomes |
| `relations` | Typed links between memories |
| `guide_learnings` | Per-guide accumulated learnings |
| `guide_memory_links` | Bidirectional guide ↔ memory links |

Legacy JSONL files are automatically migrated on first run.

## Security

Lemma is local-first by design:

- **Local storage** — all data stays in `~/.lemma/`; nothing is sent to external servers.
- **Secret redaction** — secrets are scrubbed from memory fragments AND from traffic logs (17 regex patterns for API keys, tokens, connection strings; position-based so over-redaction and overlap bugs are avoided).
- **Visualizer hardening** — the visualizer binds `127.0.0.1` only (never `0.0.0.0`), requires an `X-Lemma-Token`, and uses a narrow localhost CORS allow-list (no `Access-Control-Allow-Origin: *`).

## Documentation

- [Development Guide](docs/development/DEVELOPMENT.md) — Architecture, project structure, testing
- [Roadmap](docs/development/ROADMAP.md) — Research-grounded plan + backward-compatibility contract
- [Research](docs/research/README.md) — Academic papers that influenced Lemma's design
- [Changelog](CHANGELOG.md) — Version history

## License

MIT
