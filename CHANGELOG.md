# Changelog

## [0.18.2] - 2026-06-26

Hotfix for two recurring `memory_update` failures. (1) `fts5: syntax error near "OR"` whenever a fragment body contained the words OR/AND/NOT/NEAR — lemma fed user content into the FTS5 query unquoted, so FTS5 parsed those words as boolean operators. (2) A false-positive `Similar fragment already exists` blocked legitimate updates whenever the new text shared even a single common token (e.g. "COS") with any other fragment, because `memory_update`'s dedup had no similarity threshold (unlike `memory_add`).

### Fixed
- **FTS5 operator-injection** — added a shared `sanitizeFtsQuery` (`src/db/fts.ts`) that double-quotes each token, so AND/OR/NOT/NEAR and reserved characters in fragment/search text are matched as literals instead of parsed as query syntax. Wired into all five user-content FTS sites (`memory-store.ts` search, `findSimilarFragment`, `findTopicOverlaps`, `findSimilarByText`, and the `memory_update` dedup). The guide prefix-wildcard sites (which cannot be quoted without breaking prefix matching) now filter boolean-operator tokens via `FTS_BOOLEAN_OPS`, and `STOP_WORDS` gained `"near"`.
- **`memory_update` false-positive dedup** — the inline FTS top-3 check is replaced with `findSimilarByText(..., 0.80, excludeId)`, giving it the same word-overlap threshold `memory_add` already used, and excluding the fragment being updated so editing it never matches itself.

### Verified
- `npm run typecheck`
- `npm test` (736/736, +4 regression tests: FTS operator-word fragments survive `findSimilarByText`/`memory_add`/`memory_update` without syntax errors; low-overlap `memory_update` no longer blocked)

## [0.18.1] - 2026-06-26

Hotfix: the 0.18.0 `postinstall` hook (`node dist/server/install-skill.js`) failed where `dist/` is absent — most importantly Lemma's own CI (`npm ci` runs postinstall before the build step) and anyone cloning the source repo (where `dist/` is gitignored). Published-package consumers were unaffected because the tarball ships `dist/`.

### Fixed
- **Guarded postinstall bootstrap** (`scripts/postinstall.mjs`): runs `installSkill()` only when `dist/server/install-skill.js` exists; otherwise it is a no-op that exits 0. Real consumers (dist shipped) still get the SKILL.md written on install/upgrade; source clones and CI no longer break.
- Added `scripts/postinstall.mjs` to the npm `files` allowlist so the bootstrap ships with the package.

### Verified
- `node scripts/postinstall.mjs` writes SKILL.md when `dist/` is present (exit 0).
- `node scripts/postinstall.mjs` is a no-op (exit 0) when `dist/` is absent — CI/clone scenario.
- `npm run build`, `npm run typecheck`, `npm run test:server` (281/281).

## [0.18.0] - 2026-06-26

Codex compatibility release. Codex CLI does **not** inject the MCP server `instructions` field into the system prompt the way Claude Code does — it only uses it as a namespace tool description — so Lemma's "recall → act → persist" rules never reached the model as a system instruction, and the LLM did not auto-call Lemma tools without manual prompting. This release installs a `SKILL.md` to `~/.agents/skills/lemma/` — the open skill format that Codex (and Claude Code) load into the system prompt via progressive disclosure — giving those clients a reliable channel for Lemma's usage rules on install/upgrade and on every server start. The existing MCP `instructions` flow is unchanged; this is an additive, Codex-friendly side channel.

### Added
- **Auto-installed `SKILL.md` at `~/.agents/skills/lemma/SKILL.md`.** Codex and other skill-format clients discover Lemma's usage rules (workflow, two knowledge layers, full 20-tool inventory, fragment format, relations) and load them into the system prompt when a task matches the skill description.
- **`npm postinstall` hook** (`node dist/server/install-skill.js`) writes/updates the skill file on `npm install lemma-mcp` and `npm update` — no manual setup needed by the user.
- **Runtime safety net:** `startServer()` re-checks the skill file on every launch (idempotent, version-gated), so the file stays current even for users who run via `npx` or never reinstall.
- **`lemma --install-skill` CLI** to manually (re)install/update the skill file.
- New modules `src/server/skill-content.ts` (skill content + version stamp) and `src/server/install-skill.ts` (idempotent installer; serves postinstall, CLI, and runtime).

### Changed
- `src/index.ts` dispatches the new `--install-skill` flag.
- `installSkill` accepts an optional `{ skillDir }` override (testability); defaults to `~/.agents/skills/lemma/`. Production behavior unchanged.

### Verified
- `npm run typecheck`
- `npm run test:server` (281/281, +9 new install-skill tests)
- `npm run build`
- Manual: postinstall write, idempotency (same-version skip), version-stamp upgrade (older → current), server runtime hook log, `-lib`/`-vis` modes unchanged.

## [0.17.2] - 2026-06-26

Hotfix: `memory_read` single-id and batch (`ids`) paths returned only `{id}` in `structuredContent.fragments`, stripping title/type/fragment/confidence/project. The text body (`content[0].text`) still carried the full detail via `formatMemoryDetail`, but MCP clients that consume `structuredContent` (the path advertised by `outputSchema`) saw empty fragments — so `memory_read id="..."` and `session_start` preloaded memories appeared content-less. This was a regression introduced by the 0.16.0 outputSchema alignment, where the batch/single paths were collapsed to `{id}` objects to satisfy schema validation without restoring the real fields.

### Fixed
- **Single-id path now returns full fragment fields in `structuredContent`.** `memory_read id="..."` populates `fragments[0]` with `id`, `title`, `description`, `type`, `confidence`, `project`, `fragment` (full body), and `created` — matching the richness of `formatMemoryDetail` that the text body already carried.
- **Batch path (`ids`) now returns full fragment fields for each found fragment.** Previously `fragments` was `readIds.map(rid => ({ id: rid }))`; it now maps over the boosted fragment objects and emits the same shape as the single-id path.
- Both paths keep `has_more: false` / `next_offset: null` and the existing `content[0].text` rendering, so clients reading the markdown body are unaffected.

### Added
- **Regression tests** (`tests/server/memory-read-advanced.test.ts`) asserting that `structuredContent.fragments` carries `title`, `fragment` (body), `confidence`, and `type` for both single-id and batch lookups. The pre-existing tests only asserted on `content[0].text`, which is why this regression went undetected since 0.16.0.

### Verified
- `npm run typecheck`
- `npm run test:server` (272/272, +2 new regression tests)
- `npm run build`

## [0.17.1] - 2026-06-25

Project-key normalization patch. Memory was still being filed under divergent keys (mixed case, full paths, the literal string `"global"`) despite the 0.16.0 project-isolation work, because `addFragmentToDb` bypassed the normalization that only `addMemory` had. Per-project recall silently missed memories filed under a sibling key — the "current project filter didn't recognize the project" symptom.

### Fixed
- **Write-side project normalization (root cause).** `memory_add` / `memory_merge` / `session_start` now resolve the project scope through a single chokepoint (`resolveProjectScope`): omitted → detected project (`basename(cwd)`); explicit `null` → global; explicit string → canonicalized (basename + trim + lowercase); the literal `"global"` → global. `addFragmentToDb` also normalizes defensively, so no write path can store a raw key. Fixes the split-key problem caused by values like `Ailyro` vs `ailyro`, `/home/x/Projeler/foo/bar`, and `project: "global"`.
- **`project` schema `default: null` removed** from `memory_add` / `memory_merge`. The default caused MCP clients to auto-send `null` for an omitted field, silently filing project-scoped memories as global. Omitting the field now means "auto-detect".

### Added
- **`SCHEMA_V3` startup migration** (idempotent, version-gated): backslash → slash → basename → lowercase → `global` → NULL, applied to both `memories` and `sessions`. Heals historical dirty keys on the next server start for all users — `Ailyro` + `ailyro` merge, full paths collapse to their basename, `"global"` becomes true global (NULL). Re-running is a no-op.

### Known limitation
- Memories already stored as `NULL` (global) from the pre-0.17.1 `default:null` trap cannot be auto-reassigned to their original project (the project is not recoverable from storage). They remain global; reassign manually via `memory_update` where the intended project is obvious from content.

### Verified
- `npm run typecheck`
- `npm test` (721/721, +17 new)
- `npm run build`
- Live DB healing observed: `schema_version` 2 → 3, zero residual dirty keys.

## [0.17.0] - 2026-06-25

MCP usability + release hardening. Tool names are short again, SDK initialize negotiation is back on the standard path, and the stdio server is quieter and more reliable for clients that decide when to auto-use Lemma.

### Breaking Changes
- **All 26 MCP tools renamed back to short names** (`lemma_memory_read` -> `memory_read`, `lemma_memory_add` -> `memory_add`, `lemma_guide_get` -> `guide_get`, `lemma_session_start` -> `session_start`, etc.). MCP clients already namespace tools by server, so the previous names displayed as redundant forms like `mcp_lemma_lemma_memory_add`. New display names should be `mcp_lemma_memory_add`, `mcp_lemma_memory_read`, and so on. Existing clients or scripts that call the 0.15/0.16 `lemma_*` names must update to the short names.

### Fixed
- **LLM auto-use regression around Lemma discovery.** The server now keeps the MCP stdio process alive reliably, avoids pre-transport stdin sniffing, and no longer pollutes stderr with normal INFO/WARN/debug noise. This keeps the client handshake and tool discovery path cleaner, which directly affects whether models see and choose Lemma tools without manual triggering.
- **Custom `initialize` handler replaced with the SDK standard initialize path.** Lemma still returns dynamic `instructions`, but client capabilities/protocol negotiation is handled by the MCP SDK instead of a hand-written response.
- **`guide_get` outputSchema mismatch.** Single-guide, task-suggestion, and list modes now return a consistent structured shape.
- **`project_analytics` overview outputSchema mismatch.** Overview and single-project modes now return all declared fields with explicit `null`/empty-array values where appropriate.
- **`memory_read` tool annotations.** It is no longer advertised as read-only because reading updates access/session state.
- **Persisted active session recovery.** Session operations now rehydrate the active session from the database if process-local state is lost.
- **Session link cleanup.** `saveSessions` clears stale guide/memory links and skips missing link targets instead of violating foreign keys.
- **CLI polish.** `lemma --help`, `lemma --version`, invalid visualizer ports, and `lemma -lib` output are cleaner; `-lib` writes the snapshot to stdout.

