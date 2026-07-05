import type { LemmaDB } from "../db/database.js";
import type { ProactiveSuggestion } from "./types.js";
import { logger } from "../logger.js";

/**
 * C4 — self-consistency as confidence (Design Principle #7).
 *
 * A fragment's confidence should reflect how the tasks that USED it actually
 * turned out. If every session that read a fragment succeeded, that's
 * corroboration; if outcomes diverge (sometimes success, sometimes failure),
 * the fragment is unreliable and warrants review. This is pure arithmetic over
 * the existing sessions + session_memory_links tables — no LLM, no schema, and
 * advisory only (it never mutates confidence; N5: surface, the agent decides).
 */

const OUTCOME_SCORE: Record<string, number> = {
  success: 1,
  partial: 0.5,
  failure: 0,
  abandoned: 0,
};

export type ConsistencyVerdict = "corroborated" | "divergent" | "unreliable" | "insufficient";

export interface ConsistencyResult {
  total: number;
  successRate: number;
  /** Agreement among outcomes in [0,1]: 1 = unanimous, 0 = maximally split. */
  agreement: number;
  verdict: ConsistencyVerdict;
}

/** Pure scorer over a fragment's historical session outcomes. */
export function computeSelfConsistency(outcomes: string[]): ConsistencyResult {
  const scores = outcomes
    .map(o => OUTCOME_SCORE[o])
    .filter((s): s is number => s !== undefined);
  const total = scores.length;

  if (total < 3) {
    return { total, successRate: total ? scores.reduce((a, b) => a + b, 0) / total : 0, agreement: 1, verdict: "insufficient" };
  }

  const successRate = scores.reduce((a, b) => a + b, 0) / total;
  // Variance peaks at 0.25 for a 50/50 split; normalize to an agreement score.
  const variance = scores.reduce((a, s) => a + (s - successRate) ** 2, 0) / total;
  const agreement = Math.max(0, 1 - variance / 0.25);

  let verdict: ConsistencyVerdict;
  if (successRate >= 0.7 && agreement >= 0.6) verdict = "corroborated";
  else if (successRate <= 0.34) verdict = "unreliable";
  else if (agreement < 0.5) verdict = "divergent";
  else verdict = "insufficient";

  return { total, successRate, agreement, verdict };
}

/**
 * One batched query → per-fragment consistency for every fragment that has been
 * used in at least one outcome-bearing session. Localized/incremental (survey
 * O7): a single GROUP-friendly scan, never a whole-memory rebuild.
 */
export function scanOutcomeConsistency(lemmaDb: LemmaDB): Map<string, ConsistencyResult> {
  const out = new Map<string, ConsistencyResult>();
  try {
    const rows = lemmaDb.prepareCached(
      `SELECT m.legacy_id AS id, s.outcome AS outcome
       FROM session_memory_links sml
       JOIN sessions s ON s.id = sml.session_id
       JOIN memories m ON m.id = sml.memory_id
       WHERE s.outcome IS NOT NULL`,
    ).all() as { id: string; outcome: string }[];

    const byId = new Map<string, string[]>();
    for (const r of rows) {
      const list = byId.get(r.id) ?? [];
      list.push(r.outcome);
      byId.set(r.id, list);
    }
    for (const [id, outcomes] of byId) {
      out.set(id, computeSelfConsistency(outcomes));
    }
  } catch (err) {
    logger.warn("scanOutcomeConsistency failed", { error: String(err) });
  }
  return out;
}

/**
 * Advisory suggestions from outcome divergence, surfaced by proactive_analysis.
 * Divergent/unreliable fragments are flagged for review; strongly corroborated
 * ones get an informational boost hint. Never auto-applied.
 */
export function outcomeConsistencySuggestions(
  lemmaDb: LemmaDB,
  titleOf: (legacyId: string) => string | null,
  limit = 5,
): ProactiveSuggestion[] {
  const results = scanOutcomeConsistency(lemmaDb);
  const flagged: ProactiveSuggestion[] = [];
  const corroborated: string[] = [];

  for (const [id, r] of results) {
    const title = titleOf(id) ?? id;
    if (r.verdict === "unreliable") {
      flagged.push({
        type: "refine",
        priority: "high",
        message: `Fragment "${title}" [${id}] was used in ${r.total} sessions with a ${(r.successRate * 100).toFixed(0)}% success rate — outcomes suggest it is unreliable. Verify or down-weight it.`,
        suggested_action: `memory_read id="${id}" then memory_feedback useful=false or memory_update to correct it`,
      });
    } else if (r.verdict === "divergent") {
      flagged.push({
        type: "refine",
        priority: "medium",
        message: `Fragment "${title}" [${id}] has divergent outcomes across ${r.total} sessions (agreement ${(r.agreement * 100).toFixed(0)}%) — it works only sometimes. Consider splitting it by context or adding preconditions.`,
        suggested_action: `memory_read id="${id}" to review`,
      });
    } else if (r.verdict === "corroborated" && r.total >= 4) {
      corroborated.push(id);
    }
  }

  flagged.sort((a, b) => (a.priority === "high" ? -1 : 1) - (b.priority === "high" ? -1 : 1));
  const limited = flagged.slice(0, limit);

  if (corroborated.length > 0) {
    limited.push({
      type: "refine",
      priority: "low",
      message: `${corroborated.length} fragment(s) are strongly corroborated by consistent session success (${corroborated.slice(0, 3).join(", ")}). Their confidence is well-earned.`,
    });
  }

  return limited;
}
