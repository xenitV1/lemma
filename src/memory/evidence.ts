import crypto from "crypto";
import fs from "fs";
import type { LemmaDB } from "../db/database.js";
import { logger } from "../logger.js";

/**
 * B6 — code-evidence + snippet staleness (community PR #1, no embeddings).
 * A fragment can cite the file + optional symbol + exact snippet it was derived
 * from. An opt-in recall check re-reads the file and flags the fragment stale if
 * the snippet has drifted. Pure Node crypto + text search — LLM-free, Windows-safe.
 */

export interface EvidenceInput {
  file: string;
  symbol?: string;
  snippet: string;
}

export interface EvidenceRow {
  id: number;
  file_path: string;
  symbol: string | null;
  snippet: string;
  snippet_hash: string;
  created_at: string;
}

export interface StaleReport {
  file_path: string;
  symbol: string | null;
  stale: boolean;
  reason: string;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Attach one code-evidence citation to a fragment (by internal memory id). */
export function addEvidence(lemmaDb: LemmaDB, memoryId: number, ev: EvidenceInput): void {
  lemmaDb.prepareCached(
    `INSERT INTO memory_evidence (memory_id, file_path, symbol, snippet, snippet_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(memoryId, ev.file, ev.symbol ?? null, ev.snippet, sha256(ev.snippet));
}

export function getEvidence(lemmaDb: LemmaDB, memoryId: number): EvidenceRow[] {
  return lemmaDb.prepareCached(
    "SELECT id, file_path, symbol, snippet, snippet_hash, created_at FROM memory_evidence WHERE memory_id = ?",
  ).all(memoryId) as EvidenceRow[];
}

/**
 * Re-check each citation: stale if the file is missing/unreadable or the cited
 * snippet is no longer present verbatim in it. `readFile` is injectable for tests
 * (defaults to fs). Never mutates — purely advisory (the agent decides).
 */
export function checkStale(
  lemmaDb: LemmaDB,
  memoryId: number,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): StaleReport[] {
  const reports: StaleReport[] = [];
  for (const ev of getEvidence(lemmaDb, memoryId)) {
    let content: string | null = null;
    try {
      content = readFile(ev.file_path);
    } catch {
      reports.push({ file_path: ev.file_path, symbol: ev.symbol, stale: true, reason: "cited file could not be read (moved or deleted)" });
      continue;
    }
    if (content.includes(ev.snippet)) {
      reports.push({ file_path: ev.file_path, symbol: ev.symbol, stale: false, reason: "snippet still present" });
    } else {
      reports.push({ file_path: ev.file_path, symbol: ev.symbol, stale: true, reason: "cited snippet no longer found in file (code changed)" });
    }
  }
  return reports;
}

/** Resolve a fragment's legacy id → internal id, then run the staleness check. */
export function checkStaleByLegacyId(
  lemmaDb: LemmaDB,
  legacyId: string,
  readFile?: (p: string) => string,
): StaleReport[] {
  try {
    const row = lemmaDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(legacyId) as { id: number } | undefined;
    if (!row) return [];
    return checkStale(lemmaDb, row.id, readFile);
  } catch (err) {
    logger.warn("checkStaleByLegacyId failed", { legacyId, error: String(err) });
    return [];
  }
}