### Changed
- Docs and tests now use the short tool names across README, Turkish README, manual MCP tests, contract tests, prompt nudges, and handler routing.
- npm package contents now include `docs/README.tr.md` instead of a nonexistent root `README.tr.md`.

### Verified
- `npm run typecheck`
- `npm test` (61/61)
- `npm run build`
- `npm run test:mcp`
- `node tests/manual/lemma-confirm-test.mjs`
- `node tests/manual/lemma-deep-test.mjs`
- `npm pack --dry-run --json`

## [0.16.0] - 2026-06-16

MCP correctness + project isolation release. All 26 `outputSchema`s now match the actual tool return data (enforced by the SDK under protocol `2025-06-18`), and memory is now isolated per project by default instead of silently leaking global.

### Fixed
- **`structuredContent` was never populated** (advertised in 0.15.0 but never emitted). `outputSchema` existed on all 26 tools yet handlers returned only text. Under protocol `2025-06-18` this is enforced, so every tool now returns `structuredContent` matching its `outputSchema` — added to ~16 success paths (`session_start/end/attempt`, `suggestion_respond`, `memory_read` batch/single, `memory_add/update/forget/feedback/merge/relate`, `guide_practice/create/distill/update/forget/merge`). `buildResult` (`format.ts`) already mapped `data`→`structuredContent` for the read tools.
- **6 `outputSchema`/data mismatches that broke tools under SDK validation (`MCP error -32602`):**
  - `lemma_memory_read`: `next_offset` was `number` but the handler returns `null` on the last page / single-id / batch lookups → `-32602`. Now `["number","null"]`. The batch/single paths also returned `fragments` as a string array; now an object array (`{id}`) to match the schema.
  - `lemma_memory_stats`: advertised `by_type` (not returned); corrected to the real fields (`by_source`, `by_project`, `low_confidence`, `high_confidence`).
  - `lemma_memory_audit`: advertised `orphan_count` + `issues:object[]`; corrected to the actual `issues_found` + `issues:string[]` + `healthy` + `total_fragments`.
  - `lemma_session_stats`: advertised `{sessions, technologies}`; corrected to the real `{active_session, recent_sessions}`.
  - `lemma_memory_library`: `relations` is an object (graph summary), not an array; `suggestions` items are strings, not objects — both corrected.
  - `lemma_project_analytics`: advertised fields were absent in overview mode; all fields made optional to reflect the two modes (single-project vs overview).
- **Project isolation silently broken.** `lemma_memory_add` / `lemma_memory_merge` stored fragments as **global** (`project:null`) when the LLM omitted the `project` arg, so a note saved in project A leaked into project B. Now: explicit `project` wins; omitted → detected project (`basename(cwd)`); explicit `null` forces global. Proven end-to-end across separate server processes sharing one DB.

### Changed
- **`protocolVersion` bumped `2024-11-05` → `2025-06-18`.** The newer protocol enforces `outputSchema` validation, which surfaced the mismatches above. Backward compatible for well-formed clients.
- **`additionalProperties: false`** added to all 26 input schemas (strict validation — strict clients reject unknown arguments).
- **`project` field type** on `lemma_memory_add` / `lemma_memory_merge` changed from `"string"` to `["string","null"]` (JSON Schema type/default consistency).

### Added
- **Deep MCP flow tests** (`tests/manual/lemma-confirm-test.mjs`, `lemma-deep-test.mjs`, `lemma-inject-test.mjs`): exercise every tool end-to-end, assert `structuredContent` + `outputSchema` key coverage + pagination, and prove project-scoped injection (fresh install → cross-session persistence → isolation) across separate server processes sharing one `~/.lemma` DB.

### Fixed (test/tooling)
- `tests/manual/mcp-smoke.mjs` still called tools by unprefixed names after the 0.15.0 `lemma_` rename, so `npm run test:mcp` was broken. Updated.

## [0.15.0] - 2026-06-14

An MCP-effectiveness sprint: tools are now safer and cheaper for agents to use, with no runtime behavior change beyond one bug fix. MCP effectiveness 4.6 → ~7.5/10.

### ⚠ Breaking Changes
- **All 26 tools renamed with the `lemma_` prefix** (e.g. `memory_read` → `lemma_memory_read`, `guide_get` → `lemma_guide_get`, `session_start` → `lemma_session_start`). The unprefixed names collided with other MCP servers' namespaces and made tool selection ambiguous for agents. **Existing clients must update every tool call.** This was the highest-risk change and is covered by contract tests (`tests/server/tools.test.ts`) that lock the 26-name allowlist, the prefix, the annotation matrix, and the outputSchema presence.

### Added
- **MCP tool annotations** — every tool now declares `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`. Read-only tools (10) advertise `readOnlyHint:true` so agents can call them without confirmation; destructive tools (`lemma_memory_forget`, `lemma_memory_merge`, `lemma_guide_forget`, `lemma_guide_merge`) advertise `destructiveHint:true`. All tools set `openWorldHint:false` (local DB, no external world).
- **`outputSchema` + `structuredContent`** — every tool declares a JSON schema for its return shape, and read tools return machine-parseable `structuredContent` alongside the human-readable text. Clients can now process results programmatically instead of parsing markdown.
- **Pagination** on `lemma_memory_read`, `lemma_semantic_search`, `lemma_memory_library` via `limit` (default 30, max 100) / `offset` (default 0), with `has_more` + `next_offset` in the response. Large result sets no longer dump hundreds of fragments into context.
- **`response_format`** (`markdown` | `json`, default `markdown`) on the 10 read-style tools, so a client can request raw JSON for machine processing.
- Contract test suite (`tests/server/tools.test.ts`) pinning the tool registry: exact 26-name allowlist, no duplicates, mandatory `lemma_` prefix, mandatory `outputSchema`, mandatory `openWorldHint:false`, and the full annotation matrix.

### Fixed
- **Conflict-detection false positives.** `src/intelligence/conflict.ts` matched advisory words (`avoid`, `pitfall`, `mistake`, `deprecated`, …) as negation signals, so a `warning`/`lesson` fragment was incorrectly marked `contradicts` any fact about the same topic. Advisory vocabulary is now in a separate `ADVISORY_PATTERNS` set excluded from the XOR; only true logical negation (`not`, `never`, `however`, `but`, …) participates. Regression test added.

### Removed
- **`sqlite-vec` dependency and dead vector code.** The `vec0` `memory_vectors` table and `searchByVector()` were never used at runtime — semantic search has always run on in-process TF-IDF cosine similarity (`semantic.ts`). Removed the dependency, the table DDL, and the unused function. SQLite (`better-sqlite3`) remains the primary store.
- **`_js_backup/`** — 32 stale JS files left over from the JS→TS migration.
- **`vitest` and `tsup` devDependencies** — the project tests with `node --test` + `tsx` and builds with `tsc`; the configs were never wired up.
- **`decayConfidence()`** — a duplicate in-memory decay pass superseded by the DB-backed `decayMemories` (already removed at the call site in 0.14.0; the orphaned function and its tests are now gone).

### Changed
- **Dependency refresh** (`npm update`) — `@modelcontextprotocol/sdk` 1.27.1 → 1.29.0, `better-sqlite3` 12.9.0 → 12.10.1, `@types/node` 25.6.0 → 25.9.3, `tsx` 4.21.0 → 4.22.4. No major-version jumps.
- Docs (README, README.tr, DEVELOPMENT, ROADMAP) updated to the `lemma_` tool names; the stale `memory_vectors` table reference in DEVELOPMENT.md is corrected.

## [0.14.1] - 2026-06-14

### Fixed
- **Hotfix: the published package crashed on Node 22+.** `src/version.ts` read `package.json` through a bare ESM import (`import pkg from "../package.json"`). That compiles under `tsc` but throws `ERR_IMPORT_ATTRIBUTE_MISSING` at runtime on Node 22+, because JSON imports there require `with { type: "json" }`. The failure was invisible under `tsx` (used by the test runner) but broke `npx lemma-mcp` outright — every client got `Failed to connect`. Switched to `fs.readFileSync`, which works on every supported Node version. No behavior change beyond that.

## [0.14.0] - 2026-06-14

### Added
- **Reasoning continuity spec coverage** — three-layer recall (dead ends → lessons → warnings, spec §5.2), warning-fragment fallback for repeated dead ends with no guide (§5.3), and the accept→boost leg of the self-critique loop mirroring dismiss→penalize (§5.4). `memory_read` query results are now project-scoped and tracked into the active session's `memories_read`; `session_start` passes existing guides to `suggestGuides` so DB-only guides surface as tracked.

### Fixed
- **Single decay source** — `applySessionDecay` no longer runs an in-memory `decayConfidence` pass alongside the DB `decayMemories` pass; injected confidence can no longer diverge from persisted confidence across calls.
- **Project key canonicalization** — project is normalized (trimmed + lowercased) on every write (`addMemory`, `updateMemory`) and `getMemoryStats` filters `lower(project) = ?`; `detectProject()` also normalizes so `memories.project` and `sessions.project` cannot diverge by case (which would silently break recall).
- **Server version drift** — MCP `serverInfo.version` was hardcoded `1.0.0`; now read from `package.json` via `src/version.ts`.
- **Visualizer security** — binds `127.0.0.1` (not `0.0.0.0`), requires an `X-Lemma-Token`, and narrows CORS to the localhost origin allow-list.
- **Traffic-log secret redaction** — tool-call arguments and responses are passed through `redactSecrets` before being written to disk.
- **Position-based secret redaction** — `redactSecrets` uses a single left-to-right overlap pass so `sk-proj-…` no longer over-reports, and independent words matching a secret value are no longer masked.

