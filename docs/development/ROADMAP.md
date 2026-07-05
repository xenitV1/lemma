# Lemma Development Roadmap

> Research-grounded roadmap derived from a first-hand reading of the full
> `docs/research/` corpus mapped against the **actual shipped code**. Replaces the
> earlier roadmap (removed: it claimed an embeddings layer that was never built).
> Every item cites its source paper and carries a **compatibility risk** tag,
> because Lemma has 1000+ live installs — nothing here may break an existing DB,
> tool contract, or client integration.

## Vision & hard constraints

Be the AI's brain: **offline-first · minimal runtime deps** (`@modelcontextprotocol/sdk` + `better-sqlite3` only) · **LLM-free core** (the server never calls an LLM; the calling agent is the only model, driving everything through MCP tools) · **single SQLite** (`~/.lemma/lemma.db`) · **backward compatible** · **cross-platform incl. Windows**. New capability is added as a **parameter on an existing tool** first; a new tool only when a genuinely new interaction is required.

Research reinforces the frugal design: the Agent-Native Memory survey (arXiv:2606.24775) finds multi-engine (vector+graph+SQL) stores pay **orders-of-magnitude latency for marginal accuracy (O5)**, and every extraction/summarization layer **discards information (O6)** — so single-SQLite + verbatim `memory_add` is empirically the right call, not a compromise.

---

## Compatibility & safety contract (non-negotiable — 1000+ installs)

Every roadmap item MUST satisfy all of these, or it does not ship:

1. **Additive schema only.** New tables/columns via a new `MIGRATIONS` entry, gated by `schema_version`. Never drop/rename/retype an existing column. Migrations must be idempotent (safe to re-run) and forward-only.
2. **No destructive data ops by default.** Consolidation/eviction/decay must archive or down-weight, never hard-delete user data unless the user explicitly calls `memory_forget`. (Directly supported by SDFT on-policy retention + survey O4.)
3. **Tool contract is frozen.** The 26 tool names, their existing parameters, and their `outputSchema`/`structuredContent` shapes stay stable. New capability = a new **optional** parameter that defaults to today's behavior. A new tool only as a last resort.
4. **Behavior changes are opt-out-safe.** Any change to ranking/injection/decay must degrade gracefully on old data and be reversible via `~/.lemma/config.json`. Prefer a config key with today's behavior as an explicit fallback.
5. **Migrations are one-way-safe but data-preserving.** A user who upgrades then downgrades must not lose fragments (older code simply ignores new tables/columns).
6. **Test-gated.** Each item ships with tests, keeps the full suite green (currently 738), and adds a migration test proving an old DB opens clean.
7. **Injected-text format is LLM-facing, not an API.** The `memory_read` blob / SKILL.md wording may evolve; but never assume a client parses it — so these changes are low-risk by construction.

Risk tags used below: **[compat: none]** additive/opt-in · **[compat: behavior]** changes output the LLM sees (not an API break) · **[compat: migration]** touches schema, needs a gated migration + downgrade check.

---

## Current implementation reality (verified from source)

**Built & working:** SQLite memories + FTS5/BM25; confidence dynamics (`boostOnAccess` +0.015 / `recordNegativeHit` −0.02 / passive decay −0.002·day, 24h-gated / 0.3 floor); TF-IDF cosine `semantic_search`; relations with auto-reverse trigger; heuristic conflict detection (report-only); rich proactive suggestions; guides with usage/success/failure/learnings; virtual sessions auto-capturing tool traces.

**Designed but never wired (archaeology gap — see `self-improvement-architecture.md`):** `quality_score` column exists but is never populated; the `sessions`/`session_attempts` SQL tables exist but `finalizeVirtualSession()` writes **flat JSON** instead; three designed tools (`self_critique`, `guide_refine`, `memory_summarize`) were never built; Design Principle #7 "self-consistency as confidence" never implemented.

---

## Net-new findings from a full first-hand reading of the corpus

Cheap, LLM-free, vision-fit refinements the earlier extraction under-emphasized:

