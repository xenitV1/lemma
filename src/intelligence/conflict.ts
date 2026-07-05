import type { MemoryFragment } from "../types.js";
import type { ConflictPair } from "./types.js";
import { logger } from "../logger.js";

// Logical negation ONLY. Advisory/correction vocabulary (wrong|avoid|pitfall|
// mistake|error|deprecated|removed|...) is intentionally NOT treated as negation:
// warning/lesson fragments naturally contain those words, and treating them as
// negation misclassified advisories as contradicting neutral facts on the same
// topic. Genuine opposing pairs (good/bad, always/never, recommended/avoid) are
// still caught via CONTRADICTION_SIGNALS below.
const NEGATION_PATTERNS = [
  /\b(not|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|shouldn'?t|can'?t|cannot|never|no\s)\b/i,
  /\b(however|but|instead|rather|conversely|on the contrary|actually)\b/i,
];

const CONTRADICTION_SIGNALS = [
  { pattern_a: /\balways\b/i, pattern_b: /\bnever\b/i, weight: 0.9 },
  { pattern_a: /\bgood\b/i, pattern_b: /\bbad\b/i, weight: 0.7 },
  { pattern_a: /\bfast\b/i, pattern_b: /\bslow\b/i, weight: 0.6 },
  { pattern_a: /\bsimple\b/i, pattern_b: /\bcomplex\b/i, weight: 0.6 },
  { pattern_a: /\bbest\b/i, pattern_b: /\bworst\b/i, weight: 0.8 },
  { pattern_a: /\brecommended\b/i, pattern_b: /\bavoid\b/i, weight: 0.8 },
  { pattern_a: /\buse\b/i, pattern_b: /\bdon'?t use\b/i, weight: 0.9 },
  { pattern_a: /\bprefer\b/i, pattern_b: /\bavoid\b/i, weight: 0.8 },
];

function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some(p => p.test(text));
}

function extractTopicSignature(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "nor", "not", "only", "own",
    "same", "so", "than", "too", "very", "just", "because", "but", "and",
    "or", "if", "while", "about", "up", "it", "its", "this", "that",
    "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
    "him", "his", "she", "her", "they", "them", "their", "what", "which",
    "who", "whom", "am",
  ]);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  );
}

function topicOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const term of a) {
    if (b.has(term)) overlap++;
  }
  return overlap / Math.min(a.size, b.size);
}

// Single source of truth for the conflict severity model, shared by the
// incremental (detectConflict) and batch (scanForConflicts) paths so an
// identical fragment pair always scores identically. Previously the two paths
// carried divergent constants (skip <0.3 vs <0.4; negation 0.6+..*0.4 vs
// 0.5+..*0.5), so the same pair could be flagged with different severity — or
// flagged by one path and dropped by the other.
const CONFLICT_MIN_OVERLAP = 0.3;   // below this, not the same topic — skip
const CONFLICT_EMIT_THRESHOLD = 0.4; // below this, too weak to report

function scoreConflict(
  fragmentA: string,
  fragmentB: string,
  overlap: number,
  negationDiffers: boolean,
): number {
  let conflictScore = 0;
  if (negationDiffers && overlap >= 0.5) {
    conflictScore = 0.6 + (overlap - 0.5) * 0.4;
  }
  const signalScore = detectContradictionSignals(fragmentA, fragmentB);
  return Math.max(conflictScore, signalScore * overlap);
}

function detectContradictionSignals(textA: string, textB: string): number {
  let maxScore = 0;
  for (const signal of CONTRADICTION_SIGNALS) {
    const aHas = signal.pattern_a.test(textA) && signal.pattern_b.test(textB);
    const bHas = signal.pattern_b.test(textA) && signal.pattern_a.test(textB);
    if (aHas || bHas) {
      maxScore = Math.max(maxScore, signal.weight);
    }
  }
  return maxScore;
}

export function detectConflict(
  newFragment: MemoryFragment,
  existingFragments: MemoryFragment[],
  topN = 3
): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  const newTopic = extractTopicSignature(newFragment.fragment);
  const newHasNegation = hasNegation(newFragment.fragment);

  for (const existing of existingFragments) {
    if (existing.id === newFragment.id) continue;

    const overlap = topicOverlap(newTopic, extractTopicSignature(existing.fragment));
    if (overlap < CONFLICT_MIN_OVERLAP) continue;

    const existingHasNegation = hasNegation(existing.fragment);

    const conflictScore = scoreConflict(
      newFragment.fragment,
      existing.fragment,
      overlap,
      newHasNegation !== existingHasNegation,
    );

    if (conflictScore >= CONFLICT_EMIT_THRESHOLD) {
      conflicts.push({
        memory_a_id: newFragment.id,
        memory_a_title: newFragment.title,
        memory_b_id: existing.id,
        memory_b_title: existing.title,
        reason: newHasNegation !== existingHasNegation
          ? "Opposing sentiment on same topic"
          : "Contradiction signals detected",
        overlap_score: Math.round(conflictScore * 100) / 100,
      });
    }
  }

  conflicts.sort((a, b) => b.overlap_score - a.overlap_score);
  logger.flow("conflict", "detected", { new_id: newFragment.id, conflict_count: conflicts.length });
  return conflicts.slice(0, topN);
}