### Changed
- **Semantic search documentation** — TF-IDF cosine similarity is now documented as the official approach; the `vec0` `memory_vectors` table and `searchByVector` are marked reserved for a possible v0.14 embedding pipeline (spec §5.3).

## [0.13.0] - 2026-06-13

### Added
- **Reasoning continuity (dead-end recall)** — `session_start` recalls recent rejected/partial attempts within `token_budget.continuity` and boosts promising ones, so the model does not repeat dead ends across sessions.
- **Repeated dead-end distillation** — TF-IDF-verified distillation of repeated failed approaches into guide pitfalls (no false positives), with a 24h self-maintaining decay of prior reasoning attempts.
- **Self-critique loop** — `session_attempt` tool (25th) captures reasoning attempts and activates `self_critique_count`; `suggestion_respond` tool (26th) closes the dismiss→penalize leg.
- **Persistent improvement suggestions** — low-success suggestions are persisted and surfaced at `session_start` (offered, never enforced), with deterministic ordering and re-offer semantics.
- **Self-contained system prompt** — `src/server/prompt-content.ts` ships the full instructions template and per-tool behavioral nudges; `buildInstructions` returns real teaching content with no external pointer. Behavioral nudges are appended to tool descriptions.
- **SCHEMA_V2** — `session_attempts` and `improvement_suggestions` tables with back-compat migration tests.
- MCP smoke integration test asserting tool count and the continuity flow.

### Changed
- `BASE_SYSTEM_PROMPT` is now self-contained (no AGENTS.md pointer).

### Fixed
- `session_attempt` `recordAttempt` wrapped in try/catch (best-effort, never throws).
- Honest outcome casting, redacted echo, invalid-enum tests.

### Removed
- **Stopped writing AGENTS.md.** Lemma no longer injects memory content into `AGENTS.md` files; stale Lemma blocks are auto-cleaned on startup. Memory injection now flows through the MCP prompt layer only.

## [0.11.5] - 2026-05-11

### Added
- **HTML vs Markdown Output Strategy seed** — New built-in memory fragment (`seed_html_output_strategy`) and guide seed (`html-output-strategy`) that teaches LLMs context-aware format selection. Uses HTML for complex specs, diagrams, reports, and prototypes; Markdown for quick answers, code edits, and version-controlled docs. Inspired by Thariq's research on HTML effectiveness for AI agent communication.
- Cross-reference between memory seed and guide seed via `related_guides` / `source_memories` fields.
- `SeedEntry` interface now supports `related_guides` for linking memory seeds to guides.
- `SeedGuide` interface now supports `source_memories` for linking guide seeds to memory fragments.

### Changed
- Replaced `seed_senior_engineer_role` memory seed with `seed_html_output_strategy` — more universally applicable across all LLM use cases.
- Seed counts: 3 memory seeds, 4 guide seeds (was 3 memory, 3 guide).

---

## [0.11.4] - 2026-05-08

### Fixed
- **BUG-2: Double confidence boost on memory search** — `searchMemories()` was incrementing `accessed` counter and boosting confidence on top of `handleMemoryRead`'s own boost. Removed boost from search level; boost now only happens at handler level representing explicit "user read" intent. (`src/db/memory-store.ts`)
- **BUG-3: Phantom in-memory decay in processFragments** — `processFragments()` was calling `decayConfidence()` on in-memory objects loaded from DB, but since objects are re-loaded on next call, the decay was never persisted — pure waste. Removed the phantom call. (`src/server/system-prompt.ts`)
- **BUG-4: Wrong column in guide name search** — `findSimilarGuideByName()` used `WHERE name LIKE` but the guides table stores names in `guide` column, not `name`. Changed to `WHERE guide LIKE`. (`src/guides/core.ts`)
- **HIGH-1: Session start boost with legacy_id** — `handleSessionStart` called `boostConfidence()` with a `legacy_id` string instead of numeric `id`. Added `legacy_id → id` resolution before boost. (`src/server/handlers.ts`)
- **HIGH-2: Auto-relation without query** — Auto-association and auto-relation blocks in `handleMemoryRead` ran even when no `query` was provided (plain listing). Added `query &&` guard. (`src/server/handlers.ts`)
- **HIGH-3: Statement cache unbounded growth** — `prepareCached()` in LemmaDB had no eviction limit. Added `MAX_CACHE_SIZE = 200` with LRU-like eviction (removes 50 oldest when full). (`src/db/database.ts`)
- **HIGH-4: Decay running on every startup** — `decayMemories()` ran on every server startup regardless of timing. Added `shouldRunDecay()` / `markDecayRun()` using `schema_version` table as 24h timestamp gate. Decay now runs at most once per 24 hours. (`src/db/memory-store.ts`)

### Changed
- Test updated: `searchAndSortFragments` no longer boosts — test now verifies `accessed === 0` and `confidence` unchanged after search. (`tests/memory/fts5-search.test.ts`)

---

## [0.11.3] - 2026-05-06

### Added
- **Senior Engineering Mindset seed** (`seed_senior_engineer_role`) — New built-in memory fragment that activates Principal Engineer / System Architect role exclusively for software & coding tasks. Covers pre-code comprehension protocol, production-grade standards, change principles, and impact assessment. Scope-limited: only active for coding/debugging/architecture tasks, inactive for general conversation and content work.
- Seed count: 3 → 4 built-in knowledge fragments.

---

## [0.11.2] - 2026-05-05

### Added
- **Auto-daemonize** — `lemma -vis` now spawns a detached background process (`detached: true`, `unref()`). Works cross-platform (macOS, Linux, Windows). Parent exits immediately, server stays alive. No `nohup`/`disown` needed.
- **`--fg` flag** — Run `lemma -vis --fg` to start in foreground (for manual terminal use with Ctrl+C).

### Changed
- **AGENTS.md `-vis` instruction** simplified — AI just runs `npx lemma-mcp -vis`, no platform-specific bash tricks needed.

---

## [0.11.1] - 2026-05-05

### Added
- **Right-click context menu** on nodes — View Detail, Edit, Link from here, Remove all links, Select, Delete
- **Background mode instruction** in AGENTS.md — `-vis` command now runs with `&` to prevent bash timeout from killing the server

### Fixed
- **`await` in non-async function** — `handleLinkClick` was not marked `async`, causing SyntaxError in server mode

---

## [0.11.0] - 2026-05-05

### Added
- **Memory Visualizer** (`lemma -vis`) — Interactive D3.js force-directed graph of all memory fragments, served via local HTTP server (default port 3456, customizable with `-p`). Opens automatically in the browser. Cross-platform (macOS, Linux, Windows).
  - New module: `src/server/visualize.ts` — Node `http` server with REST API, no external dependencies
  - REST API: `GET /api/data`, `GET /api/stats`, `GET /api/health`, `PATCH /api/fragments/:id`, `DELETE /api/fragments/:id`, `POST /api/relations`, `DELETE /api/relations`, `GET /api/export`
  - All mutations (edit, delete, link, unlink) write directly to SQLite in real-time
  - Dual-mode HTML: `http://` serves from API server, `file://` works standalone with JSONL drag-and-drop
  - HTML asset bundled via `assets/visualizer.html`, copied to `dist/server/` on build
  - `-vis` shorthand command added to AGENTS.md auto-injection (`agents-md.ts`)
  - Port conflict handling with `EADDRINUSE` error message

---

## [0.10.2] - 2026-05-02

### Fixed
- **BM25 sigmoid dedup false positives** — `memory_add` was rejecting new fragments with "similar memory already exists" errors even for completely unrelated content. Root cause: FTS5 `bm25()` returns negative scores (more negative = more relevant), but `1/(1+exp(score/2))` converted all negative scores to 0.95+ similarity, blocking everything.
  - Replaced sigmoid scoring with word overlap verification: FTS5 used only for candidate retrieval, actual dedup decision based on `overlap / queryWords.size` threshold
  - Applied to both `findSimilarFragment` and `findSimilarByText` in `src/memory/core.ts`
  - Research confirmed BM25 is a relevance ranking function (not a similarity metric) — it cannot be directly normalized to 0-1 similarity without a verification step
- **`searchAndSortFragments` ignored `fragments` parameter in query mode** — When query was provided, FTS5 results from the real DB were returned directly, ignoring the caller's `fragments` array. Now merges in-memory fragments (matching query) with FTS5 results, prioritizing in-memory hits.

---

## [0.10.1] - 2026-05-02

### Fixed
- **Dedup threshold raised** — Default threshold increased from 0.65/0.75 to 0.80 for both `findSimilarFragment` and `findSimilarByText`.

---

## [0.10.0] - 2026-04-30

### Breaking Changes
- **SQLite Migration** — All data storage migrated from JSONL flat files to SQLite (`~/.lemma/lemma.db`). Automatic migration on first launch; JSONL files renamed to `.migrated.bak`. No data loss.
- **Embeddings removed** — `src/memory/embeddings.ts` deleted. Vector search was unreliable; English-only storage rule + FTS5 is the actual solution. `semantic_search` tool still exists but uses FTS5.

### Added — SQLite Storage Layer (`src/db/`)

- **`schema.ts`** — 6 tables: `memories`, `guides`, `relations`, `sessions`, `virtual_sessions`, `library_snapshots`. FTS5 virtual tables for memories and guides.
- **`database.ts`** — `LemmaDB` class wrapping `better-sqlite3`. WAL mode, `prepareCached` for statement reuse.
- **`memory-store.ts`** — Targeted SQL for all memory operations:
  - `addMemory()` — single INSERT
  - `getMemoryById()` — single SELECT by id or legacy_id
  - `updateMemory()` — dynamic UPDATE with field-level granularity
  - `deleteMemory()` — single DELETE
  - `searchMemories()` — FTS5 full-text search with project/type/confidence/date filters
  - `addRelation()` / `getRelations()` — typed bidirectional relations
  - `boostConfidence()` — single UPDATE (confidence + access_count)
  - `getMemoryStats()` — SQL aggregation (no array loading)
  - `mergeMemories()` — transactional merge with relation inheritance
