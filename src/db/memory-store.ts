import crypto from "crypto";
import { redactSecrets } from "../memory/privacy.js";
import { LemmaDB } from "./database.js";
import { logger } from "../logger.js";
import { sanitizeFtsQuery } from "./fts.js";
import { loadConfig } from "../memory/config.js";
import type { MemoryFragment, MemoryRelation, FragmentType, MemoryStats } from "../types.js";

function generateLegacyId(): string {
  return "m" + crypto.randomBytes(6).toString("hex");
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Canonical project key: trimmed + lowercased, or null for global.
 * Applied on every write so that "Lemma", "lemma" and "  Lemma  " collapse to
 * one bucket; getMemoryStats queries with `lower(project) = ?` to match.
 */
function normalizeProject(project: string | null | undefined): string | null {
  if (!project || typeof project !== "string") return null;
  const trimmed = project.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function rowToFragment(row: Record<string, any>, relations: MemoryRelation[] = []): MemoryFragment {
  return {
    id: row.legacy_id,
    title: row.title,
    description: row.description ?? "",
    fragment: row.fragment,
    project: row.project ?? null,
    confidence: row.confidence,
    source: row.source,
    created: row.created_at,
    lastAccessed: row.last_accessed_at ?? row.created_at,
    accessed: row.access_count,
    tags: parseJsonArray(row.context_tags),
    associatedWith: parseJsonArray(row.associated_with),
    relations,
    negativeHits: row.negative_hits,
    quality_score: row.quality_score,
    refinement_count: row.refinement_count,
    parent_id: row.parent_legacy_id ?? null,
    child_ids: row.child_legacy_ids ?? [],
    session_id: row.session_id ?? null,
    task_type: row.task_type ?? null,
    outcome: null,
    positive_feedback: row.positive_feedback,
    negative_feedback: row.negative_feedback,
    last_refined: row.last_refined ?? null,
    type: row.type,
    related_guides: parseJsonArray(row.related_guides),
    distill_candidate: row.distill_candidate === 1,
    invalidated_at: row.invalidated_at ?? null,
  };
}

function resolveId(lemmaDb: LemmaDB, idOrLegacy: string | number): number | null {
  if (typeof idOrLegacy === "number") {
    return idOrLegacy;
  }
  const parsed = parseInt(idOrLegacy, 10);
  if (!isNaN(parsed) && String(parsed) === idOrLegacy.trim()) {
    const row = lemmaDb
      .prepareCached("SELECT id FROM memories WHERE id = ?")
      .get(parsed) as { id: number } | undefined;
    if (row) return row.id;
  }
  const row = lemmaDb
    .prepareCached("SELECT id FROM memories WHERE legacy_id = ?")
    .get(idOrLegacy) as { id: number } | undefined;
  return row?.id ?? null;
}

export function addMemory(
  lemmaDb: LemmaDB,
  fragment: string,
  source: "user" | "ai",
  title?: string,
  project?: string | null,
  description?: string,
  type?: FragmentType,
): { id: number; legacy_id: string } {
  const legacyId = generateLegacyId();
  const resolvedTitle =
    title ?? (fragment.length > 40 ? fragment.substring(0, 40) + "..." : fragment);
  const resolvedDescription =
    description ??
    (fragment.length > 150 ? fragment.substring(0, 150) + "..." : fragment);
  const resolvedType = type ?? "fact";

  const result = lemmaDb
    .prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(legacyId, resolvedTitle, fragment, resolvedDescription, resolvedType, normalizeProject(project), source);

  const id = Number(result.lastInsertRowid);
  logger.info("Memory added", { id, legacy_id: legacyId });
  return { id, legacy_id: legacyId };
}

export function getMemoryById(
  lemmaDb: LemmaDB,
  idOrLegacy: string | number,
): MemoryFragment | null {
  const row = lemmaDb
    .prepareCached(
      `SELECT m.*, p.legacy_id as parent_legacy_id
       FROM memories m
       LEFT JOIN memories p ON m.parent_id = p.id
       WHERE m.id = ? OR m.legacy_id = ?`,
    )
    .get(
      typeof idOrLegacy === "number" ? idOrLegacy : parseInt(idOrLegacy, 10) || 0,
      String(idOrLegacy),
    ) as Record<string, any> | undefined;

  if (!row) return null;

  const id = row.id as number;

  const childRows = lemmaDb
    .prepareCached("SELECT legacy_id FROM memories WHERE parent_id = ?")
    .all(id) as { legacy_id: string }[];
  row.child_legacy_ids = childRows.map((c) => c.legacy_id);

  const relRows = lemmaDb
    .prepareCached(
      `SELECT r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
       FROM relations r
       JOIN memories m ON m.id = r.target_id
       WHERE r.source_id = ?`,
    )
    .all(id) as {
    target_legacy_id: string;
    type: string;
    note: string | null;
    created_at: string;
  }[];

  const relations: MemoryRelation[] = relRows.map((r) => ({
    id: r.target_legacy_id,
    type: r.type as MemoryRelation["type"],
    note: r.note ?? undefined,
    created: r.created_at,
  }));

  return rowToFragment(row, relations);
}

export function updateMemory(
  lemmaDb: LemmaDB,
  idOrLegacy: string | number,
  updates: Partial<{
    title: string;
    fragment: string;
    description: string;
    confidence: number;
    type: FragmentType;
    project: string | null;
    context_tags: string[];
    quality_score: number | null;
    distill_candidate: boolean;
    session_id: string | null;
    task_type: string | null;
    related_guides: string[];
    access_count: number;
    associated_with: string[];
    invalidated_at: string | null;
  }>,
): boolean {
  const id = resolveId(lemmaDb, idOrLegacy);
  if (id === null) return false;

  const setClauses: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) {
    setClauses.push("title = ?");
    params.push(redactSecrets(updates.title).redacted);
  }
  if (updates.fragment !== undefined) {
    setClauses.push("fragment = ?");
    params.push(redactSecrets(updates.fragment).redacted);
  }
  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    params.push(redactSecrets(updates.description).redacted);
  }
  if (updates.confidence !== undefined) {
    setClauses.push("confidence = ?");
    params.push(updates.confidence);
  }
  if (updates.type !== undefined) {
    setClauses.push("type = ?");
    params.push(updates.type);
  }
  if (updates.project !== undefined) {
    setClauses.push("project = ?");
    params.push(normalizeProject(updates.project));
  }
  if (updates.context_tags !== undefined) {
    setClauses.push("context_tags = ?");
    params.push(JSON.stringify(updates.context_tags));
  }
  if (updates.quality_score !== undefined) {
    setClauses.push("quality_score = ?");
    params.push(updates.quality_score);
  }
  if (updates.distill_candidate !== undefined) {
    setClauses.push("distill_candidate = ?");
    params.push(updates.distill_candidate ? 1 : 0);
  }
  if (updates.session_id !== undefined) {
    setClauses.push("session_id = ?");
    params.push(updates.session_id);
  }
  if (updates.task_type !== undefined) {
    setClauses.push("task_type = ?");
    params.push(updates.task_type);
  }
  if (updates.related_guides !== undefined) {
    setClauses.push("related_guides = ?");
    params.push(updates.related_guides.length > 0 ? JSON.stringify(updates.related_guides) : null);
  }
  if (updates.access_count !== undefined) {
    setClauses.push("access_count = ?");
    params.push(updates.access_count);
  }
  if (updates.associated_with !== undefined) {
    setClauses.push("associated_with = ?");
    params.push(updates.associated_with.length > 0 ? JSON.stringify(updates.associated_with) : null);
  }
  if (updates.invalidated_at !== undefined) {
    setClauses.push("invalidated_at = ?");
    params.push(updates.invalidated_at);
  }

  if (setClauses.length === 0) return false;

  setClauses.push("updated_at = datetime('now')");
  params.push(id);

  const sql = `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`;
  const result = lemmaDb.prepareCached(sql).run(...params);
  return result.changes > 0;
}

