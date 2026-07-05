import os from "os";
import path from "path";
import crypto from "crypto";

import type { MemoryFragment, MemoryRelation, MemoryStats, AuditResult, FragmentType } from "../types.js";
import { logger } from "../logger.js";

import { getDb, setDataDir } from "../db/database.js";
import * as store from "../db/memory-store.js";
import { sanitizeFtsQuery } from "../db/fts.js";
import { calculateQualityScore } from "../intelligence/scoring.js";
import { loadConfig } from "./config.js";

let MEMORY_DIR = path.join(os.homedir(), ".lemma");

export function setMemoryDir(dir: string): void {
  MEMORY_DIR = dir;
  setDataDir(dir);
}

export function generateId(): string {
  return "m" + crypto.randomUUID().replace(/-/g, "").substring(0, 12);
}

export function detectProject(): string | null {
  try {
    const cwd = process.cwd();
    // Normalize to the canonical project key (trimmed + lowercased) so every
    // downstream store — memories.project, sessions.project, recall filters —
    // compares against the same case. Without this, addMemory()'s normalized
    // value and createSession()'s raw value diverge (e.g. "lemma" vs "Lemma").
    const projectName = path.basename(cwd).trim().toLowerCase();
    const result = projectName || null;
    logger.flow("detect", "project", { project: result });
    return result;
  } catch {
    return null;
  }
}

/**
 * Canonical project key for an arbitrary caller-supplied value: trimmed +
 * lowercased, with any path (forward or backslash) collapsed to its basename.
 * Mirrors detectProject() so a stored key and a recall filter always agree,
 * regardless of whether the caller passed "Lemma", "/home/x/Projeler/Lemma",
 * or "lemma".
 *
 * Returns null for non-strings, empty, or whitespace-only input.
 */
export function normalizeProjectKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  p = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.includes("/")) {
    const segs = p.split("/").filter(Boolean);
    p = segs.length > 0 ? segs[segs.length - 1] : "";
  }
  p = p.trim().toLowerCase();
  return p || null;
}

/**
 * Resolve the project scope a memory/session should be filed under.
 *
 * - undefined (caller omitted it) -> auto-detect from cwd basename. This is the
 *   default that makes project isolation "just work".
 * - null (caller passed it explicitly) -> global (null). Explicit null is the
 *   documented request for cross-project scope.
 * - a non-empty string -> normalized via normalizeProjectKey (basename + lowercase).
 * - a value that normalizes to empty -> treated as omitted (auto-detect).
 * - the literal "global" (case-insensitive) -> null. Callers use "global" to
 *   request global scope; without this it would be filed under a bogus project
 *   literally named "global" and vanish from project-scoped views.
 *
 * This is the single chokepoint for write-side project resolution, so handlers
 * never store a divergent key. Pair with a schema that has NO default on
 * `project`, so clients send undefined (not null) when the caller omits it.
 */
export function resolveProjectScope(explicit: unknown): string | null {
  if (explicit === null) return null;
  if (explicit === undefined) return detectProject() || null;
  const norm = normalizeProjectKey(explicit);
  if (norm === null) return detectProject() || null;
  if (norm === "global") return null;
  return norm;
}

function generateDescription(fragment: string, title: string): string {
  if (fragment.length <= 80) {
    return fragment;
  }

  const firstSentence = fragment.split(/[.!?\n]/)[0];
  if (firstSentence && firstSentence.length <= 100) {
    return firstSentence.trim() + (firstSentence.endsWith('.') ? '' : '...');
  }

  return fragment.substring(0, 80).trim() + '...';
}

export function createFragment(fragment: string, source: "user" | "ai", title: string | null = null, project: string | null = null, description: string | null = null, type: FragmentType = "fact"): MemoryFragment {
  const autoTitle = title || (fragment.length > 40 ? fragment.substring(0, 40) + "..." : fragment);
  const autoDescription = description || generateDescription(fragment, autoTitle);

  const now = new Date();
  const id = generateId();

  logger.flow("fragment", "create", { id, title: autoTitle, project, type });

  return {
    id: id,
    title: autoTitle,
    description: autoDescription,
    fragment: fragment,
    project: project,
    confidence: 1.0,
    source: source,
    created: now.toISOString().split("T")[0] ?? "",
    lastAccessed: now.toISOString(),
    accessed: 0,
    tags: [],
    associatedWith: [],
    relations: [],
    negativeHits: 0,
    quality_score: null,
    refinement_count: 0,
    parent_id: null,
    child_ids: [],
    session_id: null,
    task_type: null,
    outcome: null,
    positive_feedback: 0,
    negative_feedback: 0,
    last_refined: null,
    type: type,
    related_guides: [],
  };
}