- **`library-store.ts`** — Library Mode: full knowledge base snapshot with stale/duplicate/orphan detection and distill candidates.
- **`migration.ts`** — `migrateFromJsonl()`: reads `memory.jsonl` + `guides.jsonl`, inserts into SQLite, renames originals to `.migrated.bak`. Idempotent.
- **Targeted read functions** (no array loading):
  - `memory/core.ts`: `getFragmentById()`, `findSimilarByText()`, `findTopicOverlapsByText()`, `searchMemory()`, `filterByProjectFromDb()`
  - `guides/core.ts`: `findGuideByName()`, `findSimilarGuideByName()`, `suggestGuidesForTask()`, `getTopGuidesFromDb()`, `getGuidesByCategoryFromDb()`

### Added — Intelligence Layer (`src/intelligence/`)

- **Conflict Detection** (`conflict.ts`) — Negation pattern matching + topic overlap scoring. Detects contradictory fragments without LLM. Runs automatically on `memory_add`.
- **Proactive Analysis** (`proactive.ts`) — 7 suggestion types: distill candidates, low-success guides, merge opportunities, stale guides, unused guides, contradictory pairs, high-value guides. Hot distill detection: 5+ accesses → medium priority, 10+ → high priority.
- **Session Analytics** (`session-analytics.ts`) — Project-level analytics: knowledge growth rate, skill coverage trends, active technologies, guide success rates, health scores.
- **Semantic Search** (`semantic.ts`) — FTS5-based search with project filter and confidence scoring.
- **4 new MCP tools**: `conflict_scan`, `proactive_analysis`, `project_analytics`, `semantic_search`
- **Auto-triggers**: Conflict detection + proactive suggestions run automatically on `memory_add` and `guide_practice`.

### Added — System & CLI

- **AGENTS.md rewrite** — Complete system guide with identity, core concepts, mandatory rules, workflow, intelligence features, maintenance, session management, fragment/guide writing guides, relations. Single source of truth for LLM rules.
- **`system-prompt.ts` simplification** — `BASE_SYSTEM_PROMPT` reduced to ~3 lines. `buildInstructions()` only shows dynamic data (memory list, guide count). No duplicate rules across 3 sources.
- **CLI `-lib` flag** — `lemma -lib` outputs Library Mode snapshot to stderr and exits. No MCP server start.
- **`lemma://context/current` resource** — Dynamic context generation from SQLite.

### Changed — handlers.ts Refactor (Phase 1 + Phase 2)

All 26 handlers refactored from bulk array operations to targeted SQL:

| Metric | Before | After |
|--------|--------|-------|
| `saveMemory()` (full table rewrite) | 17 calls | **0** |
| `saveGuides()` (full table rewrite) | 9 calls | **0** |
| `loadMemory()` (full array to RAM) | 10 calls | **4** (intel/audit only) |
| `loadGuides()` (full array to RAM) | 12 calls | **4** (intel/audit only) |

- **Phase 1 (Write side)**: Every write operation now uses single-row INSERT/UPDATE/DELETE. Before: load entire array → mutate → re-insert all rows. After: `store.updateMemory(db, id, {field: value})`.
- **Phase 2 (Read side)**: 9 new targeted SQL read functions added. Handlers use `getFragmentById()`, `searchMemory()`, `findSimilarByText()` instead of `loadMemory()`.
- **4 remaining `loadMemory`** calls are intentional: `handleMemoryAdd` (conflict scan), `handleMemoryAudit`, `handleConflictScan`, `handleProactiveAnalysis` — inherently need full dataset.
- **4 remaining `loadGuides`** calls are intentional: `handleGuideGet` (list-all), `handleGuidePractice` (merge detection), `handleGuideCreate` (fuzzy match), `handleProactiveAnalysis` — inherently need full dataset.

### Changed — Bug Fixes

- **`session_end` infinite loop fix** — `recordToolCall` now skipped when `toolName === "session_end"`, preventing new virtual session from spawning after session ends.
- **`saveGuides` destructive full-replace** — Changed from full table re-insert to upsert-only. Explicit SQL DELETE where needed.
- **`store.getMemoryStats` threshold** — `high_confidence` threshold aligned with `calculateStats` (>0.8, was >=0.7).
- **Double reverse-relation inserts** — Removed; DB trigger handles reverse relation creation.
- **`config.json` auto-creation** — Creates with defaults on first startup if missing.

### Changed — Documentation

- **README.md** — Updated: 24 tools, intelligence section, SQLite storage, CLI usage.
- **README.tr.md** — Turkish translation updated to match.
- **DEVELOPMENT.md** — Updated with SQLite architecture, build/test instructions.
- **Library Mode plan** — `docs/reports/library-mode-plan.md` added.

### Tests

- **615 tests** passing, 0 failures (was 488)
- New test files:
  - `tests/db/library-store.test.ts` (687 assertions) — Library Mode snapshot, stale/duplicate/orphan detection
  - `tests/db/migration.test.ts` (343 assertions) — JSONL→SQLite migration, idempotency, error recovery
  - `tests/intelligence/conflict.test.ts` (151 assertions) — Negation patterns, topic overlap, auto-trigger
  - `tests/intelligence/proactive.test.ts` (229 assertions) — All 7 suggestion types, hot distill detection
  - `tests/intelligence/semantic.test.ts` (142 assertions) — FTS5 search, project filter
  - `tests/intelligence/session-analytics.test.ts` (137 assertions) — Project analytics, health scores
  - `tests/memory/fts5-search.test.ts` (204 assertions) — FTS5 search, ranking, filters
  - `tests/guides/fts5-search.test.ts` (104 assertions) — Guide FTS5 search
  - `tests/server/library-handler.test.ts` (137 assertions) — Library Mode handler
  - `tests/server/pre-migration-fixes.test.ts` (182 assertions) — Bug fix verification

### Metrics

| Metric | Value |
|--------|-------|
| New source files | 14 (`src/db/` x5, `src/intelligence/` x5, + tools, schema) |
| Deleted source files | 1 (`src/memory/embeddings.ts`) |
| New test files | 10 |
| New tests | 127 (488→615) |
| Lines added | ~8,900 |
| Lines removed | ~2,200 |
| Build | `npm run build` clean |
| Dependencies added | `better-sqlite3` |
| Dependencies removed | `@huggingface/transformers` |

---

## [0.9.1] - 2026-04-26

### Added — Vector-First Search, Session Lifecycle, Docs Restructure

- **Vector-first search** — When embedding model is ready, all search/dedup/overlap uses pure cosine similarity instead of Fuse.js keyword matching. Fuse.js only used as fallback when model unavailable, and for guide name matching (keyword-based).
  - `searchAndSortFragments()` — pure vector search (cosine similarity)
  - `findSimilarFragment()` — async, cosine dedup (threshold 0.85)
  - `findTopicOverlaps()` — async, cosine overlap (0.5–0.85 range)
- **Config-driven embeddings** — New `embeddings` section in `~/.lemma/config.json`:
  - `embeddings.enabled` (default: true) — disable to use keyword search only
  - `embeddings.model` — change embedding model name
- **Immediate embedding on add** — `memory_add` now embeds fragments immediately at creation time instead of lazily on first search.
- **Startup backfill** — `backfillEmbeddings()` runs on startup, auto-embeds any fragments missing vectors.
- **Session lifecycle enforcement** — System prompt now includes rule: "ALWAYS call session_end when you finish a task." Session start message also reminds LLM to call session_end.
- **Session synthesis** — On session finalize, LLM receives: "Synthesize this conversation: call memory_add with a concise summary..." appended to next tool response. Drives automatic session-to-memory knowledge transfer.
- **Session idle threshold** — 2 minutes (was 30s), with 30s idle mark. 30min hard timeout as safety net.

### Changed

- **README** — Semantic Search section expanded with full model details (`paraphrase-multilingual-MiniLM-L12-v2`, 470MB, 384-dim, 50+ languages), architecture, and config example.
- **ROADMAP** — v0.9 embeddings marked DONE, vector-first strategy documented (was "hybrid 0.4*fuse + 0.6*vector"), test count updated to 488.
- **Docs restructured** — `docs/development/` (DEVELOPMENT.md, ROADMAP.md), `docs/research/` (papers, analysis). README simplified from 424→131 lines.
- **`src/memory/embeddings.ts`** — Removed `hybridSearch()`, replaced with `vectorSearch()` (pure cosine). Added `backfillEmbeddings()`.
- **`src/memory/core.ts`** — Removed `embedFragments()`. `findSimilarFragment` and `findTopicOverlaps` now async (return Promise).
- **`src/server/system-prompt.ts`** — Added session_end rule (rule 6), fixed duplicate rule 6/7.
- **`src/server/handlers.ts`** — `memory_add` calls `embedFragment()` after save. `session_end` calls `virtualSession.finalizeVirtualSession()`. All async function calls updated.

### Tests

- **488 tests** passing, 0 failures

---

## [0.9.0] - 2026-04-25

### Added — AGENTS.md, Auto Session, Embeddings, Traffic Logger

- **AGENTS.md auto-injection** — On startup, Lemma injects memory usage rules into the project's `AGENTS.md` file. LLM clients (Claude Code, opencode) read this as system instructions, ensuring consistent memory behavior.
  - New module: `src/server/agents-md.ts`
  - Injects Lemma rules section with start/end markers
  - Idempotent: updates existing injection, preserves non-Lemma content
- **Auto session start** — First tool call auto-starts a virtual session if none active. No explicit `session_start` needed.
- **Auto session end** — Session idle for 2+ minutes triggers finalize on next tool call. 30-minute hard timeout as safety net.
- **Embedding model integration** — `@huggingface/transformers` as optionalDependency. `paraphrase-multilingual-MiniLM-L12-v2` (384-dim, 50+ languages, ~470MB cached at `~/.lemma/models/`).
  - New file: `src/memory/embeddings.ts` — `initEmbeddings()`, `embed()`, `cosineSimilarity()`, `searchByVector()`, `vectorSearch()`, `embedFragment()`
  - Lazy loading: model loads in background, search works via Fuse.js until ready