export function deleteMemory(
  lemmaDb: LemmaDB,
  idOrLegacy: string | number,
): boolean {
  const id = resolveId(lemmaDb, idOrLegacy);
  if (id === null) return false;

  const result = lemmaDb
    .prepareCached("DELETE FROM memories WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

/**
 * B1 — capacity-driven Heat eviction. When the live-fragment count exceeds
 * `maxFragments`, move the coldest fragments (lowest Heat = injectionScore
 * `confidence·0.7 + recency·0.3`) into fragments_archive and remove them from the
 * working set. Never a hard delete of content — the archive keeps it, restorable.
 * Returns the number evicted. Localized (survey O7): a single bounded query +
 * batched moves, never a whole-memory rebuild.
 */
export function evictColdFragments(lemmaDb: LemmaDB, maxFragments: number): number {
  const { db } = lemmaDb;
  const total = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
  if (total <= maxFragments) return 0;
  const toEvict = total - maxFragments;

  return db.transaction(() => {
    // Coldest first by Heat = injectionScore (confidence·0.7 + recency·0.3),
    // recency linear over 180 days. Ties broken by oldest last-access.
    const cold = db.prepare(
      `SELECT id,
         confidence * 0.7
         + MAX(0.0, 1.0 - (julianday('now') - julianday(created_at)) / 180.0) * 0.3 AS heat
       FROM memories
       ORDER BY heat ASC, COALESCE(last_accessed_at, created_at) ASC
       LIMIT ?`,
    ).all(toEvict) as { id: number; heat: number }[];

    const archive = lemmaDb.prepareCached(
      `INSERT INTO fragments_archive (legacy_id, title, fragment, description, type, project, confidence, source, context_tags, created_at, heat)
       SELECT legacy_id, title, fragment, description, type, project, confidence, source, context_tags, created_at, ?
       FROM memories WHERE id = ?`,
    );
    const remove = lemmaDb.prepareCached("DELETE FROM memories WHERE id = ?");

    let evicted = 0;
    for (const row of cold) {
      archive.run(row.heat, row.id);
      remove.run(row.id);
      evicted++;
    }
    logger.info("Heat eviction complete", { evicted, total, maxFragments });
    return evicted;
  })();
}

/** Count of archived (evicted) fragments. */
export function getArchiveCount(lemmaDb: LemmaDB): number {
  return (lemmaDb.prepareCached("SELECT COUNT(*) AS c FROM fragments_archive").get() as { c: number }).c;
}

/** Restore an evicted fragment from the archive back into the working set. */
export function restoreFromArchive(lemmaDb: LemmaDB, legacyId: string): boolean {
  const { db } = lemmaDb;
  return db.transaction(() => {
    const row = lemmaDb.prepareCached(
      "SELECT * FROM fragments_archive WHERE legacy_id = ? ORDER BY archived_at DESC LIMIT 1",
    ).get(legacyId) as Record<string, any> | undefined;
    if (!row) return false;
    // Skip if it somehow already exists live (avoid a UNIQUE(legacy_id) clash).
    const exists = lemmaDb.prepareCached("SELECT 1 FROM memories WHERE legacy_id = ?").get(legacyId);
    if (exists) return false;
    lemmaDb.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, confidence, source, context_tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.legacy_id, row.title, row.fragment, row.description, row.type, row.project, row.confidence, row.source, row.context_tags, row.created_at);
    lemmaDb.prepareCached("DELETE FROM fragments_archive WHERE legacy_id = ?").run(legacyId);
    return true;
  })();
}

export interface FragmentHistoryEntry {
  title: string;
  fragment: string;
  description: string | null;
  confidence: number;
  type: string;
  changed_at: string;
}

/** B2/N9: hide a fragment from recall without deleting it (logical invalidation). */
export function invalidateMemory(lemmaDb: LemmaDB, idOrLegacy: string | number): boolean {
  const id = resolveId(lemmaDb, idOrLegacy);
  if (id === null) return false;
  const result = lemmaDb
    .prepareCached("UPDATE memories SET invalidated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND invalidated_at IS NULL")
    .run(id);
  return result.changes > 0;
}

/** Reverse a logical invalidation — the fragment returns to recall. */
export function restoreMemory(lemmaDb: LemmaDB, idOrLegacy: string | number): boolean {
  const id = resolveId(lemmaDb, idOrLegacy);
  if (id === null) return false;
  const result = lemmaDb
    .prepareCached("UPDATE memories SET invalidated_at = NULL, updated_at = datetime('now') WHERE id = ? AND invalidated_at IS NOT NULL")
    .run(id);
  return result.changes > 0;
}

/** Prior content versions of a fragment, newest first (populated by the AFTER UPDATE trigger). */
export function getFragmentHistory(lemmaDb: LemmaDB, idOrLegacy: string | number, limit = 20): FragmentHistoryEntry[] {
  const id = resolveId(lemmaDb, idOrLegacy);
  if (id === null) return [];
  return lemmaDb
    .prepareCached(
      `SELECT title, fragment, description, confidence, type, changed_at
       FROM fragment_history WHERE memory_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?`,
    )
    .all(id, limit) as FragmentHistoryEntry[];
}

export interface MemorySearchTrace {
  method: "fts5_bm25" | "confidence_browse" | "substring_fallback";
  scores: Map<string, number>;
}

export function searchMemories(
  lemmaDb: LemmaDB,
  query: string,
  options?: {
    project?: string | null;
    type?: FragmentType;
    minConfidence?: number;
    topK?: number;
    afterDate?: string;
    beforeDate?: string;
    all?: boolean;
    includeInvalidated?: boolean;
    onTrace?: (trace: MemorySearchTrace) => void;
  },
): MemoryFragment[] {
  const topK = options?.topK ?? 20;
  const conditions: string[] = [];
  const params: any[] = [];

  // B2/N9: logically-invalidated fragments are hidden from recall by default.
  if (!options?.includeInvalidated) {
    conditions.push("m.invalidated_at IS NULL");
  }

  if (options?.type) {
    conditions.push("m.type = ?");
    params.push(options.type);
  }
  if (options?.minConfidence !== undefined) {
    conditions.push("m.confidence >= ?");
    params.push(options.minConfidence);
  }
  if (options?.afterDate) {
    conditions.push("m.created_at >= ?");
    params.push(options.afterDate);
  }
  if (options?.beforeDate) {
    conditions.push("m.created_at <= ?");
    params.push(options.beforeDate);
  }

  if (!options?.all) {
    if (options?.project !== undefined) {
      if (options.project === null) {
        conditions.push("m.project IS NULL");
      } else {
        // Normalize to the canonical project key (trim + lowercase) so the search
        // side matches the write side. Without this a search scoped to "Lemma"
        // misses fragments stored under the normalized "lemma".
        conditions.push("m.project = ?");
        params.push(normalizeProject(options.project));
      }
    }
  }

  const whereClause =
    conditions.length > 0 ? " AND " + conditions.join(" AND ") : "";

  const ftsQuery = query ? sanitizeFtsQuery(query) : "";
  let method: MemorySearchTrace["method"] = ftsQuery ? "fts5_bm25" : "confidence_browse";

  let sql: string;
  let sqlParams: any[];

  if (ftsQuery) {
    sql = `SELECT m.*, p.legacy_id as parent_legacy_id${options?.onTrace ? ", bm25(memory_fts) AS recall_rank" : ""}
           FROM memory_fts fts
           JOIN memories m ON m.id = fts.rowid
           LEFT JOIN memories p ON m.parent_id = p.id
           WHERE memory_fts MATCH ?${whereClause}
           ORDER BY bm25(memory_fts)
           LIMIT ?`;
    sqlParams = [ftsQuery, ...params, topK];
  } else {
    sql = `SELECT m.*, p.legacy_id as parent_legacy_id
           FROM memories m
           LEFT JOIN memories p ON m.parent_id = p.id
           WHERE 1=1${whereClause}
           ORDER BY m.confidence DESC
           LIMIT ?`;
    sqlParams = [...params, topK];
  }

  let rows: Record<string, any>[];
  try {
    rows = lemmaDb.prepareCached(sql).all(...sqlParams) as Record<string, any>[];
  } catch (err) {
    logger.warn("FTS search failed, falling back to LIKE", { error: String(err) });
    method = "substring_fallback";
    const likePattern = `%${query.trim()}%`;
    const likeConditions = [
      ...conditions,
      "(m.title LIKE ? OR m.fragment LIKE ? OR m.description LIKE ?)",
    ];
    const likeWhere =
      " WHERE " + likeConditions.join(" AND ");
    sql = `SELECT m.*, p.legacy_id as parent_legacy_id
           FROM memories m
           LEFT JOIN memories p ON m.parent_id = p.id${likeWhere}
           ORDER BY m.confidence DESC
           LIMIT ?`;
    rows = lemmaDb.prepareCached(sql).all(
      ...params,
      likePattern,
      likePattern,
      likePattern,
      topK,
    ) as Record<string, any>[];
  }

  options?.onTrace?.({ method, scores: new Map(rows.map(row => [row.legacy_id, method === "fts5_bm25" ? row.recall_rank : row.confidence])) });
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id as number);

  const placeholders = ids.map(() => "?").join(",");

  const childrenRows = lemmaDb
    .prepareCached(
      `SELECT parent_id, legacy_id FROM memories WHERE parent_id IN (${placeholders})`,
    )
    .all(...ids) as { parent_id: number; legacy_id: string }[];

  const childrenMap = new Map<number, string[]>();
  for (const cr of childrenRows) {
    const list = childrenMap.get(cr.parent_id) ?? [];
    list.push(cr.legacy_id);
    childrenMap.set(cr.parent_id, list);
  }

  const relRows = lemmaDb
    .prepareCached(
      `SELECT r.source_id, r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
       FROM relations r
       JOIN memories m ON m.id = r.target_id
       WHERE r.source_id IN (${placeholders})`,
    )
    .all(...ids) as {
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

  return rows.map((row) => {
    const fragment = rowToFragment(row, relationsMap.get(row.id) ?? []);
    fragment.child_ids = childrenMap.get(row.id) ?? [];
    return fragment;
  });
}

export function addRelation(
  lemmaDb: LemmaDB,
  sourceId: number,
  targetId: number,
  type: string,
  note?: string,
): boolean {
  try {
    lemmaDb
      .prepareCached(
        "INSERT INTO relations (source_id, target_id, type, note) VALUES (?, ?, ?, ?)",
      )
      .run(sourceId, targetId, type, note ?? null);
    return true;
  } catch (err) {
    logger.warn("Failed to add relation", { sourceId, targetId, type, error: String(err) });
    return false;
  }
}

export function getRelations(
  lemmaDb: LemmaDB,
  memoryId: number,
): MemoryRelation[] {
  const rows = lemmaDb
    .prepareCached(
      `SELECT r.type, r.note, r.created_at, m.legacy_id as target_legacy_id
       FROM relations r
       JOIN memories m ON m.id = r.target_id
       WHERE r.source_id = ?`,
    )
    .all(memoryId) as {
    target_legacy_id: string;
    type: string;
    note: string | null;
    created_at: string;
  }[];

  return rows.map((r) => ({
    id: r.target_legacy_id,
    type: r.type as MemoryRelation["type"],
    note: r.note ?? undefined,
    created: r.created_at,
  }));
}

export function boostConfidence(
  lemmaDb: LemmaDB,
  id: number,
  amount: number,
): void {
  lemmaDb
    .prepareCached(
      `UPDATE memories SET confidence = MIN(1.0, confidence + ?),
       access_count = access_count + 1,
       access_window = access_window + 1,
       last_accessed_at = datetime('now'),
       updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(amount, id);
}

const DECAY_INTERVAL_HOURS = 24;

export function shouldRunDecay(lemmaDb: LemmaDB): boolean {
  const row = lemmaDb.prepareCached(
    `SELECT applied_at FROM schema_version WHERE version = -1`
  ).get() as { applied_at: string } | undefined;

  if (!row) return true;

  const lastDecay = new Date(row.applied_at).getTime();
  const hoursSince = (Date.now() - lastDecay) / (1000 * 60 * 60);
  return hoursSince >= DECAY_INTERVAL_HOURS;
}

export function markDecayRun(lemmaDb: LemmaDB): void {
  lemmaDb.prepareCached(
    `INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (-1, datetime('now'))`
  ).run();
}

const FRAGMENT_TYPES = ["fact", "pattern", "lesson", "warning", "context"] as const;

export function decayMemories(lemmaDb: LemmaDB): number {
  if (!shouldRunDecay(lemmaDb)) {
    logger.info("Memory decay skipped (too recent)");
    return 0;
  }

  const cfg = loadConfig();
  const decayCfg = cfg.decay ?? { model: "linear" as const, half_life_days: undefined };
  const { db } = lemmaDb;

  return db.transaction(() => {
    let changed = 0;

    if (decayCfg.model === "ebbinghaus") {
      // Exponential, type-aware retention keyed off the true elapsed time since
      // the last decay run — so a long absence forgets more (Ebbinghaus), while
      // access (access_count > 0 this window) fully resets the fragment.
      const row = lemmaDb.prepareCached(
        `SELECT applied_at FROM schema_version WHERE version = -1`,
      ).get() as { applied_at: string } | undefined;
      const lastMs = row ? new Date(row.applied_at).getTime() : Date.now() - DECAY_INTERVAL_HOURS * 3600 * 1000;
      const elapsedDays = Math.max(0.5, (Date.now() - lastMs) / 86400000);
      const halfLives = decayCfg.half_life_days ?? {};

      for (const type of FRAGMENT_TYPES) {
        const halfLife = (halfLives as Record<string, number>)[type] || 60;
        const retention = Math.pow(0.5, elapsedDays / halfLife);
        const r = lemmaDb.prepareCached(
          `UPDATE memories SET confidence = MAX(0, confidence * ?), updated_at = datetime('now')
           WHERE access_window = 0 AND confidence > 0 AND type = ?`,
        ).run(retention, type);
        changed += r.changes;
      }
    } else {
      // Linear (default, unchanged): flat −0.002 for every unaccessed fragment.
      const result = lemmaDb.prepareCached(
        `UPDATE memories SET confidence = MAX(0, confidence - 0.002),
         updated_at = datetime('now')
         WHERE access_window = 0 AND confidence > 0`,
      ).run();
      changed = result.changes;
    }

    // Reset only the decay window, NOT the lifetime access_count. access_count is
    // what analytics/scoring read as total usage; zeroing it here (the old bug)
    // made every fragment look "never accessed" after each cycle.
    lemmaDb.prepareCached("UPDATE memories SET access_window = 0").run();
    markDecayRun(lemmaDb);
    logger.info("Memory decay complete", { decayed: changed, model: decayCfg.model });
    return changed;
  })();
}

export function getMemoryStats(
  lemmaDb: LemmaDB,
  project?: string | null,
): MemoryStats {
  const hasProject = typeof project === "string" && project.trim() !== "";
  const projectWhere = hasProject ? " WHERE lower(project) = ?" : "";
  const projectParams = hasProject ? [project!.trim().toLowerCase()] : [];

  const row = lemmaDb.prepareCached(
    `SELECT
       COUNT(*) as total,
       COALESCE(AVG(confidence), 0) as avg_confidence,
       SUM(CASE WHEN confidence < 0.3 THEN 1 ELSE 0 END) as low_confidence,
       SUM(CASE WHEN confidence > 0.8 THEN 1 ELSE 0 END) as high_confidence
     FROM memories${projectWhere}`,
  ).get(...projectParams) as {
    total: number;
    avg_confidence: number;
    low_confidence: number;
    high_confidence: number;
  };

  const bySourceRows = lemmaDb.prepareCached(
    `SELECT source, COUNT(*) as count FROM memories${projectWhere} GROUP BY source`,
  ).all(...projectParams) as { source: string; count: number }[];

  const byProjectRows = lemmaDb.prepareCached(
    `SELECT COALESCE(project, '(global)') as project, COUNT(*) as count FROM memories${projectWhere} GROUP BY project`,
  ).all(...projectParams) as { project: string; count: number }[];

  return {
    total: row.total,
    avg_confidence: row.avg_confidence,
    by_source: Object.fromEntries(bySourceRows.map((r) => [r.source, r.count])),
    by_project: Object.fromEntries(byProjectRows.map((r) => [r.project, r.count])),
    low_confidence: row.low_confidence,
    high_confidence: row.high_confidence,
  };
}

export function mergeMemories(
  lemmaDb: LemmaDB,
  ids: number[],
  title: string,
  fragment: string,
  description?: string,
  consolidate = false,
): number | null {
  if (ids.length === 0) return null;

  const { db } = lemmaDb;
  return db.transaction(() => {
    const idSet = new Set(ids);

    const insertResult = addMemory(lemmaDb, fragment, "ai", title, null, description);
    const newId = insertResult.id;

    const placeholders = ids.map(() => "?").join(",");

    const outgoingRels = lemmaDb.prepareCached(
      `SELECT target_id, type, note FROM relations WHERE source_id IN (${placeholders})`,
    ).all(...ids) as { target_id: number; type: string; note: string | null }[];

    for (const rel of outgoingRels) {
      if (!idSet.has(rel.target_id)) {
        addRelation(lemmaDb, newId, rel.target_id, rel.type, rel.note ?? undefined);
      }
    }

    const incomingRels = lemmaDb.prepareCached(
      `SELECT source_id, type, note FROM relations WHERE target_id IN (${placeholders})`,
    ).all(...ids) as { source_id: number; type: string; note: string | null }[];

    for (const rel of incomingRels) {
      if (!idSet.has(rel.source_id)) {
        addRelation(lemmaDb, rel.source_id, newId, rel.type, rel.note ?? undefined);
      }
    }

    if (consolidate) {
      // Non-destructive: keep the sources but mark them superseded by the merged
      // fragment and heavily down-weight them, so recall/injection ignores them
      // yet nothing is lost and it's reversible (roadmap B3; SDFT; survey O4).
      for (const id of ids) {
        addRelation(lemmaDb, newId, id, "supersedes", "consolidated");
        lemmaDb.prepareCached(
          `UPDATE memories SET confidence = MIN(confidence, 0.1), updated_at = datetime('now') WHERE id = ?`,
        ).run(id);
      }
      logger.info("Memories consolidated (non-destructive)", { sourceIds: ids, newId });
    } else {
      const deleteStmt = lemmaDb.prepareCached("DELETE FROM memories WHERE id = ?");
      for (const id of ids) {
        deleteStmt.run(id);
      }
      logger.info("Memories merged", { sourceIds: ids, newId });
    }

    return newId;
  })();
}