export function scanForConflicts(allFragments: MemoryFragment[]): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  const signatures = new Map<string, Set<string>>();
  const negationMap = new Map<string, boolean>();
  // Tier-1 gate: an inverted index (term → fragment indices) so we only run the
  // expensive overlap+signal check on pairs that share ≥1 topic term. Pairs
  // sharing zero terms have overlap 0 and are skipped anyway, so the candidate
  // gate changes cost, not results — just far fewer comparisons (SSR-Ada; C3).
  // Scoring itself now goes through the shared scoreConflict() so this batch path
  // and the incremental detectConflict() agree on every pair's severity.
  const inverted = new Map<string, number[]>();

  for (let i = 0; i < allFragments.length; i++) {
    const frag = allFragments[i];
    const sig = extractTopicSignature(frag.fragment);
    signatures.set(frag.id, sig);
    negationMap.set(frag.id, hasNegation(frag.fragment));
    for (const term of sig) {
      const list = inverted.get(term);
      if (list) list.push(i); else inverted.set(term, [i]);
    }
  }

  // Generate the candidate pair set (deduped) from co-occurrence in the index.
  const candidates = new Set<number>();
  const N = allFragments.length;
  for (const idxs of inverted.values()) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x], j = idxs[y];
        candidates.add(i < j ? i * N + j : j * N + i);
      }
    }
  }

  // Tier-2: the expensive contradiction check, on candidates only. Sort the
  // keys so pairs are visited in the same (i<j) order as the old scan, keeping
  // the output byte-identical for equal-score ties.
  const orderedKeys = [...candidates].sort((a, b) => a - b);
  for (const key of orderedKeys) {
    const i = Math.floor(key / N);
    const j = key % N;
    const a = allFragments[i];
    const b = allFragments[j];
    const overlap = topicOverlap(signatures.get(a.id)!, signatures.get(b.id)!);
    if (overlap < CONFLICT_MIN_OVERLAP) continue;

    const aNeg = negationMap.get(a.id)!;
    const bNeg = negationMap.get(b.id)!;

    const conflictScore = scoreConflict(a.fragment, b.fragment, overlap, aNeg !== bNeg);

    if (conflictScore >= CONFLICT_EMIT_THRESHOLD) {
      conflicts.push({
        memory_a_id: a.id,
        memory_a_title: a.title,
        memory_b_id: b.id,
        memory_b_title: b.title,
        reason: aNeg !== bNeg
          ? "Opposing sentiment on same topic"
          : "Contradiction signals detected",
        overlap_score: Math.round(conflictScore * 100) / 100,
      });
    }
  }

  conflicts.sort((a, b) => b.overlap_score - a.overlap_score);
  logger.flow("conflict", "full_scan", { fragment_count: allFragments.length, conflict_count: conflicts.length, candidate_pairs: candidates.size });
  return conflicts;
}

export interface ConflictResolution {
  winner_id: string;
  loser_id: string;
  winner_score: number;
  loser_score: number;
  rationale: string;
}

/**
 * Propose which of two conflicting fragments should win, via a survey-O3
 * heuristic: recency × confidence × support-count. This is advisory only — it
 * suggests a `supersedes` link and a small spot-decay for the loser; it never
 * deletes or auto-relates. The calling agent decides (roadmap B4, N4).
 */
export function resolveConflict(a: MemoryFragment, b: MemoryFragment): ConflictResolution {
  const score = (f: MemoryFragment): number => {
    const created = new Date(f.created).getTime();
    const days = Number.isNaN(created) ? 180 : (Date.now() - created) / 86400000;
    const recency = Math.max(0, 1 - days / 180);
    const support = (f.relations || []).filter(r => r.type === "supports").length;
    const supportScore = Math.min(support / 3, 1);
    return (f.confidence ?? 0.5) * 0.5 + recency * 0.3 + supportScore * 0.2;
  };
  const sa = Math.round(score(a) * 100) / 100;
  const sb = Math.round(score(b) * 100) / 100;
  const [winner, loser, ws, ls] = sa >= sb ? [a, b, sa, sb] : [b, a, sb, sa];
  return {
    winner_id: winner.id,
    loser_id: loser.id,
    winner_score: ws,
    loser_score: ls,
    rationale: `recency×confidence×support favors [${winner.id}] (${ws} vs ${ls})`,
  };
}

export function formatConflictResults(conflicts: ConflictPair[]): string {
  if (conflicts.length === 0) return "No conflicts detected.";

  let output = `=== CONFLICT DETECTION ===\nFound ${conflicts.length} potential conflict(s):\n\n`;
  for (const c of conflicts) {
    output += `  [${c.overlap_score}] [${c.memory_a_id}] "${c.memory_a_title}" vs [${c.memory_b_id}] "${c.memory_b_title}"\n`;
    output += `    Reason: ${c.reason}\n`;
  }
  output += `\nUse memory_relate with type "contradicts" to link these.`;
  return output;
}