- **Traffic logger** — All MCP stdio traffic logged to `~/.lemma/logs/traffic/` for debugging client communication issues.
  - New module: `src/server/traffic-log.ts`
  - Incoming/outgoing JSON messages logged with timestamps

### Changed

- **AGENTS.md prompt** — Updated with session lifecycle rules and tool descriptions
- **Session thresholds** — Idle timeout: 2min (was 30min), idle mark: 30s (was 10s), absolute timeout: 30min

### Tests

- **488 tests** passing, 0 failures

---

## [0.8.8] - 2026-04-24

### Fixed — Test Suite Performance & CI Timeout

Tests were timing out at 30 minutes on CI. Root cause: leaked `setTimeout(30 min)` in `virtual.ts` never cleared between tests, keeping the Node.js process alive.

- **Logger disabled in tests** — `disableLogger()` API + `tests/_setup.ts` global setup. Eliminates ~200+ sync disk writes per test to `~/.lemma/logs`.
- **30-min setTimeout leak fixed** — `resetSessionState()` added to `handlers.ts`, clears `activeSessionId` + finalizes virtual session (clears pending timer).
- **Session test cleanup** — All 4 session test files now call `resetSessionState()` in `afterEach` to prevent timer leaks.
- **`session-preload.test.ts` isolation** — Was missing `sessions.setSessionsDir()` and `guides.setGuidesDir()`, causing writes to real `~/.lemma/` directory.
- **`virtual.test.ts` assertion fix** — Test passed `null` result to `recordToolCall` but expected memory ID extraction via regex. Fixed with proper result fixture matching the `[m0-9a-f]+` ID format.
- **Test runner** — Switched from `tsx --test` to `node --import tsx --import ./tests/_setup.ts --test` for global logger suppression.
- **`tsconfig.tsbuildinfo` added to `.gitignore`**

**Result:** 481 tests: 30+ min → ~5 sec.

## [0.8.7] - 2026-04-24

### Added — Fragment Schema & Response Hooks

Comprehensive update to fix inconsistent fragment formats across LLMs and complete the bidirectional Memory↔Guide connection. Core principle: **LLM decides, code records. Code never guesses — it only applies deterministic actions.**

- **FragmentType** (`src/types.ts`) — Fragments now have type classification: `fact`, `pattern`, `lesson`, `warning`, `context`. Default: `fact`.
- **MemoryFragment.related_guides** — Tracks which guides a fragment informs (bidirectional link).
- **Guide.source_memories** — Records which memory IDs spawned a guide.
- **Guide.validated_by** — Records which memory IDs validated a guide during practice sessions.
- **`memory_add` type parameter** — Specify fragment type, e.g. `type: "pattern"`. Invalid values fall back to `fact`.
- **Fragment format template** — Structured markdown format added to `memory_add` tool description: `## [Title]\n[Context]\n- [Key points]`.

#### Deterministic Connections (4 mechanisms)

- **D-1: guide_distill bidirectional link** — On `guide_distill`, automatically: `guide.source_memories ← memory_id` and `memory.related_guides ← guide_name`.
- **D-2: guide_practice session validation** — On `guide_practice`, session-read memories auto-link to guide's `validated_by` and memory's `related_guides`.
- **D-3: trackAssociations activation** — On `memory_read` with multiple search results (>1), `associatedWith` cross-references are auto-created (was previously dead code).
- **D-4: memory_merge inheritance** — Merged fragments inherit `relations`, `related_guides`, and `associatedWith` from sources. All old ID references updated to new ID across memory and guides.

#### Response Hooks (10 tools)

Contextual `SUGGESTED ACTIONS` reminders added to tool responses. Each hook only appears when meaningful context exists:

| Hook | Tool | Condition | Suggestion |
|------|------|-----------|------------|
| H-1 | memory_add | Topic overlap exists | Call memory_relate |
| H-1 | memory_add | Session has read memories | Call memory_relate |
| H-1 | memory_add | Type is "pattern" or "lesson" | Call guide_distill |
| H-2 | memory_read | Multiple fragments returned | Call memory_relate |
| H-3 | memory_update | Fragment content changed | Call memory_relate to update |
| H-4 | memory_feedback | Positive feedback | Call guide_distill to promote to skill |
| H-4 | memory_feedback | Negative feedback | Call memory_update/forget/relate(contradicts) |
| H-5 | memory_merge | Always | Report inherited connections |
| H-6 | guide_practice | Session has read memories | Call guide_distill |
| H-6 | guide_practice | Success rate < 40% | Call guide_update to improve |
| H-7 | guide_create | Always | Call guide_practice + guide_distill |
| H-8 | guide_distill | Related memories exist on same topic | Additional guide_distill |
| H-9 | guide_merge | Always | Report inherited properties |
| H-10 | session_end | Session has activity | Full review: relate + distill + practice |

### Changed

- **System prompt** fully rewritten (`src/server/system-prompt.ts`):
  - `<identity>` — Clearer role definition, replaced "Lemma — Persistent Memory for LLMs" with contextual description
  - `<critical_rules>` — 4→6 rules, added anti-hallucination and memory reliability rules
  - `<fragment_types>` — New section: FragmentType table with usage examples
  - `<response_hooks>` — New section: SUGGESTED ACTIONS behavior guide
  - `<knowledge_to_skill_pipeline>` — Replaced old `<guide_tracking>` with bidirectional Memory↔Guide pipeline description
  - `<tool_focus_rule>` removed, content merged into `<critical_rules>` rule 6
- **Virtual session** (`src/sessions/virtual.ts`) — `memory_read` batch ids now records all IDs to `memories_accessed`; `memory_add` extracts fragment ID from response via regex and adds to `memories_created`
- **Seed fragments** (`src/memory/seed.ts`) — Added `type: "fact"` and `related_guides: []`

### Tests

- **+66 new tests** (11 files), total 481 tests, 0 failures
- `tests/memory/fragment-type.test.ts` (13) — FragmentType defaults, all types, save/load, boost/decay preservation, backward compatibility
- `tests/memory/track-associations.test.ts` (8) — Bidirectional links, empty/missing targets, dedup, multi-way associations
- `tests/server/memory-add-hook.test.ts` (7) — Overlap hook, type hook, session context hook, type validation
- `tests/server/memory-read-hook.test.ts` (4) — Multi-read hook, single-read (no hook), batch, associatedWith
- `tests/server/memory-update-hook.test.ts` (3) — Content change hook, title/confidence only (no hook)
- `tests/server/memory-feedback-hook.test.ts` (2) — Positive→distill, negative→update/forget
- `tests/server/memory-merge-inheritance.test.ts` (8) — Relation inheritance, guide inheritance, ID update, dedup
- `tests/server/guide-distill-bidirectional.test.ts` (6) — Bidirectional link, dedup, hook
- `tests/server/guide-practice-validation.test.ts` (4) — Session validation, low success rate warning
- `tests/server/guide-create-merge-hooks.test.ts` (5) — Create hook, update (no hook), merge hook
- `tests/server/session-end-review.test.ts` (6) — Session review, read+create suggestion, relate+distill suggestion

### Fixed

- **handlers-core.test.ts regression** — Updated `"Lemma — Persistent Memory"` assertion after system prompt rewrite

### Metrics

| Metric | Value |
|--------|-------|
| Modified source files | 8 |
| New test files | 11 |
| New tests | 66 |
| New type fields | 4 (FragmentType, .type, .related_guides, .source_memories, .validated_by) |
| Deterministic connections | 4 mechanisms |
| Response hooks | 10 tool responses |
| Dead code revived | trackAssociations |
| New external dependencies | 0 |

---

## [0.8.6] - 2026-04-23

### Added
- **Seed system** — Built-in knowledge fragments auto-populated on every startup for all users (new and existing).
  - `seed_task_complexity` — Simple vs complex task assessment with mandatory 3-phase process (Plan → Evaluate → Execute)
  - `seed_prompt_engineering` — System prompt structure (4-section template), anti-hallucination rules, parallel agent coordination, XML tag usage
  - `seed_clean_code_modern` — Agentic era clean code practices: SRP as context isolation, pragmatic DRY, type safety, AI-assisted development caveats
  - Seeds tagged with `lemma_seed`, never decay, auto-detect existing entries (idempotent)
  - New module: `src/memory/seed.ts` with `seedMemory()`, `getSeedCount()`, `getSeedIds()`

### Tests
- **415 tests** passing, 0 failures

---

## [0.8.5] - 2026-04-23

### Changed
- **Token budget increased** — Default `full_content` injection budget raised from 3000 to 5000 tokens, allowing more memories to be injected as full content into tool descriptions.

### Tests
- **415 tests** passing, 0 failures

---

## [0.8.4] - 2026-04-23

### Added
- **Comprehensive flow logging** — Every internal flow now logged step-by-step for full observability and debugging.
  - `logger.flow()` — Named flow steps (e.g. `[FLOW] [memory_injection] loaded_memory {count: 15}`)
  - `logger.request/response()` — MCP request/response lifecycle with timing
  - `logger.notify()` — Notification state tracking (debounced, sending, failed)
  - `logger.data()` — File I/O operations (load/save with counts)
  - `logger.inject()` — Context injection summaries (tokens, fragment counts)

### Changed
- **`src/server/handlers.ts`** — All 21 handlers instrumented with entry/decision/exit logging
- **`src/server/index.ts`** — `buildToolsWithMemory`, `buildDynamicInstructions`, initialize, resources, notification debounce fully logged
- **`src/server/hooks.ts`** — Hook trigger, prompt modifier lifecycle logged
- **`src/server/system-prompt.ts`** — Dynamic prompt build pipeline logged
- **`src/memory/core.ts`** — load, save, search, dedup, decay, boost, relation operations logged
- **`src/memory/config.ts`** — Config load logged
- **`src/guides/core.ts`** — load, save, practice, suggest, merge logged
- **`src/sessions/core.ts`** — load, save, create, end logged
- **`src/sessions/virtual.ts`** — record, finalize, timeout logged

