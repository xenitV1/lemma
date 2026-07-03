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

## Tools (26)

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