export async function findSimilarFragment(fragments: MemoryFragment[], fragmentText: string, project: string | null, threshold = 0.80): Promise<MemoryFragment | null> {
  const scopedFragments = filterByProject(fragments, project);
  if (scopedFragments.length === 0) return null;

  logger.flow("dedup", "checking", { threshold, scopedCount: scopedFragments.length });

  try {
    const db = getDb();
    const ftsQuery = sanitizeFtsQuery(fragmentText);

    if (!ftsQuery) {
      logger.flow("dedup", "no_similar");
      return null;
    }

    let sql: string;
    let params: any[];

    if (project) {
      sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
             FROM memory_fts fts
             JOIN memories m ON m.id = fts.rowid
             LEFT JOIN memories p ON m.parent_id = p.id
             WHERE memory_fts MATCH ? AND (m.project = ? OR m.project IS NULL)
             ORDER BY rank
             LIMIT 3`;
      params = [ftsQuery, project.toLowerCase()];
    } else {
      sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
             FROM memory_fts fts
             JOIN memories m ON m.id = fts.rowid
             LEFT JOIN memories p ON m.parent_id = p.id
             WHERE memory_fts MATCH ? AND m.project IS NULL
             ORDER BY rank
             LIMIT 3`;
      params = [ftsQuery];
    }

    const rows = db.prepareCached(sql).all(...params) as Record<string, any>[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id as number);
      const relRows = db.prepareCached(
        `SELECT r.source_id, r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
         FROM relations r JOIN memories m ON m.id = r.target_id
         WHERE r.source_id IN (${ids.map(() => "?").join(",")})`
      ).all(...ids) as { source_id: number; target_legacy_id: string; type: string; note: string | null; created_at: string }[];

      const relationsMap = new Map<number, MemoryRelation[]>();
      for (const rr of relRows) {
        const list = relationsMap.get(rr.source_id) ?? [];
        list.push({ id: rr.target_legacy_id, type: rr.type as MemoryRelation["type"], note: rr.note ?? undefined, created: rr.created_at });
        relationsMap.set(rr.source_id, list);
      }

      const queryWords = new Set(fragmentText.toLowerCase().split(/\s+/).filter(w => w.length > 1));
      for (const row of rows) {
        const fragText = (row.fragment as string) || "";
        const fragWords = new Set(fragText.toLowerCase().split(/\s+/).filter(w => w.length > 1));
        if (queryWords.size === 0) continue;
        let overlap = 0;
        for (const w of queryWords) {
          if (fragWords.has(w)) overlap++;
        }
        const wordScore = overlap / queryWords.size;
        if (wordScore >= threshold) {
          const frag = rowToFragment(row, relationsMap.get(row.id) ?? []);
          logger.flow("dedup", "found_similar", { id: frag.id, wordScore });
          return frag;
        }
      }
    }
  } catch (err) {
    logger.warn("FTS dedup search failed", { error: String(err) });
  }

  logger.flow("dedup", "no_similar");
  return null;
}