### Tests
- **415 tests** passing, 0 failures (no test changes needed — logging is non-breaking)

---

## [0.8.3] - 2026-04-23

### Added
- **Logging system** — All MCP operations now logged to `~/.lemma/logs/` for debugging.
  - Daily log rotation: `lemma-YYYY-MM-DD.log`
  - Auto-cleanup: keeps last 7 log files
  - Tool calls logged with name, args (truncated), and duration (ms)
  - Errors and warnings logged with full context
  - Notification failures logged (was silently swallowed)
  - New module: `src/logger.ts` with `logger.info/warn/error/debug/toolCall`

### Changed
- **README** — Quick Start section moved to top, `npx -y lemma-mcp@latest` instead of `npx -y lemma-mcp` to ensure auto-updates
- **README** — Manual Installation now references `dist/index.js` (not `src/index.js`)
- **README** — opencode config path added
- `src/server/index.ts` — All `console.error` calls replaced with structured `logger` calls

### Tests
- **415 tests** passing, 0 failures

---

## [0.8.2] - 2026-04-23

### Fixed
- **Critical: MCP -32000 ConnectionClosed on write operations** — `memory_add`, `guide_practice` and other write tools were timing out or crashing MCP clients (Hermes, opencode).
  - **Root cause**: `notifyMemoryChange()` called `server.notification()` (async) without `await`, causing unhandled promise rejections that could crash the server process. Additionally, every write immediately sent 2 notifications, triggering expensive `tools/list` rebuilds on the client side.
  - **Debounce**: Notifications are now delayed 100ms and coalesced — multiple rapid writes produce a single notification instead of one per write.
  - **Error handling**: `.catch(() => {})` added to prevent unhandled rejections from killing the process.
- **`process.argv[1]` crash on module import** — Non-null assertion (`process.argv[1]!`) caused `TypeError: Cannot read properties of undefined` when the module was imported without a script argument. Fixed with explicit null check.

### Changed
- `src/server/index.ts` — `setNotifyChange` callback rewritten with `setTimeout` debounce + proper async error handling
- `src/server/index.ts` — `process.argv[1]!` replaced with safe null-checked variable

### Tests
- **415 tests** passing, 0 failures

---

## [0.8.1] - 2026-04-20

### Added — Active Memory Engine

Inspired by [LLM Wiki v2](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2) (@rohitg00). Six features transforming Lemma from a passive memory store into an active memory engine.

- **Privacy Filtering** — `memory_add` automatically scans for secrets (API keys, tokens, passwords, connection strings, private keys) and redacts them with `[REDACTED:type]` labels. Use `confirm: true` to store as-is.
  - 17 regex patterns: OpenAI keys, GitHub tokens, Slack tokens, AWS keys, MongoDB/PostgreSQL/MySQL/Redis connection strings, webhook secrets, Bearer tokens, private keys, password assignments
  - New file: `src/memory/privacy.ts` with `scanForSecrets()` and `redactSecrets()`
  - New param: `confirm` on `memory_add`

- **Query Filters** — `memory_read` now supports `minConfidence`, `afterDate`, and `beforeDate` parameters for structured querying.
  - "What did I learn last week?" → `afterDate="2026-04-13"`
  - "High-confidence memories only" → `minConfidence=0.7`
  - New function: `filterFragments()` in core

- **Smart session_start** — `session_start` now pre-loads top-3 relevant memories based on task_type + technologies, so the LLM sees relevant context immediately without calling `memory_read`.
  - Fragments are searched via `searchAndSortFragments(taskDesc, 3)` and included in response
  - Pre-loaded fragments get confidence boost (via `boostOnAccess`)

- **Topic Overlap Detection** — `memory_add` now detects topic-related (but not duplicate) fragments and suggests them in the response.
  - Uses Fuse.js with 40-65% similarity range (below dedup threshold)
  - New function: `findTopicOverlaps()` in core
  - Suggestions include fragment ID, title, and confidence
  - Prompts: "Does this update or contradict existing knowledge?"

- **Typed Relations** — New `memory_relate` tool creates typed links between fragments.
  - Relation types: `contradicts`, `supersedes`, `supports`, `related_to`
  - Bidirectional: reverse relation auto-created on target
  - New interface: `MemoryRelation` in types.ts
  - New field: `relations: MemoryRelation[]` on MemoryFragment
  - `formatMemoryDetail` shows relations
  - `memory_audit` detects orphan relations
  - Tool count: 20 → 21

- **Injection Ranking** — Memory injection now uses composite score instead of pure confidence.
  - Formula: `confidence * 0.7 + recency * 0.3` where recency decays over 180 days
  - Recent knowledge (2 days old, 0.72 confidence) now surfaces above old knowledge (6 months, 0.95)
  - Applied in all 3 sort paths of `searchAndSortFragments`

### Changed
- `src/types.ts` — Added `MemoryRelation` interface and `relations` field on `MemoryFragment`
- `src/memory/core.ts` — Added `filterFragments`, `findTopicOverlaps`, `addRelation`, `injectionScore`, updated `formatMemoryDetail`, `auditMemory`
- `src/memory/index.ts` — New exports: `scanForSecrets`, `redactSecrets`, `filterFragments`, `findTopicOverlaps`, `addRelation`
- `src/server/handlers.ts` — Updated `handleMemoryAdd` (privacy + overlap), `handleMemoryRead` (filters), `handleSessionStart` (pre-load), new `handleMemoryRelate`
- `src/server/tools.ts` — Updated tool definitions, added `memory_relate`

### Tests
- **415 tests** passing (+55 from 360), 0 failures
- New test files: `privacy.test.ts` (14), `filter.test.ts` (11), `session-preload.test.ts` (5), `topic-overlap.test.ts` (5), `relations.test.ts` (9), `injection-ranking.test.ts` (5)

### Documentation
- Added `docs/llm-wiki-v2.md` — LLM Wiki v2 reference document by @rohitg00

---

## [0.7.4] - 2026-04-19

### Fixed
- **Critical: Universal Memory Injection broken in MCP clients (Kilo Code, Cursor, Claude Desktop, etc.)** — Memory fragments were never injected into tool descriptions because clients cache `tools/list` on session start and never re-fetch.
  - Added `listChanged: true` to server capabilities so clients listen for tool change notifications
  - Server now sends `notifications/tools/list_changed` on every memory change (`memory_add`, `memory_update`, `memory_forget`, `memory_feedback`, `memory_merge`)
  - Clients re-fetch `tools/list` → `buildToolsWithMemory()` runs with updated memory → LLM sees current context
- **Global fragments injected twice** — `filterByProject(projectName)` already includes global fragments, but all 3 injection paths (`buildToolsWithMemory`, `buildDynamicInstructions`, `getDynamicSystemPrompt`) also called `filterByProject(null)` separately and concatenated results. Fixed to use a single filtered list.
- **Hardcoded injection limits ignoring config** — `buildToolsWithMemory` used hardcoded values (`maxFrags=10→15`, `remaining.slice(0,15)`, `getTopGuides(_,5)`) instead of reading from `config.injection.*`. Now respects `max_full_content_fragments`, `max_summary_fragments`, and `max_guides` from config.

### Changed
- `buildToolsWithMemory` and `buildDynamicInstructions` exported for testability
- `setDetectedProject()` helper added for testing
- Added 5 new tests verifying no duplicate fragment injection and config limit respect

---

## [0.7.2] - 2026-04-19

### Fixed
- **Critical: Confidence death spiral** — Decay was applied to ALL fragments every session start, including actively used ones. Average confidence dropped from 0.52 to 0.04 across 339 fragments. Rewritten with biological memory model:
  - **Shield**: Fragments with `accessed > 0` are completely protected from decay
  - **Slow decay**: Unused fragments decay at only -0.002 per session (was 0.005-0.05)
  - **Slow boost**: Access boost reduced to +0.015 (was +0.1) for gradual, lasting growth
  - **Slow penalty**: Negative feedback reduced to -0.02 (was -0.1)
  - **No time-based decay**: Confidence only changes when the system is actively used

### Added
- **`migrateConfidenceFloor()`** — One-time migration that boosts fragments below 0.3 to 0.3 floor on startup. Runs automatically on first launch after update.

### Changed
- **README (EN/TR)** — Learning System section updated with new rates and shield behavior
- **361 tests** — All passing with updated confidence rate assertions

---

## [0.7.0] - 2026-04-19

### Breaking Changes
- **TypeScript Migration** — Entire codebase migrated from JavaScript to TypeScript (strict mode)
  - All source files: `.js` → `.ts`
  - Shared type definitions in `src/types.ts` (15+ interfaces)
  - Full type annotations on all function parameters and return types
  - `noUncheckedIndexedAccess` and `noImplicitOverride` enabled

