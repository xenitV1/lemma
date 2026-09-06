import type { LemmaDB } from "../db/database.js";
import { checkEvidenceRows, type EvidenceRow } from "./evidence.js";

export type RecallMethod = "explicit_id" | "graph_expansion" | "fts5_bm25" | "confidence_browse" | "substring_fallback" | "tfidf_cosine" | "hybrid_rrf_mmr";

export interface RecallSelection {
  id: string;
  method: RecallMethod;
  rank: number | null;
  score?: number;
  graph?: { root_id: string; depth: number };
  components?: { lexical_rank: number | null; semantic_rank: number | null; fusion_score: number; priority_contribution: number };
}

const METHODS: Record<RecallMethod, { reason: string; score_kind: string | null }> = {
  explicit_id: { reason: "Requested by ID; no relevance ranking or project filter was applied.", score_kind: null },
  graph_expansion: { reason: "Reached through stored relations from the requested ID; the graph score includes a depth penalty.", score_kind: "graph_score_with_depth_penalty" },
  fts5_bm25: { reason: "Matched the keyword query; ordered by FTS5 BM25 (lower scores rank first).", score_kind: "bm25_lower_is_better" },
  confidence_browse: { reason: "No usable keyword terms; browsed records ordered by stored confidence.", score_kind: "stored_confidence" },
  substring_fallback: { reason: "FTS search failed; the fallback matched text with LIKE and ordered by stored confidence.", score_kind: "stored_confidence" },
  tfidf_cosine: { reason: "Selected by TF-IDF cosine similarity to the query.", score_kind: "tfidf_cosine_similarity" },
  hybrid_rrf_mmr: { reason: "Selected from fused lexical and TF-IDF ranks, adjusted by recall priority and diversity. Display order includes MMR diversity reranking.", score_kind: "hybrid_relevance_before_diversity" },
};

interface ProvenanceRow {
  id: number;
  source: string;
  created_at: string;
  last_accessed_at: string | null;
  confidence: number;
  project: string | null;
  session_id: string | null;
  invalidated_at: string | null;
}

/** Read-only metadata for THIS selection, captured before access boosts or auto-links. */
export function explainRecall(
  db: LemmaDB,
  selections: RecallSelection[],
  scope: { mode: "explicit_ids" | "all_projects" | "project_and_global"; project: string | null },
  verifyEvidence: boolean,
) {
  const items = selections.map(selection => {
    const row = db.prepareCached("SELECT id, source, created_at, last_accessed_at, confidence, project, session_id, invalidated_at FROM memories WHERE legacy_id = ?")
      .get(selection.id) as ProvenanceRow | undefined;
    if (!row) return { id: selection.id, unavailable: "Record no longer available." };
    // Fetch at most six: display/check five and signal truncation without loading all snippets.
    const citations = db.prepareCached("SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY id LIMIT 6").all(row.id) as EvidenceRow[];
    const shown = citations.slice(0, 5);
    const checks = verifyEvidence ? checkEvidenceRows(shown) : [];
    const status = shown.length === 0 ? "no_evidence"
      : !verifyEvidence ? "not_checked"
      : checks.some(check => check.stale) ? "stale_or_unavailable" : "checked_snippets_present";
    return {
      id: selection.id,
      selection: {
        method: selection.method, reason: METHODS[selection.method].reason, rank: selection.rank,
        score: selection.score !== undefined && Number.isFinite(selection.score) ? selection.score : null,
        score_kind: METHODS[selection.method].score_kind,
        ...(selection.graph ? { graph: selection.graph } : {}),
        ...(selection.components ? { components: selection.components } : {}),
      },
      provenance: {
        recorded_source: row.source, created_at: row.created_at, project: row.project,
        recorded_session_id: row.session_id, confidence_before_read: row.confidence,
        last_accessed_before_read: row.last_accessed_at, invalidated_at: row.invalidated_at,
        citations: shown.map(ev => ({ file: ev.file_path, symbol: ev.symbol, recorded_at: ev.created_at })),
      },
      freshness: {
        status, checked_at: checks.length ? new Date().toISOString() : null,
        checks, citations_truncated: citations.length > shown.length,
      },
    };
  });
  return {
    applies_to: "this_call" as const, scope,
    notice: "Explains this call, not a past recall. Scores, access times and source labels are not proof of correctness. Evidence checks only test whether cited snippets are present; at most five citations per record are checked, and only when verification.stale_check is enabled.",
    correction_tools: [
      { tool: "memory_update", use: "Correct the title or content after reviewing the record." },
      { tool: "memory_forget", use: "Use invalidate=true to hide outdated knowledge while retaining its history." },
      { tool: "memory_relate", use: "Link a confirmed replacement with supersedes, or record a contradiction with contradicts." },
    ],
    items,
  };
}

export type RecallExplanation = ReturnType<typeof explainRecall>;

export function formatRecallExplanation(explanation: RecallExplanation): string {
  const statuses: Record<string, string> = {
    no_evidence: "no recorded evidence",
    not_checked: "not checked (evidence verification is disabled)",
    stale_or_unavailable: "some evidence changed or could not be read",
    checked_snippets_present: "checked snippets are still present",
  };
  const lines = explanation.items.map(item => {
    if (!item.selection) return `- [${item.id}] Explanation unavailable.`;
    const rank = item.selection.rank === null ? "" : ` Rank ${item.selection.rank}.`;
    const score = item.selection.score === null ? "" : ` Score ${item.selection.score} (${item.selection.score_kind}).`;
    const sources = item.provenance.citations.map(c => `${c.file}${c.symbol ? ` (${c.symbol})` : ""}`).join(", ") || "no citations";
    const graph = item.selection.graph ? ` Root: ${item.selection.graph.root_id}, depth: ${item.selection.graph.depth}.` : "";
    return `- [${item.id}] ${item.selection.reason}${rank}${score}${graph}\n  Source label: ${item.provenance.recorded_source}; project: ${item.provenance.project ?? "global"}; created: ${item.provenance.created_at}. Evidence: ${sources}. Status: ${statuses[item.freshness.status]}${item.freshness.citations_truncated ? " (first five citations only)" : ""}.${item.provenance.invalidated_at ? ` Invalidated: ${item.provenance.invalidated_at}.` : ""}`;
  });
  return `\n\n## Why these memories?\n${lines.join("\n")}\n${explanation.notice}\nTo correct: memory_update; to hide outdated knowledge reversibly: memory_forget invalidate=true; to link a replacement: memory_relate supersedes. Review before changing records.`;
}
