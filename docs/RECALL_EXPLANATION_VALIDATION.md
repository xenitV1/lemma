# Recall explanation validation — 2026-09-06

Added opt-in `explain: true` to `memory_read` and `semantic_search`. The explanation captures the current selection path, actual ranking values, recorded provenance and evidence-check status. Normal calls do not include it. Direct-ID reads do not invent historical selection reasons, and graph expansion exposes its root and depth.

## Final local results

| Check | Windows | Linux (WSL2) |
| --- | --- | --- |
| Typecheck and build | Passed | Passed |
| Full automated suite | 885 passed, 0 failed/skipped | 885 passed, 0 failed/skipped |
| Real stdio recall explanation acceptance | 16/16 passed | 16/16 passed |

The full suite covered 83 test files and 226 suites on each platform. Tests ran with isolated homes; acceptance scripts used only synthetic memories and source files. The Linux copy used the same application source/tests and lockfile as Windows, with native Linux dependencies.

The 14 new regression tests cover defaults, explicit/batch IDs, graph provenance, actual BM25/fallback/browse selection, scoped pagination, TF-IDF/hybrid scores, JSON parity, missing results, disabled verification, changed/unreadable evidence and the five-citation bound. They also verify that metadata is captured before normal access boosts, and that malformed historical dates do not create non-finite hybrid scores.

Real MCP acceptance covers tool-schema discovery, default behavior, source citations, current-call boundaries, keyword/semantic/hybrid scores, changed files, correction through `memory_update`, and reversible invalidation through `memory_forget`. Lifecycle reminders are emitted in separate MCP text blocks when JSON output is requested, preserving the first JSON block and `structuredContent` parity. The acceptance script exercises the reminder threshold that exposed this integration issue.

## Behavior boundaries

- This is a current-call explanation, not a replay of earlier automatic context injection or a proof that recalled claims are true.
- Citation checks run only with `verification.stale_check` enabled. At most five citations per record are inspected, and truncation is disclosed. Presence of a snippet is not semantic verification.
- Explanations do not apply corrections. Existing read access tracking still occurs normally.
- Hybrid retrieval now supplies the confidence/creation-date inputs required by its existing priority formula; missing inputs previously produced `NaN`. Invalid historical dates contribute zero priority instead of poisoning the result.
- macOS and the optional external GLM-agent test were not run locally. CI includes the full suite and real explanation smoke on Node 20/22, plus the existing three-platform backup matrix; remote success is not inferred from these local results.
- See [Linux backup validation](LINUX_BACKUP_VALIDATION.md) for the separately completed backup, schema-upgrade and cross-platform recovery checks.

Repeat the transport acceptance after building with `npm run test:mcp:explain`.