### Added
- **npm Package** — Published to [npmjs.com/package/lemma-mcp](https://www.npmjs.com/package/lemma-mcp)
  - Install: `npx lemma-mcp` or `npm install lemma-mcp`
  - SDK exports: `import { ... } from "lemma-mcp/memory"`
- **TypeScript Infrastructure**
  - `tsconfig.json` — strict mode, Node16 module resolution, ES2022 target
  - `tsconfig.test.json` — type checking for test files
  - Build: `tsc` compiles to `dist/` with declarations and source maps
  - Test runner: `tsx` (replaces `node --test` for .ts files)
- **Shared Types** (`src/types.ts`)
  - `MemoryFragment`, `Guide`, `Session`, `VirtualSession`
  - `MemoryStats`, `AuditResult`, `GuideSuggestion`, `SuggestResult`
  - `LemmaConfig`, `HookContext`, `PromptContext`
  - `TaskType`, `TaskOutcome` union types
- **`files` field** in package.json — Only `dist/`, `README.md`, `LICENSE` included in npm package
- **`prepare` script** — Auto-builds on `npm install` (for GitHub installs)

### Changed
- **Import paths** — Hook/PromptModifier examples now use `lemma-mcp/server` instead of `@lemma/lemma/server`
- **Quick Start** — Changed from `npx github:xenitV1/lemma` to `npx lemma-mcp` (npm package)
- **Manual Installation** — Entry point changed from `src/index.js` to `dist/index.js`
- **Test runner** — From `node --test *.test.js` to `tsx --test *.test.ts`
- **Project structure** — All `.js` → `.ts` in README

### Removed
- **`tsup`** as primary build tool — Replaced with `tsc` for proper module structure
- **`vitest`** dependency — Not used, tests use `node:test` via `tsx`

### Tests
- 360 tests passing (all converted to TypeScript)
- 25 test files, 0 failures
- `npm run typecheck` — Zero errors across src + tests

---

## [0.6.1] - 2026-04-19

### Added
- **GitHub Actions CI** — Automated test pipeline on push/PR to main, Node.js 18/20/22 matrix
- **Modular Test Suite** — Tests refactored from single file to 28 modular files across 4 directories
  - `tests/memory/` — core, lifecycle, persistence, audit, stats, config, edge-cases (7 files)
  - `tests/guides/` — core, suggest, merge, update, fuzzy-match, detail-format (6 files)
  - `tests/sessions/` — core, virtual (2 files)
  - `tests/server/` — handlers-core, guide-handlers, guide-advanced, memory-read-advanced, memory-update-advanced, memory-merge-validation, memory-stats-audit, session-handlers, session-guide-interaction, injection (10 files)
- **250 new tests** — Coverage expanded from 110 to 360 tests
  - Memory: applySessionDecay, detectProject, generateId, concurrent writes, malformed JSONL, large datasets (1000 fragments), backup integrity, empty/null protection
  - Guides: formatGuideDetail (anti_patterns, pitfalls, success rate), getGuidesByCategory, getTopGuides, outcome tracking, context deduplication
  - Handlers: memory_read batch ids, all=true, query search; memory_update fragment/confidence/type validation; memory_merge validation; guide_create similar update; guide_merge auto-merge; guide_practice session linking; session start/end lifecycle with guide interaction
  - Sessions: core CRUD, virtual session tracking, session-guide interaction, improvement suggestions

### Changed
- **Test runner** — Migrated from manual `node tests/test.js` to `node --test tests/**/*.test.js` glob pattern
- **Package scripts** — Added `test:memory`, `test:guides`, `test:sessions`, `test:server` for module-specific runs
- **Removed monolithic `tests/test.js`** — All tests distributed to modular files

### Tests
- 360 tests passing (was 110)
- 28 test files (was 1)
- ~80% estimated coverage (was ~55%)

---

## [0.6.0] - 2026-04-18

### Inspired by Karpathy's LLM Wiki
- **Lint concept** — `memory_audit` tool inspired by Karpathy's wiki health-check idea (contradictions, orphans, gaps)
- **Always-available knowledge** — Universal tool description injection ensures memories are in LLM context without explicit tool calls

### Added
- **Universal Memory Injection** — Memories are now injected into tool descriptions via `tools/list`, guaranteeing ALL MCP clients (opencode, Claude Desktop, Cursor, VS Code, Gemini CLI) see full memory content without requiring explicit tool calls.
  - Top N memories injected as full content into `memory_read` tool description (~4000 tokens budget)
  - Remaining memories shown as compact index
  - Top 5 guides shown with learnings
  - Dual injection: `instructions` field (for clients that support it) + tool descriptions (universal fallback)
- **Config System** (`~/.lemma/config.json`) — User-configurable token budgets and injection limits
  - `token_budget.full_content` (default: 3000)
  - `token_budget.summary_index` (default: 1000)
  - `token_budget.guides_detail` (default: 1000)
  - `injection.max_full_content_fragments` (default: 15)
  - `virtual_session.timeout_minutes` (default: 30)
- **Virtual Session Tracking** (`src/sessions/virtual.js`) — Automatic session correlation without requiring explicit `session_start`/`session_end`
  - Auto-starts on first tool call, auto-finalizes after 30 min inactivity
  - Tracks tool calls, technologies seen, guides used, memories created/accessed
  - Sessions persisted to `~/.lemma/sessions/` as JSON files
  - `session_stats` tool to view virtual session statistics
- **3-Layer Injection Architecture** — `buildDynamicInstructions` rewritten with:
  - Layer 1: Base rules (~500 tokens)
  - Layer 2: Full content for high-confidence memories (token-budgeted)
  - Layer 3: Summary index for remaining memories
  - Layer 4: Active guides with descriptions
- **MCP Resource Notifications** — `notifications/resources/updated` sent after every memory change
  - New `lemma://context/current` resource with dynamically generated context
  - Clients that support resource subscriptions get live updates
- **`session_stats` tool** — View virtual session activity, technologies, and guide usage

### Changed
- **`ListToolsRequestSchema` handler** — Now dynamically builds tool descriptions with injected memory context on every `tools/list` call
- **System prompt** — Added `<critical_rules>` section with mandatory behavior rules (always call `memory_read` first, always call `memory_add` after learning)
- **`buildDynamicInstructions`** — Removed redundant `decayConfidence` call (already applied at startup)

---

## [0.5.0] - 2026-04-18

### Breaking Changes
- **JSR support removed** — `jsr.json` deleted. Use `npx -y github:xenitV1/lemma` instead of `npx -y jsr @lemma/lemma`.

### Fixed
- **Critical: memory_read was destructive** — Decay was applied and saved on every `memory_read` call, causing confidence death spiral. Decay now only persists at session boundary (`initializeContext` on startup). Read operations no longer modify confidence.
- **Critical: Jaccard dedup was semantically broken** — "Use React hooks" vs "Don't use React hooks" scored 0.75 (blocked as duplicate). Replaced with Fuse.js fuzzy matching at threshold 0.65 for accurate similarity detection.
- **Critical: No concurrent write protection** — Added module-level write lock (`saveMemorySafe`) to prevent data loss from overlapping writes.
- **High: Double context injection** — Both `buildDynamicInstructions` and `getDynamicSystemPrompt` produced overlapping data with double decay. Resource handler now returns static `BASE_SYSTEM_PROMPT` only. Dynamic context via initialize `instructions` is the single source.
- **High: User memories bypassed dedup** — `source === "ai"` check meant user duplicates were never caught. Dedup now applies to all sources.
- **High: Guide dedup missing** — "react", "reactjs", "react.js" created 3 separate guides. Added `findSimilarGuide` with Fuse.js fuzzy matching.
- **High: ID collision risk** — 6 hex chars (16M space, 50% collision at ~4,800 IDs). Replaced with `crypto.randomUUID`-based 12 hex chars (281 trillion space).
- **Redundant decay in buildDynamicInstructions** — Was applying decay a second time after `applySessionDecay` already ran on startup. Removed.

### Added
- **`memory_stats` tool** — Fragment counts, average confidence, project breakdown, high/low confidence counts.
- **`memory_audit` tool** — Integrity check for orphan references, duplicate IDs, confidence anomalies, malformed entries.
- **Batch read support** — `memory_read` now accepts `ids: string[]` for fetching multiple fragment details in one call.
- **`outcome` parameter on `guide_practice`** — Track success/failure rate without requiring session_end.
- **`guide_update` expanded** — Now supports `add_anti_patterns`, `add_pitfalls`, `superseded_by`, `deprecated` fields.
- **`<critical_rules>` in system prompt** — Mandatory behavior rules forcing LLM to always call `memory_read` first and `memory_add` after learning.
- **File locking** — `writeLock`/`writeQueue` mechanism prevents overlapping writes within same process.

### Changed
- **System prompt slimmed** — From ~1,300 tokens to ~500 tokens. Removed philosophical framing ("Recursive Cognitive Engine", "Agentic Sovereignty"). Kept operational instructions.
- **Compact formatting** — Replaced box-drawing characters (╔═══╗║╚╝) with simple markdown headers. Removed 14-space alignment padding.
- **`guide_practice` returns compact response** — One-liner confirmation instead of echoing full guide detail.
- **`guide_merge` merges all array fields** — Now also merges `anti_patterns` and `known_pitfalls`, not just contexts/learnings.
- **Dead guide fields removed** — `feedback_patterns` and `improvement_log` were never populated by any tool. Removed from schema.
- **Session tracking** — Added `session_start`/`session_end` tools with guide suggestions, success rate tracking, and improvement detection.
- **Feedback counters** — Memory fragments now track `positive_feedback` and `negative_feedback` counts.

### Removed
- **JSR support** — `jsr.json` deleted. README updated to show GitHub npx as sole installation method.
- **`calculateSimilarity` (Jaccard)** — Replaced entirely by Fuse.js-based `findSimilarFragment`.

### Tests
- All 110 tests passing. Fixed broken assertions (`filterByProject` count, `findSimilarFragment` threshold, system prompt title).

---

## [0.4.1] - 2026-03-20

### Changed
- **Streamlined Initialize Response** — Cleaner context display on MCP initialization
  - Added `buildDynamicInstructions()` for focused project context
  - Project memories + global memories shown in compact tables
  - Guides now show only name and category (no usage_count, learnings)
  - Removed verbose resource listing from `ListResourcesRequestSchema`
  - Memories and guides accessed exclusively via tools, not resources

---

## [0.4.0] - 2026-03-20

### Added
- **Dynamic System Prompt Generation** — System prompt now automatically injects project and global memory context at runtime
  - `getDynamicSystemPrompt(projectName)` — Async function that builds contextualized prompts
  - Global context section: Shows cross-project learnings and preferences (up to 10 fragments)
  - Project context section: Shows project-specific fragments with confidence bars and source icons (up to 20 fragments)
  - Automatic confidence decay applied for accurate relevance display
  - `</system_prompt>` injection point for seamless context embedding

- **Hook System** (`src/server/hooks.js`) — Pluggable lifecycle event system
  - `HookTypes.ON_START` — Triggered when server starts
  - `HookTypes.ON_PROJECT_CHANGE` — Triggered when project context changes
  - `registerHook(type, callback)` — Register callbacks, returns unregister function
  - `triggerHook(type, context)` — Execute all registered callbacks for a hook

- **Prompt Modifier System** — Extend system prompt generation with custom transformations
  - `registerPromptModifier(modifier)` — Add async functions that transform prompts
  - `applyPromptModifiers(prompt, context)` — Apply all modifiers in sequence
  - Context object provides: `{ project, fragments, globalFragments }`

- **Visual Context Formatting** — Enhanced readability in injected contexts
  - Confidence bars: `███░░` visual representation (5 blocks, 0.2 increments)
  - Source icons: 🤖 (AI-generated) / 👤 (user-provided)
  - Summary mode: Title + description only (full content via `memory_read`)

### Changed
- **Server Index** — Now uses `getDynamicSystemPrompt()` for resource requests
- **Handlers Refactored** — Simplified tool/resource handling with hook integration
- **Tools Module** — Streamlined tool definitions and registration
- **Memory/Guides Core** — Minor improvements for context retrieval

### Tests
- **+269 lines** of new tests covering hook system, prompt modifiers, and dynamic context injection

---

## [0.3.2] - 2026-03-20

### Changed
- **Simplified decay formula** — Removed `time_multiplier` and `negativeHitMultiplier` from `decayConfidence()`. Decay is now a flat rate based only on access frequency: `max(0.005, 0.05 - accessed * 0.005)`. Negative feedback still reduces confidence directly via `memory_feedback` (-0.1), but no longer accelerates decay over time.

## [0.3.1] - 2026-03-19

### Fixed
- **Critical: Memory data loss in `memory_read`** — Accessing memory within a project scope was mistakenly overwriting the main file with only the filtered project fragments, deleting all global and other project data. Fixed by separating full and filtered memory arrays during the save process.

## [0.3.0] - 2026-03-19

### Added
- **Memory Learning System** — Fragments now gain confidence when actively used, not just decay slower
  - `boostOnAccess()`: +0.1 confidence per use (max 1.0), context tagging, access counter
  - `recordNegativeHit()`: -0.1 confidence when memory is unhelpful, negative hit counter
  - `trackAssociations()`: Bidirectional cross-references between co-accessed fragments
  - New fragment fields: `tags`, `associatedWith`, `negativeHits`
- **`memory_feedback` Tool** — Provide positive/negative feedback on memory fragments after use
- **`memory_read` context parameter** — Tag fragments with usage context (e.g., "debugging", "refactoring") for future recall
- **Test Suite** — 90 tests covering all modules (memory core, guides core, handlers, learning lifecycle) with full I/O isolation

### Changed
- **Decay now factors negative hits** — Fragments marked unhelpful decay faster via `negativeHitMultiplier`
- **Negative hits reset per session** — Like `accessed`, `negativeHits` resets after each decay cycle
- **`saveMemory` / `saveGuides` accept `force` option** — Allows intentional empty array saves (for deletion operations)
- **`formatMemoryDetail`** — Shows `tags` and `associatedWith` fields when present

### Fixed
- **`handleMemoryForget`** — Saving empty array after deleting last fragment now works (was silently blocked by safety check)
- **`handleGuideForget`** — Same fix for guides deletion

## [0.2.3] - 2026-03-19

### Fixed
- **Critical: Memory data loss from decay** — `decayConfidence()` was permanently removing fragments with confidence below 0.1 from disk. Decay now only reduces confidence scores; fragments are never removed implicitly. Deletion is exclusive to `memory_forget` and `memory_merge` (explicit user actions).
- **Critical: Backup overwrite on same-count save** — When new data had the same number of entries as the backup but different IDs, the backup was silently overwritten, losing unique entries. Backup is now cumulative (ID-based merge) — it only adds new entries and never removes existing ones.
- **Critical: Backup overwrite after count recovery** — After decay reduced entries and new additions brought the count back up, the backup was overwritten with data missing decayed entries. Cumulative backup prevents this entirely.
- **saveMemory(null/undefined/[]) protection** — Empty, null, or undefined arrays are now rejected before writing, preventing accidental file wipe.

### Changed
- **Backup system rewritten** — Both `memory.jsonl.bak` and `guides.jsonl.bak` now use cumulative merging instead of overwrite. The backup grows over time but never loses entries.
- **Test suite added** — Comprehensive memory test suite (110 tests) covering all tools, decay behavior, backup safety, and data loss scenarios.

## [0.2.2] - 2026-03-18

### Added
- **memory_merge Tool**: Merge multiple memory fragments into one to consolidate duplicates. Creates new ID, deletes originals.
- **guide_merge Tool**: Merge multiple guides into one. Auto-merges contexts, learnings, and sums usage counts.
- **Auto-backup**: Both `memory.jsonl` and `guides.jsonl` are automatically backed up to `.bak` on every save.

### Changed
- **System Prompt**: Rewritten identity section — clearer, explanatory, non-mandatory tone
- **System Prompt**: Expanded guide tracking section with detailed explanations (memory vs guide, categories, merge tools)
- **System Prompt**: Added "Discovering Technologies" recommendation for manual project analysis via `package.json`

### Removed
- **guide_discover Tool**: Removed in favor of manual discovery. System prompt now recommends reading `package.json` directly and using `guide_practice` to register technologies.

---

## [0.2.0] - 2026-03-15

### Breaking Changes
- **Skill → Guide Rename**: Complete terminology migration across the entire codebase
  - All tool names renamed: `skill_*` → `guide_*`
    - `skill_get` → `guide_get`
    - `skill_practice` → `guide_practice`
    - `skill_create` → `guide_create`
    - `skill_suggest` → `guide_suggest`
    - `skill_discover` → `guide_discover`
  - Directory renamed: `src/skills/` → `src/guides/`
  - Export path changed: `./skills` → `./guides`
  - URI pattern changed: `lemma://skills/` → `lemma://guides/`
  - Data file changed: `skills.jsonl` → `guides.jsonl`
  - ID prefix changed: `s1a2b3` → `g1a2b3`

### Migration Guide
- Rename your data file: `~/.lemma/skills.jsonl` → `~/.lemma/guides.jsonl`
- Update any MCP client configurations referencing skill tools
- Existing `SKILL.md` files remain compatible for import

---

## [0.1.4] - 2025-03-12

### Changed
- **MCP Resources Refactor**: Memory fragments and skills are now exposed as individual resources instead of bulk endpoints
  - `list_resources` returns each record with metadata (title, description, scope)
  - `read_resource` fetches only the requested single record
- **New URI Patterns**:
  - `lemma://memory/{id}` - Single memory fragment by ID
  - `lemma://skills/{name}` - Single skill by name
- This change reduces unnecessary token consumption when working with large datasets

## [0.1.3] - 2025-03-12

### Added
- **Skill Categories**: Granular and structured skill categories for better organization
  - Web: `web-frontend`, `web-backend`, `data-storage`, `dev-tool`
  - Mobile: `mobile-frontend`
  - Game: `game-frontend`, `game-backend`, `game-tool`, `game-design`
  - Cross-cutting: `app-security`, `ui-design`, `infra-devops`, `programming-language`
- **skill_distill Tool**: Promote memory fragments into reusable skills
- **skill_update Tool**: Update existing skill properties
- **skill_forget Tool**: Remove skills from tracking
- **System Prompt Resource**: LLM identity, workflow, and rules exposed via `lemma://system-prompt`
- **JSR Installation**: Added JSR configuration and installation guide

### Changed
- Core workflow redefined to integrate skill suggestion and practice
- Removed Smithery.ai distribution instructions
- Prioritized JSR as primary installation method

### Removed
- Legacy memory and skills core modules and their associated tests

## [0.1.2] - 2025-03-08

### Added
- **Fuzzy Search**: Skill suggestions now use Fuse.js for typo-tolerant, partial matching
- **Documentation**: Added research papers on Agentic Memory and Self-Distillation
- **Tests**: Inline Fuse.js mock for testing

## [0.1.1] - 2025-03-07

### Added
- **skill_create Tool**: Create new skills with detailed manuals
- **skill_suggest Tool**: Suggest relevant skills based on task description
- **Token-based Matching**: Improved skill suggestion across names, keywords, contexts, and learnings
- **Description Field**: Added `description` field to `skill_practice` for detailed skill management
- **Mandatory Fields**: Made `skill_practice` contexts and learnings mandatory

### Changed
- **System Prompt**: Restructured with XML tags, condensed and optimized
- **memory_add**: Changed project default from auto-detection to explicit global scope (null)

### Fixed
- Full skill details now provided on update

## [0.1.0] - 2025-03-05

### Added
- **Initial Release**: Lemma MCP memory system with project scoping
- **Memory Tools**:
  - `memory_read` - Read memory fragments with optional query
  - `memory_check` - Check if memory exists for a project
  - `memory_add` - Add new memory fragments
  - `memory_update` - Update existing fragments
  - `memory_forget` - Remove fragments
  - `memory_list` - List all fragments
- **Project Scoping**: Memory fragments can be scoped to specific projects or global
- **Confidence Decay**: Time-based confidence decay for memory relevance
- **lastAccessed Field**: Track when fragments were last accessed
- **MANDATORY Flags**: Tool descriptions include mandatory parameter flags
- **Zero-install Method**: Support for npx and GitHub installation
- **MIT License**
- **Turkish Translation**: Full README in Turkish

### Documentation
- Self-Distillation Enables Continual Learning research paper
- Tool descriptions and usage examples

---

[0.7.2]: https://github.com/xenitV1/lemma/compare/v0.7.1...v0.7.2
[0.7.0]: https://github.com/xenitV1/lemma/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/xenitV1/lemma/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/xenitV1/lemma/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/xenitV1/lemma/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/xenitV1/lemma/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/xenitV1/lemma/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/xenitV1/lemma/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/xenitV1/lemma/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/xenitV1/lemma/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/xenitV1/lemma/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/xenitV1/lemma/compare/v0.2.0...v0.2.2
[0.1.4]: https://github.com/xenitV1/lemma/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/xenitV1/lemma/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/xenitV1/lemma/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/xenitV1/lemma/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xenitV1/lemma/releases/tag/v0.1.0