- **N1 — Ebbinghaus decay, not linear.** `llm-wiki-v2` prescribes an *exponential* retention curve that **resets on each reinforcement**, with type-dependent rates ("architecture decisions decay slowly, transient bugs fast"). Lemma's decay is a flat −0.002/day, type-blind. Fix: exponential decay off `last_accessed_at` (access truly resets) + per-type half-lives.
- **N2 — Episodic tier is the missing layer.** Consolidation tiers = working → **episodic** → semantic → procedural. Lemma has semantic (memories) + procedural (guides) but no episodic layer — exactly what C1 builds.
- **N3 — Crystallization.** A finished session should distill into a digest AND spin off its lessons as standalone `lesson` fragments. Lemma's `session_end` nudges a single summary today.
- **N4 — Contradiction *resolution*, not just detection.** After a conflict, propose which claim wins by recency × confidence × support-count (survey O3).
- **N5 — Do NOT auto-refine.** EVOLVE proves LLMs have no inherent self-refinement and *degrade* when naively refining; Self-Refine shows feedback quality is the bottleneck. Hard rule: Lemma surfaces structured history/suggestions; the calling agent decides. Never add an autonomous background refine loop.
- **N6 — Guides must carry preconditions.** Intrinsic Self-Critique works only when the critique embeds domain definition + preconditions — that belongs in guide `learnings`/`anti_patterns`.

### Addenda from the full paper (arXiv:2606.24775v1 HTML) + benchmark repo (OpenDataBox/MemoryData)

A cross-check against the complete paper and its evaluation suite surfaced concrete mechanisms the markdown summary omitted:

- **N7 — Sequential-Hybrid retrieval (cheap prefilter first).** The paper names two hybrid styles; the cheaper one applies **strict SQL predicate filters (date/project/type) BEFORE** the expensive semantic step. Fold into **A4**: run a `WHERE project/type/date` prefilter, then TF-IDF/BM25 rank, then RRF — far cheaper than embedding everything. Pure SQLite.
- **N8 — Use MMR for the diversity rerank.** A2 shipped as a homegrown token-overlap filter; the standard is **Maximal Marginal Relevance** `score = λ·rel − (1−λ)·max_sim_to_selected`. Upgrade A2 to real MMR (λ≈0.7) — same cost, principled.
- **N9 — Logical invalidation, not a second table.** Temporal-KG systems resolve conflicts via a **validity flag + ISO-8601 chronological precedence** (logical invalidation, never physical delete) + hash-based dedup. Lightweight alternative/complement to B2's history table: a nullable `invalidated_at` column so a superseded fact is hidden from recall but preserved. Feeds B2 + B4.
- **N10 — Named consolidation variants (MemoryOS).** **Conservative-Merge** = require a *higher* topic-similarity threshold before assimilating (fewer, safer merges). **Delayed-Flush** = an enlarged short-term buffer before backend writes (= the working-memory tier). Sharpens B3 and the working buffer.
- **N11 — Localized maintenance is a hard cost cliff (O7).** Concrete latencies: LightMem 48.3 utility @ **3.67 s/query**, MemoryOS 82.0 @ **28.6 s**, Cognee 84+ only after **116.5 s**, Zep **155.1 s**. Whole-memory reorganization dominates cost. **Rule for 1000+ installs: every maintenance op (eviction, decay, consolidation, conflict scan) must be localized/incremental — never a global rebuild.** Directly governs B1/B3/C3.
- **N12 — Evidence-distance-aware ranking.** Retrieval quality tracks how evidence is organized for reconstruction, not top-1 rank; recent vs distant facts warrant different handling. Extends D1's recent/established split into ranking, not just display.
- **Eval harness (tooling, optional).** MemoryData tests four capability families — **Accurate Retrieval · Conflict Resolution · Test-Time Learning · Multi-session**. Its own harness needs LLM+embeddings+Python (out of Lemma's core), but the *task taxonomy* is a blueprint for a tiny LLM-free retrieval-quality self-test: "does `memory_read`/`semantic_search` surface the known-relevant fragment for a query?" Worth a `tests/eval/` fixture, not a runtime dep.

---

## Research → principle → gap map

| Principle (source) | Lemma today | Item |
|---|---|---|
| Composite recall = confidence × recency (llm-wiki-v2; survey O2) | ✅ fixed (A1) | done |
| Injection-time redundancy FILTER (AgeMem) | ✅ diversity de-dup (A2) | done |
| Salient, structured injected context (prompt-engineering; XML bias) | ✅ tags + labels + recent/established (D1) | done |
| Exponential type-aware forgetting (llm-wiki-v2) | ⚠️ flat, type-blind | B5 |
| Append-only → "hallucinations of the past" (survey O3/O4) | ⚠️ mostly append-only | B4, B2 |
| Conservative consolidation, keep chronology (survey O4/O6; SDFT) | ⚠️ merge/forget hard-delete | B3 |
| Score-based "Heat" eviction (survey 2.4) | ❌ unbounded growth | B1 |
| Multi-stage hybrid retrieval (survey 2.3) | ⚠️ BM25 + TF-IDF separate | A4 |
| Topological subgraph traversal (survey 2.3) | ⚠️ manual single-hop | A3 |
| Episodic tier / raw-trace preservation (llm-wiki-v2; survey O6) | ⚠️ traces in flat JSON | C1 |
| Refine the weakest unit (SSR); specific > generic feedback (Self-Refine) | ❌ wholesale; nudges generic | C2, D2 |
| Self-consistency as free confidence (survey; Self-Critique; SSR) | ❌ | C4 |

---

## Phased roadmap

### v0.18.3 — Wave 1: injection quality (SHIPPED)
- **A1** injectionScore consistency · **A2** diversity de-dup · **D1** XML tags + confidence labels + recent/established. Plus the Codex fix (imperative SKILL.md description + `memory_read` "START HERE"). **[compat: behavior]** — only the LLM-facing text/order changed; 738 tests green.

### v0.19 — Wave 2: lifecycle robustness & self-improvement loop (SHIPPED)
Small, additive, high value. All seven items shipped in v0.19.0 — 762 tests green + real-MCP + real-LLM (GLM-5.1) end-to-end. No schema migration; the two new capabilities are optional params on existing tools.
- **B3 ✅** Non-destructive consolidation — `memory_merge`/`memory_forget` gained an optional `consolidate` param that supersedes + down-weights (reversible) instead of hard-deleting (SDFT; survey O4). **[compat: behavior]** — default path unchanged. *(Conservative-Merge N10 threshold deferred — the current path lets the agent decide which fragments to consolidate.)*
- **B4 ✅** `resolveConflict` win-heuristic (recency × confidence × support, N4) on high-confidence `memory_add` conflicts → `supersedes` *suggestion* + −0.1 spot-decay to the loser. Advisory only. **[compat: none]** *(Logical `invalidated_at` N9 deferred to Wave 3 B2, as the roadmap intends.)*
- **B5 ✅** Ebbinghaus + type-aware decay (N1) behind `decay.model` config key, defaulting to today's linear; per-type half-lives in `decay.half_life_days`. **[compat: behavior — default unchanged]**
- **C2 ✅** Revived the dead `quality_score` as `f(confidence, feedback, usage, freshness, refinement) − negHitPenalty`; below-threshold established fragments → refine suggestion citing exact counters (SSR; Self-Refine specificity), surfaced via `proactive_analysis`/`memory_library`. Populated incrementally on touch-points. **[compat: none]**
- **C3 ✅** Two-tier gated `scanForConflicts`: inverted-term-index candidate generation → expensive check on co-occurring pairs only (SSR-Ada). Byte-identical output. **[compat: none]**
- **D2/D3 ✅** `memory_add` "worth saving?" quality gate + habituation; filled `TOOL_NUDGES` gaps (incl. the reversible `consolidate` option on merge/forget). **[compat: behavior]**

### v0.20 — Wave 3: structural (schema-additive) (SHIPPED)
All seven items shipped in v0.20.0 — 823 tests green + build + real-MCP smoke. Migrations V5–V8 are additive, gated, idempotent, and downgrade-safe; the 26-tool contract is unchanged (new capability = optional params on existing tools).
- **C1 ✅** **The episodic tier (N2).** `autoEndSession` now persists the full virtual session to the SQL `sessions` table — technologies, `session_memory_links` (read/created), `session_guide_usage`, and an N3 crystallized one-line digest on `sessions.lessons` — instead of the near-empty stub. Flat JSON still written (downgrade-safe). Immediate payoff: `project_analytics` and C4 now have real usage data. **[compat: behavior]** — no schema change.
- **B1 ✅** Capacity-driven "Heat" eviction to the additive `fragments_archive` table (V6). Off by default (`eviction.enabled`); over `eviction.max_fragments`, the coldest fragments (injectionScore Heat) are moved to the archive — never hard-deleted — and are restorable. Localized (O7). **[compat: migration]**
- **B2 ✅** `fragment_history` versioning via an `AFTER UPDATE` trigger (content-change only) + logical `invalidated_at` flag (N9) so superseded facts are hidden from recall but preserved (V5). Recall excludes invalidated by default; `memory_forget invalidate=true` is the reversible entry point. **[compat: migration]**
- **A3 ✅** Bounded-depth graph traversal over `relations` (BFS depth ≤ 2, fan-out ≤ 5 strongest-first, `0.6^depth` penalty) as `memory_read expand_graph:true`. **[compat: none]**
- **B6 ✅** Code-evidence + snippet staleness (V7, from [community PR #1](https://github.com/xenitV1/lemma/pull/1)). Optional `evidence` field on `memory_add` (file + symbol + snippet, stored with a SHA-256); an opt-in recall check (`verification.stale_check`, default off) re-verifies the snippet in the file and flags drift — advisory, never hard-deleted. LLM-free, pure-SQLite, Windows-safe. Embeddings deliberately excluded. **[compat: migration]**
- **A4 ✅** Hybrid retrieval — SQL predicate prefilter (N7) → RRF of BM25 + TF-IDF (`Σ 1/(60+rank)`) → injectionScore rerank → MMR (N8, λ=0.7) — opt-in via `semantic_search hybrid:true`. Additive `tfidf_cache` table (V8) persists per-fragment TF maps by content hash to kill the O(N)-rebuild-per-query cost; falls back to live compute. **[compat: migration]**
- **C4 ✅** Self-consistency-as-confidence from historical outcome divergence (`src/intelligence/consistency.ts`; Design Principle #7) — advisory flags via `proactive_analysis`. Arithmetic over existing tables; feeds off C1's now-populated `session_memory_links`. **[compat: none]**

### Framing note — new tools vs parameters
The three designed-but-unbuilt tools should NOT necessarily become new tools (grow tools only on new interaction). Prefer folding them in: `memory_summarize` → a `consolidate:true` mode on `memory_merge` (B3); `guide_refine` → strengthen proactive suggestions + `guide_update` (C2), no new tool; `self_critique` → advisory-only and overlaps `session_attempt`, keep as a candidate, not a commitment.

---

## Explicitly rejected (hard vision conflicts)

- **Real embeddings / vector DB** (AgeMem RETRIEVE; dense retrieval) — ~470 MB model + native ONNX breaks minimal-deps + Windows; survey **O5 cost-cliff** rejects multi-engine anyway. TF-IDF/BM25 stays.
- **RL-trained memory policy + GRPO** (AgeMem) — GPU/fine-tuning/LLM-judge. Out of scope.
- **Metacognitive self-modification** (HyperAgents/DGM) — always-on LLM + code sandbox; that is the calling agent's job.
- **LLM abstractive SUMMARY / self-distillation / GSR synthesis / EVOLVE training** — all need a generative/always-on LLM or a training loop. Only weak extractive analogs exist and must never be presented as equivalent (N5).

---

## Release discipline

Follow the existing convention: minor bump per feature wave (v0.19, v0.20), patch bump per fix. Each release: full test suite green + a migration test opening a pre-upgrade DB + CHANGELOG entry noting any behavior change and its config fallback.