function wordOverlapScore(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

export async function findTopicOverlaps(fragments: MemoryFragment[], fragmentText: string, project: string | null, limit = 5): Promise<MemoryFragment[]> {
  const scopedFragments = filterByProject(fragments, project);
  if (scopedFragments.length === 0) return [];

  logger.flow("overlap", "searching", { scopedCount: scopedFragments.length });

  try {
    const db = getDb();
    const ftsQuery = sanitizeFtsQuery(fragmentText);

    if (ftsQuery) {
      let sql: string;
      let params: any[];

      if (project) {
        sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
               FROM memory_fts fts
               JOIN memories m ON m.id = fts.rowid
               LEFT JOIN memories p ON m.parent_id = p.id
               WHERE memory_fts MATCH ? AND (m.project = ? OR m.project IS NULL)
               ORDER BY rank
               LIMIT ?`;
        params = [ftsQuery, project.toLowerCase(), limit];
      } else {
        sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
               FROM memory_fts fts
               JOIN memories m ON m.id = fts.rowid
               LEFT JOIN memories p ON m.parent_id = p.id
               WHERE memory_fts MATCH ? AND m.project IS NULL
               ORDER BY rank
               LIMIT ?`;
        params = [ftsQuery, limit];
      }

      const rows = db.prepareCached(sql).all(...params) as Record<string, any>[];

      if (rows.length > 0) {
        const ids = rows.map(r => r.id as number);
        const relRows = db.prepareCached(
          `SELECT r.source_id, r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
           FROM relations r JOIN memories m ON m.id = r.target_id
           WHERE r.source_id IN (${ids.map(() => "?").join(",")})`
        ).all(...ids) as { source_id: number; target_legacy_id: string; type: string; note: string | null; created_at: string }[];

        const relationsMap = new Map<number, MemoryRelation[]>();
        for (const rr of relRows) {
          const list = relationsMap.get(rr.source_id) ?? [];
          list.push({ id: rr.target_legacy_id, type: rr.type as MemoryRelation["type"], note: rr.note ?? undefined, created: rr.created_at });
          relationsMap.set(rr.source_id, list);
        }

        for (const row of rows) {
          const ftsFrag = rowToFragment(row, relationsMap.get(row.id) ?? []);
          const ftsScore = wordOverlapScore(fragmentText, ftsFrag.fragment);
          if (ftsScore >= 0.25) {
            const alreadyExists = scopedFragments.some(f => f.id === ftsFrag.id);
            if (!alreadyExists) {
              scopedFragments.push(ftsFrag);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn("FTS overlap search failed", { error: String(err) });
  }

  const fallbackOverlaps: { frag: MemoryFragment; score: number }[] = [];
  for (const frag of scopedFragments) {
    const score = wordOverlapScore(fragmentText, frag.fragment);
    if (score >= 0.25 && score < 0.95) {
      fallbackOverlaps.push({ frag, score });
    }
  }
  fallbackOverlaps.sort((a, b) => b.score - a.score);
  const result = fallbackOverlaps.slice(0, limit).map(o => o.frag);
  logger.flow("overlap", "found_fallback", { count: result.length });
  return result;
}

export function boostOnAccess(fragment: MemoryFragment, context: string | null = null): MemoryFragment {
  const boosted = { ...fragment };
  boosted.confidence = Math.min(1.0, boosted.confidence + 0.015);
  boosted.accessed++;
  boosted.lastAccessed = new Date().toISOString();

  logger.flow("confidence", "boost", { id: fragment.id, from: fragment.confidence, to: boosted.confidence });

  if (context && typeof context === "string") {
    const tags = boosted.tags || [];
    const newTag = context.trim().toLowerCase();
    if (newTag && !tags.includes(newTag)) {
      boosted.tags = [...tags, newTag];
    }
  }

  // Refresh the (formerly dormant) quality_score on this localized touch — no
  // global rebuild, just the fragment already being written. (roadmap C2)
  boosted.quality_score = calculateQualityScore(boosted);

  try {
    const db = getDb();
    store.updateMemory(db, fragment.id, {
      confidence: boosted.confidence,
      context_tags: boosted.tags,
      access_count: boosted.accessed,
      quality_score: boosted.quality_score,
    });
    // Mark this fragment as accessed in the current decay window so the next
    // decay run spares it. Separate from access_count (lifetime) — see SCHEMA_V4.
    db.prepareCached(
      `UPDATE memories SET access_window = access_window + 1 WHERE legacy_id = ?`
    ).run(fragment.id);
  } catch (err) {
    logger.warn("Failed to write-through boost", { id: fragment.id, error: String(err) });
  }

  return boosted;
}

export function recordNegativeHit(fragment: MemoryFragment): MemoryFragment {
  const result = {
    ...fragment,
    confidence: Math.max(0, fragment.confidence - 0.02),
    negativeHits: (fragment.negativeHits || 0) + 1,
    lastAccessed: new Date().toISOString()
  };
  result.quality_score = calculateQualityScore(result);
  logger.flow("confidence", "penalize", { id: fragment.id, from: fragment.confidence, to: result.confidence });

  try {
    const db = getDb();
    db.prepareCached(
      `UPDATE memories SET confidence = ?, negative_hits = negative_hits + 1, quality_score = ?,
       last_accessed_at = datetime('now'), updated_at = datetime('now')
       WHERE legacy_id = ?`
    ).run(result.confidence, result.quality_score, fragment.id);
  } catch (err) {
    logger.warn("Failed to write-through negative hit", { id: fragment.id, error: String(err) });
  }

  return result;
}

export function trackAssociations(fragments: MemoryFragment[], accessedId: string, sessionIds: string[]): void {
  if (!sessionIds || sessionIds.length === 0) return;

  const target = fragments.find(f => f.id === accessedId);
  if (!target) return;

  const existing = new Set(target.associatedWith || []);
  for (const id of sessionIds) {
    if (id !== accessedId && !existing.has(id)) {
      existing.add(id);
      const other = fragments.find(f => f.id === id);
      if (other) {
        const otherAssoc = new Set(other.associatedWith || []);
        otherAssoc.add(accessedId);
        other.associatedWith = [...otherAssoc];
      }
    }
  }
  target.associatedWith = [...existing];

  try {
    const db = getDb();
    const stmt = db.prepareCached(
      `UPDATE memories SET associated_with = ?, updated_at = datetime('now') WHERE legacy_id = ?`
    );
    stmt.run(JSON.stringify(target.associatedWith), target.id);
    for (const id of sessionIds) {
      if (id !== accessedId) {
        const other = fragments.find(f => f.id === id);
        if (other) {
          stmt.run(JSON.stringify(other.associatedWith), other.id);
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to write-through associations", { error: String(err) });
  }
}

const REVERSE_RELATION_MAP: Record<string, MemoryRelation["type"]> = {
  supports: "supports",
  contradicts: "contradicts",
  supersedes: "superseded_by",
  related_to: "related_to",
};

export function addRelation(fragments: MemoryFragment[], sourceId: string, targetId: string, type: MemoryRelation["type"], note?: string): boolean {
  const source = fragments.find(f => f.id === sourceId);
  const target = fragments.find(f => f.id === targetId);
  if (!source || !target) return false;

  source.relations = source.relations || [];
  const exists = source.relations.find(r => r.id === targetId && r.type === type);
  if (exists) {
    logger.flow("relation", "duplicate", { sourceId, targetId, type });
    return false;
  }

  logger.flow("relation", "add", { sourceId, targetId, type });

  source.relations.push({
    id: targetId,
    type,
    note: note || undefined,
    created: new Date().toISOString().split("T")[0] || "",
  });

  const reverseType = REVERSE_RELATION_MAP[type] || "related_to";
  target.relations = target.relations || [];
  const reverseExists = target.relations.find(r => r.id === sourceId && r.type === reverseType);
  if (!reverseExists) {
    target.relations.push({
      id: sourceId,
      type: reverseType,
      note: `Reverse of ${type}`,
      created: new Date().toISOString().split("T")[0] || "",
    });
  }

  try {
    const db = getDb();
    const sourceRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(sourceId) as { id: number } | undefined;
    const targetRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(targetId) as { id: number } | undefined;
    if (sourceRow && targetRow) {
      store.addRelation(db, sourceRow.id, targetRow.id, type, note);
      store.addRelation(db, targetRow.id, sourceRow.id, reverseType, `Reverse of ${type}`);
    }
  } catch (err) {
    logger.warn("Failed to write-through relation", { sourceId, targetId, error: String(err) });
  }

  return true;
}

export function loadMemory(opts?: { includeInvalidated?: boolean }): MemoryFragment[] {
  logger.data("memory.sqlite", "load_start");
  try {
    const db = getDb();

    // B2/N9: logically-invalidated fragments are excluded from recall by default
    // (kept in the DB + fragment_history; pass includeInvalidated to see them).
    const invalidatedClause = opts?.includeInvalidated ? "" : "WHERE m.invalidated_at IS NULL";
    const rows = db.prepareCached(
      `SELECT m.*, p.legacy_id as parent_legacy_id
       FROM memories m
       LEFT JOIN memories p ON m.parent_id = p.id
       ${invalidatedClause}
       ORDER BY m.confidence DESC`
    ).all() as Record<string, any>[];

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map(r => r.id as number);
    const placeholders = ids.map(() => "?").join(",");

    const childRows = db.prepareCached(
      `SELECT parent_id, legacy_id FROM memories WHERE parent_id IN (${placeholders})`
    ).all(...ids) as { parent_id: number; legacy_id: string }[];

    const childrenMap = new Map<number, string[]>();
    for (const cr of childRows) {
      const list = childrenMap.get(cr.parent_id) ?? [];
      list.push(cr.legacy_id);
      childrenMap.set(cr.parent_id, list);
    }

    const relRows = db.prepareCached(
      `SELECT r.source_id, r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
       FROM relations r
       JOIN memories m ON m.id = r.target_id
       WHERE r.source_id IN (${placeholders})`
    ).all(...ids) as {
      source_id: number;
      target_legacy_id: string;
      type: string;
      note: string | null;
      created_at: string;
    }[];

    const relationsMap = new Map<number, MemoryRelation[]>();
    for (const rr of relRows) {
      const list = relationsMap.get(rr.source_id) ?? [];
      list.push({
        id: rr.target_legacy_id,
        type: rr.type as MemoryRelation["type"],
        note: rr.note ?? undefined,
        created: rr.created_at,
      });
      relationsMap.set(rr.source_id, list);
    }

    const fragments = rows.map(row => {
      const frag = rowToFragment(row, relationsMap.get(row.id) ?? []);
      frag.child_ids = childrenMap.get(row.id) ?? [];
      return frag;
    });

    logger.data("memory.sqlite", "loaded", { count: fragments.length });
    return fragments;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load memory from SQLite", msg);
    return [];
  }
}

function rowToFragment(row: Record<string, any>, relations: MemoryRelation[] = []): MemoryFragment {
  return {
    id: row.legacy_id ?? String(row.id),
    title: row.title,
    description: row.description ?? "",
    fragment: row.fragment,
    project: row.project ?? null,
    confidence: row.confidence,
    source: row.source,
    created: row.created_at,
    lastAccessed: row.last_accessed_at ?? row.created_at,
    accessed: row.access_count,
    tags: parseJsonField(row.context_tags),
    associatedWith: parseJsonField(row.associated_with),
    relations,
    negativeHits: row.negative_hits,
    quality_score: row.quality_score,
    refinement_count: row.refinement_count,
    parent_id: row.parent_legacy_id ?? null,
    child_ids: [],
    session_id: row.session_id ?? null,
    task_type: row.task_type ?? null,
    outcome: null,
    positive_feedback: row.positive_feedback,
    negative_feedback: row.negative_feedback,
    last_refined: row.last_refined ?? null,
    type: row.type,
    related_guides: parseJsonField(row.related_guides),
    distill_candidate: row.distill_candidate === 1,
    invalidated_at: row.invalidated_at ?? null,
  };
}

function parseJsonField(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMemory(fragments: MemoryFragment[], options: { force?: boolean } = {}): void {
  try {
    if ((!fragments || fragments.length === 0) && !options.force) {
      logger.warn("Aborted save of empty memory array");
      return;
    }

    logger.data("memory.sqlite", "save_start", { count: fragments?.length ?? 0, force: options.force });

    const db = getDb();

    const upsertStmt = db.prepareCached(`
      INSERT INTO memories (
        legacy_id, title, fragment, description, type, project, source, confidence,
        context_tags, access_count, last_accessed_at, negative_hits, positive_feedback,
        negative_feedback, quality_score, refinement_count, session_id, task_type,
        distill_candidate, related_guides, associated_with, last_refined, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(legacy_id) DO UPDATE SET
        title = excluded.title,
        fragment = excluded.fragment,
        description = excluded.description,
        type = excluded.type,
        project = excluded.project,
        source = excluded.source,
        confidence = excluded.confidence,
        context_tags = excluded.context_tags,
        access_count = excluded.access_count,
        last_accessed_at = excluded.last_accessed_at,
        negative_hits = excluded.negative_hits,
        positive_feedback = excluded.positive_feedback,
        negative_feedback = excluded.negative_feedback,
        quality_score = excluded.quality_score,
        refinement_count = excluded.refinement_count,
        session_id = excluded.session_id,
        task_type = excluded.task_type,
        distill_candidate = excluded.distill_candidate,
        related_guides = excluded.related_guides,
        associated_with = excluded.associated_with,
        last_refined = excluded.last_refined,
        updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();

    const { db: rawDb } = db;
    const transaction = rawDb.transaction(() => {
      for (const frag of fragments) {
        upsertStmt.run(
          frag.id,
          frag.title,
          frag.fragment,
          frag.description || null,
          frag.type || "fact",
          frag.project || null,
          frag.source || "ai",
          frag.confidence ?? 0.5,
          frag.tags ? JSON.stringify(frag.tags) : null,
          frag.accessed ?? 0,
          frag.lastAccessed || null,
          frag.negativeHits ?? 0,
          frag.positive_feedback ?? 0,
          frag.negative_feedback ?? 0,
          frag.quality_score ?? null,
          frag.refinement_count ?? 0,
          frag.session_id || null,
          frag.task_type || null,
          frag.distill_candidate ? 1 : 0,
          frag.related_guides ? JSON.stringify(frag.related_guides) : null,
          frag.associatedWith ? JSON.stringify(frag.associatedWith) : null,
          frag.last_refined || null,
          frag.created || now,
          now,
        );
      }
    });

    transaction();

    logger.data("memory.sqlite", "saved", { count: fragments?.length ?? 0 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to save memory to SQLite", msg);
    throw error;
  }
}

export function removeGuideFromMemories(guideName: string): number {
  const normalized = guideName.toLowerCase().trim();
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT id, legacy_id, related_guides FROM memories WHERE related_guides IS NOT NULL`
    ).all() as { id: number; legacy_id: string; related_guides: string }[];

    let cleaned = 0;
    for (const row of rows) {
      const guides: string[] = JSON.parse(row.related_guides);
      const filtered = guides.filter(g => g.toLowerCase() !== normalized);
      if (filtered.length !== guides.length) {
        db.prepareCached(
          `UPDATE memories SET related_guides = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(JSON.stringify(filtered), row.id);
        cleaned++;
      }
    }
    logger.flow("memory", "remove_guide_refs", { guide: guideName, cleaned });
    return cleaned;
  } catch (err) {
    logger.warn("Failed to remove guide from memories", { guide: guideName, error: String(err) });
    return 0;
  }
}

export function renameGuideInMemories(oldName: string, newName: string): number {
  const oldNorm = oldName.toLowerCase().trim();
  const newNorm = newName.toLowerCase().trim();
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT id, legacy_id, related_guides FROM memories WHERE related_guides IS NOT NULL`
    ).all() as { id: number; legacy_id: string; related_guides: string }[];

    let renamed = 0;
    for (const row of rows) {
      const guides: string[] = JSON.parse(row.related_guides);
      if (guides.some(g => g.toLowerCase() === oldNorm)) {
        const updated = guides.map(g => g.toLowerCase() === oldNorm ? newNorm : g);
        db.prepareCached(
          `UPDATE memories SET related_guides = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(JSON.stringify(updated), row.id);
        renamed++;
      }
    }
    logger.flow("memory", "rename_guide_refs", { old: oldName, new: newName, renamed });
    return renamed;
  } catch (err) {
    logger.warn("Failed to rename guide in memories", { old: oldName, new: newName, error: String(err) });
    return 0;
  }
}

export function addFragmentToDb(fragment: MemoryFragment): { id: number; legacy_id: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepareCached(
    `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, distill_candidate, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fragment.id,
    fragment.title,
    fragment.fragment,
    fragment.description || null,
    fragment.type || "fact",
    normalizeProjectKey(fragment.project),
    fragment.source || "ai",
    fragment.confidence ?? 0.5,
    fragment.distill_candidate ? 1 : 0,
    fragment.created || now,
    now,
  );
  const id = Number(result.lastInsertRowid);
  return { id, legacy_id: fragment.id };
}

export function updateFragmentInDb(id: string, updates: {
  title?: string;
  fragment?: string;
  confidence?: number;
  session_id?: string | null;
  task_type?: string | null;
  related_guides?: string[];
  distill_candidate?: boolean;
  associated_with?: string[];
}): boolean {
  const db = getDb();
  return store.updateMemory(db, id, updates);
}

export function getFragmentById(id: string): MemoryFragment | null {
  const db = getDb();
  return store.getMemoryById(db, id);
}

export function mergeFragmentsInDb(ids: string[], _newId: string, title: string, fragment: string, _project: string | null): boolean {
  const db = getDb();
  const numericIds: number[] = [];
  for (const legacyId of ids) {
    const row = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(legacyId) as { id: number } | undefined;
    if (row) numericIds.push(row.id);
  }
  if (numericIds.length === 0) return false;
  store.mergeMemories(db, numericIds, title, fragment);
  return true;
}

export function deleteMemory(id: string): boolean {
  try {
    const db = getDb();
    const result = db.prepareCached("DELETE FROM memories WHERE legacy_id = ?").run(id);
    if (result.changes > 0) {
      return true;
    }
    return false;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to delete memory from SQLite", msg);
    return false;
  }
}

/** B2/N9: logically invalidate a fragment (hide from recall, keep in DB + history). */
export function invalidateFragment(id: string): boolean {
  try {
    return store.invalidateMemory(getDb(), id);
  } catch (err) {
    logger.warn("invalidateFragment failed", { id, error: String(err) });
    return false;
  }
}

/** Reverse a logical invalidation. */
export function restoreFragment(id: string): boolean {
  try {
    return store.restoreMemory(getDb(), id);
  } catch (err) {
    logger.warn("restoreFragment failed", { id, error: String(err) });
    return false;
  }
}

/** Prior content versions of a fragment (newest first). */
export function getFragmentHistory(id: string, limit = 20): store.FragmentHistoryEntry[] {
  try {
    return store.getFragmentHistory(getDb(), id, limit);
  } catch (err) {
    logger.warn("getFragmentHistory failed", { id, error: String(err) });
    return [];
  }
}

let writeLock = false;
let writeQueue: Array<() => void> = [];

function acquireLock(): Promise<void> {
  return new Promise((resolve) => {
    if (!writeLock) {
      writeLock = true;
      resolve();
    } else {
      writeQueue.push(resolve);
    }
  });
}

function releaseLock(): void {
  writeLock = false;
  if (writeQueue.length > 0) {
    writeLock = true;
    const next = writeQueue.shift()!;
    next();
  }
}

export async function saveMemorySafe(fragments: MemoryFragment[], options: { force?: boolean } = {}): Promise<void> {
  logger.data("memory.sqlite", "acquiring_lock");
  await acquireLock();
  try {
    saveMemory(fragments, options);
  } finally {
    releaseLock();
    logger.data("memory.sqlite", "released_lock");
  }
}

export function applySessionDecay(): MemoryFragment[] {
  logger.flow("decay", "session_start");

  // Single source of truth: decay is applied once, in the DB, by store.decayMemories
  // (24h rate-limited).
  try {
    const db = getDb();
    store.decayMemories(db);
  } catch (err) {
    logger.warn("Failed to apply decay in SQLite", { error: String(err) });
  }

  // Return memory as it now actually stands in the DB after decay.
  const memory = loadMemory();
  logger.flow("decay", "session_complete", { count: memory.length });
  return memory;
}

/**
 * B1: capacity-driven Heat eviction. No-op unless eviction.enabled and the live
 * count exceeds eviction.max_fragments. Archives the coldest fragments (never a
 * content delete). Returns the number evicted.
 */
export function applyEviction(): number {
  try {
    const cfg = loadConfig();
    if (!cfg.eviction?.enabled) return 0;
    const evicted = store.evictColdFragments(getDb(), cfg.eviction.max_fragments);
    if (evicted > 0) logger.info(`Heat eviction archived ${evicted} cold fragment(s)`);
    return evicted;
  } catch (err) {
    logger.warn("applyEviction failed", { error: String(err) });
    return 0;
  }
}

export function migrateConfidenceFloor(): number {
  logger.flow("migration", "confidence_floor");
  let migrated = 0;

  try {
    const db = getDb();
    const result = db.prepareCached(
      `UPDATE memories SET confidence = MAX(confidence, 0.3), updated_at = datetime('now') WHERE confidence < 0.3`
    ).run();
    migrated = result.changes;
  } catch (err) {
    logger.warn("Failed to migrate confidence floor in SQLite", { error: String(err) });
  }

  logger.flow("migration", "migrated", { count: migrated });
  return migrated;
}

export function findSimilarByText(text: string, project: string | null, threshold: number = 0.80, excludeId?: string): MemoryFragment | null {
  try {
    const db = getDb();
    const ftsQuery = sanitizeFtsQuery(text);

    if (!ftsQuery) return null;

    let sql: string;
    let params: any[];

    if (project) {
      sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
             FROM memory_fts fts
             JOIN memories m ON m.id = fts.rowid
             LEFT JOIN memories p ON m.parent_id = p.id
             WHERE memory_fts MATCH ? AND (m.project = ? OR m.project IS NULL)
             ORDER BY rank
             LIMIT 3`;
      params = [ftsQuery, project.toLowerCase()];
    } else {
      sql = `SELECT m.*, p.legacy_id as parent_legacy_id, bm25(memory_fts) as rank
             FROM memory_fts fts
             JOIN memories m ON m.id = fts.rowid
             LEFT JOIN memories p ON m.parent_id = p.id
             WHERE memory_fts MATCH ? AND m.project IS NULL
             ORDER BY rank
             LIMIT 3`;
      params = [ftsQuery];
    }

    const rows = db.prepareCached(sql).all(...params) as Record<string, any>[];
    if (rows.length > 0) {
      const ids = rows.map(r => r.id as number);
      const relRows = db.prepareCached(
        `SELECT r.source_id, r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
         FROM relations r JOIN memories m ON m.id = r.target_id
         WHERE r.source_id IN (${ids.map(() => "?").join(",")})`
      ).all(...ids) as { source_id: number; target_legacy_id: string; type: string; note: string | null; created_at: string }[];

      const relationsMap = new Map<number, MemoryRelation[]>();
      for (const rr of relRows) {
        const list = relationsMap.get(rr.source_id) ?? [];
        list.push({ id: rr.target_legacy_id, type: rr.type as MemoryRelation["type"], note: rr.note ?? undefined, created: rr.created_at });
        relationsMap.set(rr.source_id, list);
      }

      const queryWords = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 1));
      if (queryWords.size === 0) return null;
      for (const row of rows) {
        if (excludeId && (row.legacy_id as string) === excludeId) continue;
        const fragText = (row.fragment as string) || "";
        const fragWords = new Set(fragText.toLowerCase().split(/\s+/).filter(w => w.length > 1));
        let overlap = 0;
        for (const w of queryWords) {
          if (fragWords.has(w)) overlap++;
        }
        const wordScore = overlap / queryWords.size;
        if (wordScore >= threshold) {
          const frag = rowToFragment(row, relationsMap.get(row.id) ?? []);
          logger.flow("dedup", "found_similar", { id: frag.id, wordScore });
          return frag;
        }
      }
    }
  } catch (err) {
    logger.warn("findSimilarByText failed", { error: String(err) });
  }

  return null;
}

export function findTopicOverlapsByText(text: string, project: string | null, limit: number = 3): MemoryFragment[] {
  try {
    const db = getDb();
    const results = store.searchMemories(db, text, { project: project || undefined, topK: limit + 5 });
    const queryWords = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    const filtered = results.filter(frag => {
      if (queryWords.size === 0) return false;
      const fragWords = new Set(frag.fragment.toLowerCase().split(/\s+/).filter(w => w.length > 1));
      let intersection = 0;
      for (const w of queryWords) {
        if (fragWords.has(w)) intersection++;
      }
      const score = intersection / Math.max(queryWords.size, fragWords.size);
      return score >= 0.25 && score < 0.95;
    });
    filtered.sort((a, b) => b.confidence - a.confidence);
    return filtered.slice(0, limit);
  } catch (err) {
    logger.warn("findTopicOverlapsByText failed", { error: String(err) });
    return [];
  }
}

export function searchMemory(query: string, options?: { project?: string | null; limit?: number; type?: string; minConfidence?: number }): MemoryFragment[] {
  try {
    const db = getDb();
    const opts: { project?: string | null; topK?: number; type?: FragmentType; minConfidence?: number } = {};
    // Distinguish "no project arg" (search everywhere) from an explicit null
    // (global-scope only → project IS NULL). Only an absent arg omits the filter.
    if (options && "project" in options && options.project !== undefined) {
      opts.project = options.project;
    }
    if (options?.limit !== undefined) {
      opts.topK = options.limit;
    }
    if (options?.type) {
      opts.type = options.type as FragmentType;
    }
    if (options?.minConfidence !== undefined) {
      opts.minConfidence = options.minConfidence;
    }
    return store.searchMemories(db, query, opts);
  } catch (err) {
    logger.warn("searchMemory failed", { error: String(err) });
    return [];
  }
}

export function filterByProjectFromDb(project: string | null): MemoryFragment[] {
  try {
    const db = getDb();
    // Pass null THROUGH (not `|| undefined`) so a global-scope request maps to
    // `project IS NULL`. `|| undefined` dropped the filter entirely, leaking
    // every project's fragments into what should be global-only.
    return store.searchMemories(db, "", { project, topK: 1000 });
  } catch (err) {
    logger.warn("filterByProjectFromDb failed", { error: String(err) });
    return [];
  }
}

export function filterByProject(fragments: MemoryFragment[], currentProject: string | null): MemoryFragment[] {
  const project = (typeof currentProject === 'string')
    ? currentProject.trim().toLowerCase() || null
    : null;

  if (!project) {
    return fragments.filter(f => f.project === null || f.project === undefined);
  }
  return fragments.filter(f =>
    (f.project && f.project.toLowerCase() === project) ||
    (f.project === null || f.project === undefined)
  );
}

/**
 * Blended recall priority: confidence (how trusted) × recency (how fresh).
 * Single source of truth for BOTH context-injection ordering (system-prompt.ts)
 * and query=null recall here — so the injected memory blob is ranked by the same
 * formula the README documents, not by confidence alone.
 */
export function injectionScore(fragment: MemoryFragment): number {
  const confidence = fragment.confidence;
  const daysSinceCreated = (Date.now() - new Date(fragment.created).getTime()) / 86400000;
  const recency = Math.max(0, 1 - daysSinceCreated / 180);
  return confidence * 0.7 + recency * 0.3;
}

export interface GraphNode {
  fragment: MemoryFragment;
  depth: number;
  score: number;
}

/**
 * Bounded-depth traversal of the relations graph from a root fragment (roadmap
 * A3). BFS to `maxDepth` (default 2), at most `fanout` (default 5) edges expanded
 * per node — ordered by target confidence so the strongest links win the budget —
 * with a `0.6^depth` distance penalty applied to each node's confidence. The root
 * is excluded; each reachable fragment appears once at its shallowest depth.
 * LLM-free, pure SQLite over the existing relations table.
 */
export function expandGraph(rootId: string, maxDepth = 2, fanout = 5): GraphNode[] {
  try {
    const db = getDb();
    const rootRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(rootId) as
      | { id: number }
      | undefined;
    if (!rootRow) return [];

    const visited = new Set<string>([rootId]);
    const out: GraphNode[] = [];
    let frontier: { legacyId: string; internalId: number }[] = [{ legacyId: rootId, internalId: rootRow.id }];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: { legacyId: string; internalId: number }[] = [];
      for (const node of frontier) {
        const rels = db.prepareCached(
          `SELECT m.id as tid, m.legacy_id as tlegacy
           FROM relations r JOIN memories m ON m.id = r.target_id
           WHERE r.source_id = ?
           ORDER BY m.confidence DESC
           LIMIT ?`,
        ).all(node.internalId, fanout) as { tid: number; tlegacy: string }[];

        for (const rel of rels) {
          if (visited.has(rel.tlegacy)) continue;
          visited.add(rel.tlegacy);
          const frag = getFragmentById(rel.tlegacy);
          if (!frag) continue;
          out.push({ fragment: frag, depth, score: frag.confidence * Math.pow(0.6, depth) });
          nextFrontier.push({ legacyId: rel.tlegacy, internalId: rel.tid });
        }
      }
      frontier = nextFrontier;
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  } catch (err) {
    logger.warn("expandGraph failed", { error: String(err) });
    return [];
  }
}

export async function searchAndSortFragments(fragments: MemoryFragment[], query: string | null = null, topK = 30): Promise<MemoryFragment[]> {
  logger.flow("search", "start", { query: query?.slice(0, 50), topK, totalFragments: fragments.length });
  const nowDate = new Date().toISOString();

  if (!query) {
    const sorted = [...fragments]
      .sort((a, b) => injectionScore(b) - injectionScore(a))
      .slice(0, topK);

    sorted.forEach(frag => { frag.lastAccessed = nowDate; });
    return sorted;
  }

  try {
    const db = getDb();
    const ftsResults = store.searchMemories(db, query, { topK });
    const queryLower = query.toLowerCase();
    const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.length > 1));
    const inMemoryHits = fragments.filter(frag => {
      const fragLower = frag.fragment.toLowerCase();
      if (fragLower.includes(queryLower)) return true;
      if (queryWords.size > 0) {
        const fragWords = new Set(fragLower.split(/\s+/).filter(w => w.length > 1));
        let hits = 0;
        for (const w of queryWords) { if (fragWords.has(w)) hits++; }
        return hits / queryWords.size >= 0.5;
      }
      return false;
    });
    const combined = [...inMemoryHits];
    const seenIds = new Set(inMemoryHits.map(f => f.id));
    for (const r of ftsResults) {
      if (!seenIds.has(r.id)) { combined.push(r); seenIds.add(r.id); }
    }
    if (combined.length > 0) {
      logger.flow("search", "combined_results", { fts: ftsResults.length, inMemory: inMemoryHits.length });
      const inMemorySet = new Set(inMemoryHits.map(f => f.id));
      combined.sort((a, b) => {
        const aInMem = inMemorySet.has(a.id) ? 1 : 0;
        const bInMem = inMemorySet.has(b.id) ? 1 : 0;
        if (aInMem !== bInMem) return bInMem - aInMem;
        return injectionScore(b) - injectionScore(a);
      });
      combined.forEach(frag => { frag.lastAccessed = nowDate; });
      return combined.slice(0, topK);
    }
  } catch (err) {
    logger.warn("FTS search failed", { error: String(err) });
  }

  logger.flow("search", "fallback");
  const queryLower2 = query.toLowerCase();
  const queryWords2 = new Set(queryLower2.split(/\s+/).filter(w => w.length > 1));
  const scored = [...fragments].map(frag => {
    const fragLower = frag.fragment.toLowerCase();
    let matchScore = 0;
    if (fragLower.includes(queryLower2)) {
      matchScore = 2;
    } else if (queryWords2.size > 0) {
      const fragWords = new Set(fragLower.split(/\s+/).filter(w => w.length > 1));
      for (const w of queryWords2) {
        if (fragWords.has(w)) matchScore++;
      }
      matchScore = matchScore / queryWords2.size;
    }
    return { frag, score: matchScore + injectionScore(frag) * 0.01 };
  });
  scored.sort((a, b) => b.score - a.score);
  const fallback = scored.slice(0, topK).map(s => s.frag);

  fallback.forEach(frag => { frag.lastAccessed = nowDate; });
  return fallback;
}

export function filterFragments(
  fragments: MemoryFragment[],
  options: {
    minConfidence?: number;
    afterDate?: string;
    beforeDate?: string;
  } = {}
): MemoryFragment[] {
  let result = fragments;

  if (options.minConfidence !== undefined && options.minConfidence !== null) {
    result = result.filter(f => f.confidence >= options.minConfidence!);
  }

  if (options.afterDate) {
    const after = new Date(options.afterDate);
    if (!isNaN(after.getTime())) {
      result = result.filter(f => {
        const created = new Date(f.created);
        return !isNaN(created.getTime()) && created >= after;
      });
    }
  }

  if (options.beforeDate) {
    const before = new Date(options.beforeDate);
    if (!isNaN(before.getTime())) {
      result = result.filter(f => {
        const created = new Date(f.created);
        return !isNaN(created.getTime()) && created <= before;
      });
    }
  }

  return result;
}

export function formatMemoryForLLM(fragments: MemoryFragment[], currentProject: string | null = null): string {
  const projectHeader = currentProject ? ` (${currentProject})` : "";

  if (fragments.length === 0) {
    return `## Memory Fragments${projectHeader}\n---\n(no fragments)\n---`;
  }

  const lines = fragments.map(frag => {
    const scopeTag = frag.project || "global";
    const summary = frag.description || frag.title;
    return `[${frag.id}] [${scopeTag}] ${frag.title} — ${summary}`;
  });

  return `## Memory Fragments${projectHeader}\n---\n${lines.join("\n")}\n---`;
}

export function formatMemoryDetail(fragment: MemoryFragment | null): string {
  if (!fragment) {
    return "Fragment not found.";
  }

  const barCount = Math.round(fragment.confidence / 0.2);
  const confidenceBar = "█".repeat(barCount) + "░".repeat(5 - barCount);
  const sourceIcon = fragment.source === "ai" ? "🤖" : "👤";
  const scopeTag = fragment.project ? `[${fragment.project}]` : "[global]";

  let detail = `=== MEMORY FRAGMENT DETAIL ===\n`;
  detail += `ID: [${fragment.id}] ${confidenceBar} (${sourceIcon}) ${scopeTag}\n`;
  detail += `Title: ${fragment.title}\n`;
  if (fragment.description && fragment.description !== fragment.title) {
    detail += `Summary: ${fragment.description}\n`;
  }
  detail += `Created: ${fragment.created} | Confidence: ${fragment.confidence.toFixed(2)}\n`;
  if (fragment.tags && fragment.tags.length > 0) {
    detail += `Tags: ${fragment.tags.join(", ")}\n`;
  }
  if (fragment.associatedWith && fragment.associatedWith.length > 0) {
    detail += `Related: ${fragment.associatedWith.join(", ")}\n`;
  }
  if (fragment.relations && fragment.relations.length > 0) {
    detail += `Relations:\n`;
    for (const rel of fragment.relations) {
      detail += `  ${rel.type} → [${rel.id}]${rel.note ? ` — ${rel.note}` : ""}\n`;
    }
  }
  if (fragment.positive_feedback > 0 || fragment.negative_feedback > 0) {
    detail += `Feedback: ${fragment.positive_feedback || 0} positive, ${fragment.negative_feedback || 0} negative\n`;
  }
  if (fragment.refinement_count > 0) {
    detail += `Refinements: ${fragment.refinement_count}\n`;
  }
  if (fragment.parent_id) {
    detail += `Refined from: [${fragment.parent_id}]\n`;
  }
  if (fragment.child_ids && fragment.child_ids.length > 0) {
    detail += `Refined into: ${fragment.child_ids.map(id => `[${id}]`).join(", ")}\n`;
  }
  detail += `--- CONTENT ---\n${fragment.fragment}\n==============`;

  return detail;
}

export function calculateStats(fragments: MemoryFragment[], project: string | null = null): MemoryStats {
  const filtered = project
    ? filterByProject(fragments, project)
    : fragments;

  if (filtered.length === 0) {
    return {
      total: 0,
      avg_confidence: 0,
      by_source: {},
      by_project: {},
      low_confidence: 0,
      high_confidence: 0,
    };
  }

  const avgConf = filtered.reduce((sum, f) => sum + f.confidence, 0) / filtered.length;
  const bySource: Record<string, number> = {};
  const byProject: Record<string, number> = {};

  for (const f of filtered) {
    bySource[f.source] = (bySource[f.source] || 0) + 1;
    const scope = f.project || "global";
    byProject[scope] = (byProject[scope] || 0) + 1;
  }

  return {
    total: filtered.length,
    avg_confidence: Math.round(avgConf * 100) / 100,
    by_source: bySource,
    by_project: byProject,
    low_confidence: filtered.filter(f => f.confidence < 0.3).length,
    high_confidence: filtered.filter(f => f.confidence > 0.8).length,
  };
}

export function formatStats(stats: MemoryStats): string {
  let output = `## Memory Stats\n`;
  output += `Total: ${stats.total} fragments | Avg confidence: ${stats.avg_confidence}\n`;
  if (stats.total > 0) {
    output += `High confidence (>0.8): ${stats.high_confidence} | Low (<0.3): ${stats.low_confidence}\n`;
    const sources = Object.entries(stats.by_source).map(([k, v]) => `${k}: ${v}`).join(", ");
    output += `Sources: ${sources}\n`;
    const projects = Object.entries(stats.by_project).map(([k, v]) => `${k}: ${v}`).join(", ");
    output += `Projects: ${projects}\n`;
  }
  return output;
}

export function auditMemory(fragments: MemoryFragment[]): AuditResult {
  const issues: string[] = [];
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const f of fragments) {
    if (ids.has(f.id)) {
      duplicates.push(f.id);
    }
    ids.add(f.id);

    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
      issues.push(`Fragment [${f.id}] has invalid confidence: ${f.confidence}`);
    }

    if (!f.fragment || typeof f.fragment !== "string") {
      issues.push(`Fragment [${f.id}] has missing or invalid fragment text`);
    }

    if (f.associatedWith) {
      for (const assocId of f.associatedWith) {
        if (!ids.has(assocId) && !fragments.find(x => x.id === assocId)) {
          issues.push(`Fragment [${f.id}] references non-existent associated fragment [${assocId}]`);
        }
      }
    }

    if (f.relations) {
      for (const rel of f.relations) {
        if (!ids.has(rel.id) && !fragments.find(x => x.id === rel.id)) {
          issues.push(`Fragment [${f.id}] has relation to non-existent fragment [${rel.id}]`);
        }
      }
    }
  }

  if (duplicates.length > 0) {
    issues.push(`Duplicate IDs found: ${duplicates.join(", ")}`);
  }

  return {
    total_fragments: fragments.length,
    issues_found: issues.length,
    issues,
    healthy: issues.length === 0,
  };
}

export function formatAuditReport(result: AuditResult): string {
  let output = `## Memory Audit\n`;
  output += `Total fragments: ${result.total_fragments} | Issues: ${result.issues_found}\n`;
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      output += `  ! ${issue}\n`;
    }
  } else {
    output += `All clear — no issues found.\n`;
  }
  return output;
}
