import type { LemmaDB } from "../db/database.js";
import type { MemoryFragment } from "../types.js";
import type { TfidfVector } from "./types.js";
import { logger } from "../logger.js";

/**
 * Semantic search — in-memory TF-IDF cosine similarity.
 *
 * Lemma does not embed memories into vectors; all semantic retrieval flows
 * through `semanticSearch()` below, which builds TF-IDF vectors over the
 * current memory set each call and ranks by cosine similarity (project-scoped,
 * case-insensitive).
 *
 * Trade-off accepted: zero native dependency, instant indexing, but O(N) per
 * query (acceptable for local-first single-user scale).
 */

const STOP_WORDS = new Set([
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
  "who", "whom", "am", "also", "use", "used", "using", "make", "made",
  "like", "get", "got", "one", "two", "new", "first", "last", "long",
  "great", "little", "just", "know", "time", "way", "well", "back",
  "even", "still", "much", "many", "need", "going", "thing", "think",
]);

export function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function computeTermFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  const maxFreq = Math.max(...tf.values(), 1);
  for (const [term, freq] of tf) {
    tf.set(term, 0.5 + (0.5 * freq) / maxFreq);
  }
  return tf;
}

function computeDocumentFrequency(vectors: TfidfVector[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const vec of vectors) {
    for (const term of vec.terms.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  return df;
}

// `n` is the size of the document collection the df map was computed over.
// It must be passed explicitly when weighting a query vector against a corpus,
// otherwise the query would be scaled as if the collection had a single document
// (n = 1), producing IDF values on a different — and for common terms negative —
// scale than the corpus, so term-sharing documents score as dissimilar.
function applyIdf(vectors: TfidfVector[], df: Map<string, number>, n: number = vectors.length): void {
  for (const vec of vectors) {
    for (const [term, tf] of vec.terms) {
      const idf = Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
      vec.terms.set(term, tf * idf);
    }
    let sumSq = 0;
    for (const val of vec.terms.values()) {
      sumSq += val * val;
    }
    vec.norm = Math.sqrt(sumSq);
  }
}

export function cosineSimilarity(a: TfidfVector, b: TfidfVector): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  let dot = 0;
  for (const [term, val] of a.terms) {
    const bVal = b.terms.get(term);
    if (bVal) dot += val * bVal;
  }
  return dot / (a.norm * b.norm);
}

export function buildVectors(fragments: MemoryFragment[]): TfidfVector[] {
  const vectors: TfidfVector[] = fragments.map(f => ({
    memory_id: f.id,
    terms: computeTermFrequency(tokenize(`${f.title} ${f.fragment} ${f.description || ""}`)),
    norm: 0,
  }));

  const df = computeDocumentFrequency(vectors);
  applyIdf(vectors, df);

  logger.flow("semantic", "vectors_built", { count: vectors.length });
  return vectors;
}

/**
 * Build TF-IDF vectors from precomputed (corpus-independent) term-frequency maps
 * — the A4 vector cache path. TF is per-document; only IDF depends on the corpus,
 * so it's recomputed here while the expensive tokenization is skipped for
 * unchanged fragments. `tf` maps are cloned so callers' cached copies stay raw.
 */
export function buildVectorsFromTf(entries: Array<{ memory_id: string; tf: Map<string, number> }>): TfidfVector[] {
  const vectors: TfidfVector[] = entries.map(e => ({ memory_id: e.memory_id, terms: new Map(e.tf), norm: 0 }));
  const df = computeDocumentFrequency(vectors);
  applyIdf(vectors, df);
  return vectors;
}

export function findSemanticSimilar(
  queryText: string,
  vectors: TfidfVector[],
  topK = 5,
  threshold = 0.15
): Array<{ memory_id: string; score: number }> {
  const queryTokens = tokenize(queryText);
  const queryTf = computeTermFrequency(queryTokens);

  const queryVec: TfidfVector = {
    memory_id: "__query__",
    terms: queryTf,
    norm: 0,
  };

  // Weight the query with the SAME IDF scale the corpus vectors were built on:
  // corpus document frequencies and corpus size N. Passing the 1-element query
  // array to applyIdf without an explicit n used n=1, flipping common-term weights
  // negative and putting query and corpus on incomparable scales.
  const corpusDf = computeDocumentFrequency(vectors);
  applyIdf([queryVec], corpusDf, vectors.length);

  const results: Array<{ memory_id: string; score: number }> = [];
  for (const vec of vectors) {
    const score = cosineSimilarity(queryVec, vec);
    if (score >= threshold) {
      results.push({ memory_id: vec.memory_id, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  logger.flow("semantic", "search", { query_length: queryText.length, results: results.length });
  return results.slice(0, topK);
}

export function findSemanticSimilarPairs(
  vectors: TfidfVector[],
  threshold = 0.5,
  maxResults = 20
): Array<{ id_a: string; id_b: string; score: number }> {
  const pairs: Array<{ id_a: string; id_b: string; score: number }> = [];

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const score = cosineSimilarity(vectors[i], vectors[j]);
      if (score >= threshold) {
        pairs.push({
          id_a: vectors[i].memory_id,
          id_b: vectors[j].memory_id,
          score: Math.round(score * 100) / 100,
        });
      }
    }
    if (pairs.length >= maxResults) break;
  }

  pairs.sort((a, b) => b.score - a.score);
  return pairs.slice(0, maxResults);
}

export function semanticSearch(
  db: LemmaDB,
  queryText: string,
  options: { project?: string | null; topK?: number } = {}
): Array<{ memory_id: string; score: number; title: string; fragment: string }> {
  const rows = db.prepareCached(
    options.project
      ? `SELECT legacy_id, title, fragment FROM memories WHERE lower(project) = ? OR project IS NULL`
      : `SELECT legacy_id, title, fragment FROM memories`
  ).all(...(options.project ? [options.project.toLowerCase()] : [])) as {
    legacy_id: string; title: string; fragment: string;
  }[];

  if (rows.length === 0) return [];

  const fragments: MemoryFragment[] = rows.map(r => ({
    id: r.legacy_id,
    title: r.title,
    fragment: r.fragment,
    description: "",
  } as MemoryFragment));

  const vectors = buildVectors(fragments);
  const results = findSemanticSimilar(queryText, vectors, options.topK || 10);

  const rowMap = new Map(rows.map(r => [r.legacy_id, r]));
  return results
    .map(r => {
      const row = rowMap.get(r.memory_id);
      if (!row) return null;
      return {
        memory_id: r.memory_id,
        score: r.score,
        title: row.title,
        fragment: row.fragment.substring(0, 200),
      };
    })
    .filter(Boolean) as Array<{ memory_id: string; score: number; title: string; fragment: string }>;
}
