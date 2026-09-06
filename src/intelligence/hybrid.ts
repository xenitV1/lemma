import type { LemmaDB } from "../db/database.js";
import type { MemoryFragment } from "../types.js";
import { findSemanticSimilar, cosineSimilarity } from "./semantic.js";
import { buildVectorsCached } from "./vector-cache.js";
import type { TfidfVector } from "./types.js";
import * as store from "../db/memory-store.js";
import { injectionScore } from "../memory/core.js";
import { logger } from "../logger.js";

/**
 * A4 — hybrid retrieval. Cheap SQL predicate prefilter (project/type/date; N7),
 * then fuse two rankers — BM25 (FTS) and TF-IDF cosine — with Reciprocal Rank
 * Fusion, rerank by injectionScore, and diversify with MMR (N8). Pure SQLite +
 * arithmetic, no embeddings.
 */

/** Reciprocal Rank Fusion: Σ 1/(k + rank) across ranked id lists. */
export function reciprocalRankFusion(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}

/**
 * Maximal Marginal Relevance rerank: greedily pick the item maximizing
 * `λ·relevance − (1−λ)·max_similarity_to_already_selected`. λ≈0.7 favors
 * relevance while suppressing near-duplicates.
 */
export function mmrRerank(
  candidates: Array<{ id: string; relevance: number }>,
  similarity: (a: string, b: string) => number,
  lambda = 0.7,
  topK = candidates.length,
): string[] {
  const selected: string[] = [];
  const pool = [...candidates];
  while (selected.length < topK && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const maxSim = selected.length ? Math.max(...selected.map(s => similarity(c.id, s))) : 0;
      const mmr = lambda * c.relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(pool[bestIdx].id);
    pool.splice(bestIdx, 1);
  }
  return selected;
}

export interface HybridOptions {
  project?: string | null;
  type?: MemoryFragment["type"];
  afterDate?: string;
  beforeDate?: string;
  topK?: number;
  /** MMR diversity strength in [0,1]; 1 = pure relevance, lower = more diverse. */
  lambda?: number;
  /** Candidate pool size drawn from each ranker before fusion. */
  poolSize?: number;
  /** Return actual rank-fusion inputs for opt-in recall explanations. */
  explain?: boolean;
}

export interface HybridResult {
  memory_id: string;
  score: number;
  components?: { lexical_rank: number | null; semantic_rank: number | null; fusion_score: number; priority_contribution: number };
}

/**
 * Run the hybrid pipeline and return fused, diversified results. Prefilter →
 * BM25 + TF-IDF → RRF → injectionScore rerank → MMR.
 */
export function hybridSearch(db: LemmaDB, query: string, options: HybridOptions = {}): HybridResult[] {
  const topK = options.topK ?? 10;
  const poolSize = options.poolSize ?? 50;
  const lambda = options.lambda ?? 0.7;

  // N7 — cheap SQL predicate prefilter (project/type/date) applied by BM25 search.
  const bm25 = store.searchMemories(db, query, {
    project: options.project ?? undefined,
    type: options.type,
    afterDate: options.afterDate,
    beforeDate: options.beforeDate,
    topK: poolSize,
  });
  const bm25Order = bm25.map(f => f.id);

  // TF-IDF over the same scope (its own prefilter clause).
  const scopeRows = db.prepareCached(
    options.project
      ? `SELECT legacy_id, title, fragment, description, confidence, created_at FROM memories WHERE (lower(project) = ? OR project IS NULL) AND invalidated_at IS NULL`
      : `SELECT legacy_id, title, fragment, description, confidence, created_at FROM memories WHERE invalidated_at IS NULL`,
  ).all(...(options.project ? [options.project.toLowerCase()] : [])) as {
    legacy_id: string; title: string; fragment: string; description: string | null; confidence: number; created_at: string;
  }[];

  const fragments = scopeRows.map(r => ({ id: r.legacy_id, title: r.title, fragment: r.fragment, description: r.description ?? "", confidence: r.confidence, created: r.created_at } as MemoryFragment));
  const vectors = fragments.length > 0 ? buildVectorsCached(db, fragments) : [];
  const vectorById = new Map<string, TfidfVector>(vectors.map(v => [v.memory_id, v]));
  const tfidf = query.trim() ? findSemanticSimilar(query, vectors, poolSize, -Infinity) : [];
  const tfidfOrder = tfidf.map(r => r.memory_id);

  // RRF fuse both rankings.
  const rrf = reciprocalRankFusion([bm25Order, tfidfOrder]);
  if (rrf.size === 0) {
    logger.flow("hybrid", "empty", { query_length: query.length });
    return [];
  }

  // injectionScore rerank: blend fusion rank with recall priority.
  const fragById = new Map<string, MemoryFragment>(fragments.map(f => [f.id, f]));
  const bmById = new Map<string, MemoryFragment>(bm25.map(f => [f.id, f]));
  const relevance = new Map<string, number>();
  for (const [id, rrfScore] of rrf) {
    const frag = fragById.get(id) ?? bmById.get(id);
    const priority = frag ? injectionScore(frag) : 0;
    // Historical records can have malformed dates; never serialize a NaN score.
    const inj = Number.isFinite(priority) ? priority : 0;
    relevance.set(id, rrfScore + inj * 0.05);
  }

  const ranked = [...relevance.entries()]
    .map(([id, relScore]) => ({ id, relevance: relScore }))
    .sort((a, b) => b.relevance - a.relevance);

  // N8 — MMR diversity pass using TF-IDF cosine between candidates.
  const sim = (a: string, b: string): number => {
    const va = vectorById.get(a);
    const vb = vectorById.get(b);
    return va && vb ? cosineSimilarity(va, vb) : 0;
  };
  const diversified = mmrRerank(ranked, sim, lambda, topK);

  return diversified.map(id => ({
    memory_id: id, score: relevance.get(id) ?? 0,
    ...(options.explain ? { components: {
      lexical_rank: bm25Order.includes(id) ? bm25Order.indexOf(id) + 1 : null,
      semantic_rank: tfidfOrder.includes(id) ? tfidfOrder.indexOf(id) + 1 : null,
      fusion_score: rrf.get(id) ?? 0,
      priority_contribution: (relevance.get(id) ?? 0) - (rrf.get(id) ?? 0),
    } } : {}),
  }));
}
