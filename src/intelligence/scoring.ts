import type { MemoryFragment } from "../types.js";

/**
 * Composite quality scoring for memory fragments (roadmap C2).
 *
 * The `quality_score` column has existed since schema v1 but was never
 * populated — this module finally computes it, purely from a fragment's own
 * counters (no LLM, no new state, no global rebuild). It blends trust
 * (confidence), corroboration (feedback), reuse (access), maturity
 * (refinement) and penalises decay (staleness) and rejection (negative hits).
 *
 * The score is only used to (a) fill the dormant column on the touch-points
 * where a fragment is already being written, and (b) surface a *specific*
 * refine suggestion for established-but-weak fragments. It never deletes or
 * down-weights data on its own.
 */

/** Below this composite quality, an established fragment earns a refine suggestion. */
export const QUALITY_SUGGESTION_THRESHOLD = 0.35;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Composite quality of a fragment in [0,1], derived entirely from existing
 * columns. The positive components sum to 1.0; a bounded negative-recall
 * penalty (≤0.35) is then subtracted. The penalty is deliberately strong:
 * Lemma's `confidence` decays only −0.02 per negative hit, so without it a
 * repeatedly-rejected fragment would keep a high confidence and never drop
 * below the suggestion threshold. A pristine, corroborated, frequently-reused
 * fragment approaches 1.0; a rejected or stale one approaches 0.
 */
export function calculateQualityScore(frag: MemoryFragment): number {
  const confidence = typeof frag.confidence === "number" ? frag.confidence : 0.5;

  const pos = frag.positive_feedback || 0;
  const neg = frag.negative_feedback || 0;
  const feedbackTotal = pos + neg;
  // Neutral 0.5 until there's feedback, so silence neither rewards nor punishes.
  const feedbackRatio = feedbackTotal > 0 ? pos / feedbackTotal : 0.5;

  const accessed = frag.accessed || 0;
  const usageScore = Math.min(accessed / 10, 1);

  const refinement = frag.refinement_count || 0;
  const refinementScore = Math.min(refinement / 3, 1);

  const lastAccessedMs = frag.lastAccessed ? new Date(frag.lastAccessed).getTime() : Date.now();
  const daysStale = Number.isNaN(lastAccessedMs) ? 0 : (Date.now() - lastAccessedMs) / 86400000;
  const stalenessScore = clamp01(daysStale / 180);

  const negHits = frag.negativeHits || 0;
  const negHitPenalty = Math.min(negHits / 4, 1);

  const score =
    0.40 * confidence +
    0.20 * feedbackRatio +
    0.15 * usageScore +
    0.10 * refinementScore +
    0.15 * (1 - stalenessScore) -
    0.35 * negHitPenalty;

  return Math.round(clamp01(score) * 1000) / 1000;
}

/**
 * The specific counters that make a fragment low-quality — empty means the
 * fragment has no track record worth judging yet (so a brand-new fragment is
 * never punished for silence). Callers cite these verbatim so the suggestion
 * names exact numbers (SSR / Self-Refine specificity), not a generic nudge.
 */
export function qualityScoreReasons(frag: MemoryFragment): string[] {
  const reasons: string[] = [];
  const pos = frag.positive_feedback || 0;
  const neg = frag.negative_feedback || 0;
  const negHits = frag.negativeHits || 0;
  const accessed = frag.accessed || 0;
  const confidence = typeof frag.confidence === "number" ? frag.confidence : 0.5;

  if (neg > pos) reasons.push(`${neg} negative vs ${pos} positive feedback`);
  if (negHits >= 2) reasons.push(`${negHits} negative recall hits`);
  if (accessed >= 3 && confidence < 0.4) {
    reasons.push(`accessed ${accessed}× but confidence still ${confidence.toFixed(2)}`);
  }

  const lastAccessedMs = frag.lastAccessed ? new Date(frag.lastAccessed).getTime() : Date.now();
  const daysStale = Number.isNaN(lastAccessedMs) ? 0 : (Date.now() - lastAccessedMs) / 86400000;
  if (daysStale > 120 && accessed >= 1) reasons.push(`untouched for ${Math.round(daysStale)} days`);

  return reasons;
}

/**
 * True when a fragment is both low-scoring AND has an established track record
 * — the gate for emitting a refine suggestion.
 */
export function isLowQuality(frag: MemoryFragment): boolean {
  return (
    qualityScoreReasons(frag).length > 0 &&
    calculateQualityScore(frag) < QUALITY_SUGGESTION_THRESHOLD
  );
}
