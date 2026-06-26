import os from "os";
import path from "path";
import crypto from "crypto";
import { TASK_GUIDE_MAP } from "./task-map.js";
import { logger } from "../logger.js";
import { getDb, setDataDir } from "../db/database.js";
import type { LemmaDB } from "../db/database.js";
import type { Guide, GuideSuggestion, SuggestResult } from "../types.js";

interface GuideUpdates {
  guide?: string;
  category?: string;
  description?: string;
  add_anti_patterns?: string[];
  add_pitfalls?: string[];
  superseded_by?: string;
  deprecated?: boolean;
}

let _guidesDir: string = path.join(os.homedir(), ".lemma");

export function setGuidesDir(dir: string): void {
  _guidesDir = dir;
  setDataDir(dir);
}

export function generateGuideId(): string {
  return "g" + crypto.randomUUID().replace(/-/g, "").substring(0, 12);
}

export function getToday(): string {
  return new Date().toISOString().split("T")[0] ?? "";
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

function rowToGuide(row: Record<string, unknown>, contexts: string[], learnings: string[]): Guide {
  return {
    id: String(row.id),
    guide: row.guide as string,
    category: row.category as string,
    description: (row.description as string) || "",
    usage_count: (row.usage_count as number) || 0,
    last_used: (row.last_used_at as string) || "",
    contexts,
    learnings,
    success_count: (row.success_count as number) || 0,
    failure_count: (row.failure_count as number) || 0,
    auto_usage_count: 0,
    anti_patterns: parseJsonArray(row.anti_patterns as string | null),
    known_pitfalls: parseJsonArray(row.pitfalls as string | null),
    last_refined: (row.last_refined as string) || null,
    depends_on: parseJsonArray(row.depends_on as string | null),
    enables: parseJsonArray(row.enables as string | null),
    superseded_by: (row.superseded_by as string) || null,
    deprecated: Boolean(row.deprecated),
    source_memories: parseJsonArray(row.source_memories as string | null),
    validated_by: parseJsonArray(row.validated_by as string | null),
  };
}

function loadGuideContexts(db: LemmaDB, guideId: number): string[] {
  const rows = db.prepareCached("SELECT context FROM guide_contexts WHERE guide_id = ?").all(guideId) as { context: string }[];
  return rows.map(r => r.context);
}

function loadGuideLearnings(db: LemmaDB, guideId: number): string[] {
  const rows = db.prepareCached("SELECT learning FROM guide_learnings WHERE guide_id = ?").all(guideId) as { learning: string }[];
  return rows.map(r => r.learning);
}

export function upsertGuideToDb(db: LemmaDB, g: Guide): void {
  const now = new Date().toISOString();
  const existing = db.prepareCached("SELECT id FROM guides WHERE guide = ? COLLATE NOCASE").get(g.guide) as { id: number } | undefined;

  let guideId: number;

  if (existing) {
    guideId = existing.id;
    db.prepareCached(`
      UPDATE guides SET
        category = ?, description = ?, usage_count = ?, success_count = ?, failure_count = ?,
        last_used_at = ?, anti_patterns = ?, pitfalls = ?, last_refined = ?,
        depends_on = ?, enables = ?, superseded_by = ?, deprecated = ?,
        source_memories = ?, validated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(
      g.category, g.description, g.usage_count, g.success_count, g.failure_count,
      g.last_used || now,
      g.anti_patterns.length > 0 ? JSON.stringify(g.anti_patterns) : null,
      g.known_pitfalls.length > 0 ? JSON.stringify(g.known_pitfalls) : null,
      g.last_refined || null,
      g.depends_on.length > 0 ? JSON.stringify(g.depends_on) : null,
      g.enables.length > 0 ? JSON.stringify(g.enables) : null,
      g.superseded_by || null,
      g.deprecated ? 1 : 0,
      g.source_memories.length > 0 ? JSON.stringify(g.source_memories) : null,
      g.validated_by.length > 0 ? JSON.stringify(g.validated_by) : null,
      now, guideId
    );
  } else {
    const result = db.prepareCached(`
      INSERT INTO guides (guide, category, description, usage_count, success_count, failure_count,
        last_used_at, anti_patterns, pitfalls, last_refined, depends_on, enables,
        superseded_by, deprecated, source_memories, validated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      g.guide, g.category, g.description, g.usage_count, g.success_count, g.failure_count,
      g.last_used || now,
      g.anti_patterns.length > 0 ? JSON.stringify(g.anti_patterns) : null,
      g.known_pitfalls.length > 0 ? JSON.stringify(g.known_pitfalls) : null,
      g.last_refined || null,
      g.depends_on.length > 0 ? JSON.stringify(g.depends_on) : null,
      g.enables.length > 0 ? JSON.stringify(g.enables) : null,
      g.superseded_by || null,
      g.deprecated ? 1 : 0,
      g.source_memories.length > 0 ? JSON.stringify(g.source_memories) : null,
      g.validated_by.length > 0 ? JSON.stringify(g.validated_by) : null,
      now, now
    );
    guideId = Number(result.lastInsertRowid);
    g.id = String(guideId);
  }

  db.prepareCached("DELETE FROM guide_contexts WHERE guide_id = ?").run(guideId);
  const insertCtx = db.prepareCached("INSERT OR IGNORE INTO guide_contexts (guide_id, context) VALUES (?, ?)");
  for (const ctx of g.contexts) {
    insertCtx.run(guideId, ctx);
  }

  db.prepareCached("DELETE FROM guide_learnings WHERE guide_id = ?").run(guideId);
  const insertLearning = db.prepareCached("INSERT OR IGNORE INTO guide_learnings (guide_id, learning) VALUES (?, ?)");
  for (const learning of g.learnings) {
    insertLearning.run(guideId, learning);
  }
}

export function createGuide(
  guide: string,
  category: string,
  description: string = "",
  contexts: string[] = [],
  learnings: string[] = []
): Guide {
  logger.flow("guide_create", "start", { guide, category });
  const result: Guide = {
    id: generateGuideId(),
    guide: guide.toLowerCase().trim(),
    category: category.toLowerCase().trim(),
    description: description.trim(),
    usage_count: 1,
    last_used: getToday(),
    contexts: contexts.map(c => c.toLowerCase().trim()).filter(Boolean),
    learnings: learnings.map(l => l.trim()).filter(Boolean),
    success_count: 0,
    failure_count: 0,
    auto_usage_count: 0,
    anti_patterns: [],
    known_pitfalls: [],
    last_refined: null,
    depends_on: [],
    enables: [],
    superseded_by: null,
    deprecated: false,
    source_memories: [],
    validated_by: [],
  };
  logger.flow("guide_create", "created", { id: result.id });
  return result;
}

export function getGuideFromDb(name: string): Guide | null {
  const db = getDb();
  const row = db.prepareCached("SELECT * FROM guides WHERE guide = ? COLLATE NOCASE").get(name.toLowerCase().trim()) as Record<string, unknown> | undefined;
  if (!row) return null;
  const guideId = Number(row.id);
  const contexts = loadGuideContexts(db, guideId);
  const learnings = loadGuideLearnings(db, guideId);
  return rowToGuide(row, contexts, learnings);
}

export function loadGuides(): Guide[] {
  logger.data("guides", "load_start");
  try {
    const db = getDb();
    const rows = db.prepareCached("SELECT * FROM guides ORDER BY usage_count DESC").all() as Record<string, unknown>[];

    const guides = rows.map(row => {
      const guideId = Number(row.id);
      const contexts = loadGuideContexts(db, guideId);
      const learnings = loadGuideLearnings(db, guideId);
      return rowToGuide(row, contexts, learnings);
    });

    logger.data("guides", "loaded", { count: guides.length });
    return guides;
  } catch (error: unknown) {
    logger.error("Error loading guides:", { error: (error as Error).message });
    return [];
  }
}

export function saveGuides(guides: Guide[], options: { force?: boolean } = {}): void {
  logger.data("guides", "save_start", { count: guides?.length ?? 0 });
  try {
    if ((!guides || guides.length === 0) && !options.force) {
      logger.warn("Attempted to save empty guides array - ABORTED to prevent data loss");
      return;
    }

    const db = getDb();

    for (const g of guides) {
      upsertGuideToDb(db, g);
    }

    logger.data("guides", "saved", { count: guides?.length ?? 0 });
  } catch (error: unknown) {
    logger.error("Error saving guides:", { error: (error as Error).message });
    throw error;
  }
}

export function promoteToGuide(
  guides: Guide[],
  guideName: string,
  category: string,
  knowledge: string,
  context: string = ""
): Guide {
  logger.flow("guide_distill", "start", { guideName, memoryId: context });
  let guide = findGuide(guides, guideName);

  if (!guide) {
    guide = createGuide(guideName, category, `Created via distillation from memory.`, [context], [knowledge]);
    guides.push(guide);
    logger.flow("guide_distill", "created", { guide: guideName });
  } else {
    if (!guide.learnings.includes(knowledge)) {
      guide.learnings.push(knowledge);
    }
    if (context && !guide.contexts.includes(context)) {
      guide.contexts.push(context.toLowerCase().trim());
    }
    guide.usage_count += 1;
    guide.last_used = getToday();
    logger.flow("guide_distill", "updated", { guide: guideName });
  }

  return guide;
}

export function findGuide(guides: Guide[], guideName: string): Guide | null {
  const normalized = guideName.toLowerCase().trim();
  return guides.find(g => g.guide === normalized) || null;
}

export function findSimilarGuide(guides: Guide[], guideName: string): Guide | null {
  logger.flow("guide_find", "searching", { guideName });
  const normalized = guideName.toLowerCase().trim();

  const exact = guides.find(g => g.guide === normalized);
  if (exact) {
    logger.flow("guide_find", "found", { guideName, method: "exact" });
    return exact;
  }

  if (guides.length === 0) {
    logger.flow("guide_find", "not_found", { guideName, reason: "empty_guides" });
    return null;
  }

  try {
    const db = getDb();
    const terms = normalized
      .split(/\s+/)
      .filter(t => t.length > 1 && !FTS_BOOLEAN_OPS.has(t))
      .map(t => `${t}*`)
      .join(" OR ");

    if (terms) {
      const row = db.prepareCached(
        `SELECT g.* FROM guides_fts fts
         JOIN guides g ON g.id = fts.rowid
         WHERE guides_fts MATCH ?
         ORDER BY rank
         LIMIT 1`
      ).get(terms) as Record<string, unknown> | undefined;

      if (row) {
        const guideId = Number(row.id);
        const contexts = loadGuideContexts(db, guideId);
        const learnings = loadGuideLearnings(db, guideId);
        const matched = rowToGuide(row, contexts, learnings);
        logger.flow("guide_find", "found", { guideName, method: "fts5" });
        return matched;
      }
    }
  } catch (error: unknown) {
    logger.error("FTS5 search failed for similar guide", { error: (error as Error).message });
  }

  for (const g of guides) {
    if (g.guide.includes(normalized) || normalized.includes(g.guide)) {
      logger.flow("guide_find", "found", { guideName, method: "substring" });
      return g;
    }
    if (g.guide.startsWith(normalized) || normalized.startsWith(g.guide)) {
      logger.flow("guide_find", "found", { guideName, method: "prefix" });
      return g;
    }
  }

  let bestEditDist = Infinity;
  let bestMatch: Guide | null = null;
  for (const g of guides) {
    const dist = levenshtein(normalized, g.guide);
    if (dist < bestEditDist) {
      bestEditDist = dist;
      bestMatch = g;
    }
  }
  if (bestMatch && bestEditDist <= Math.max(2, Math.floor(Math.max(normalized.length, bestMatch.guide.length) * 0.3))) {
    logger.flow("guide_find", "found", { guideName, method: "levenshtein", distance: bestEditDist });
    return bestMatch;
  }

  logger.flow("guide_find", "not_found", { guideName });
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1).fill(0) as number[];
  const curr = new Array(n + 1).fill(0) as number[];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

export function updateGuide(guides: Guide[], guideName: string, updates: GuideUpdates): Guide | null {
  logger.flow("guide_update", "start", { guideName });
  const guide = findGuide(guides, guideName);
  if (!guide) {
    logger.flow("guide_update", "not_found", { guideName });
    return null;
  }

  const fieldsUpdated: string[] = [];
  if (updates.guide) { guide.guide = updates.guide.toLowerCase().trim(); fieldsUpdated.push("guide"); }
  if (updates.category) { guide.category = updates.category.toLowerCase().trim(); fieldsUpdated.push("category"); }
  if (updates.description) { guide.description = updates.description.trim(); fieldsUpdated.push("description"); }
  if (updates.add_anti_patterns) {
    guide.anti_patterns = [...(guide.anti_patterns || []), ...updates.add_anti_patterns];
    fieldsUpdated.push("anti_patterns");
  }
  if (updates.add_pitfalls) {
    guide.known_pitfalls = [...(guide.known_pitfalls || []), ...updates.add_pitfalls];
    fieldsUpdated.push("pitfalls");
  }
  if (updates.superseded_by) {
    guide.superseded_by = updates.superseded_by;
    fieldsUpdated.push("superseded_by");
  }
  if (updates.deprecated === true) {
    guide.deprecated = true;
    fieldsUpdated.push("deprecated");
  }

  try {
    const db = getDb();
    if (updates.guide) {
      const oldName = guideName.toLowerCase().trim();
      const newName = updates.guide.toLowerCase().trim();
      if (oldName !== newName) {
        db.prepareCached("DELETE FROM guides WHERE guide = ? COLLATE NOCASE").run(oldName);
      }
    }
    upsertGuideToDb(db, guide);
  } catch (error: unknown) {
    logger.error("Error writing guide update to DB:", { error: (error as Error).message });
  }

  logger.flow("guide_update", "complete", { guideName, fields: fieldsUpdated });
  return guide;
}

export function removeMemoryFromGuides(memoryId: string): number {
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT id, guide, source_memories, validated_by FROM guides WHERE source_memories IS NOT NULL OR validated_by IS NOT NULL`
    ).all() as { id: number; guide: string; source_memories: string | null; validated_by: string | null }[];

    let cleaned = 0;
    for (const row of rows) {
      let changed = false;
      let srcMem: string[] = row.source_memories ? JSON.parse(row.source_memories) : [];
      let valBy: string[] = row.validated_by ? JSON.parse(row.validated_by) : [];

      const srcBefore = srcMem.length;
      srcMem = srcMem.filter(id => id !== memoryId);
      if (srcMem.length !== srcBefore) changed = true;

      const valBefore = valBy.length;
      valBy = valBy.filter(id => id !== memoryId);
      if (valBy.length !== valBefore) changed = true;

      if (changed) {
        db.prepareCached(
          `UPDATE guides SET source_memories = ?, validated_by = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(
          srcMem.length > 0 ? JSON.stringify(srcMem) : null,
          valBy.length > 0 ? JSON.stringify(valBy) : null,
          row.id
        );
        cleaned++;
      }
    }
    logger.flow("guides", "remove_memory_refs", { memoryId, cleaned });
    return cleaned;
  } catch (err) {
    logger.warn("Failed to remove memory from guides", { memoryId, error: String(err) });
    return 0;
  }
}

export function deleteGuide(guides: Guide[], guideName: string): boolean {
  logger.flow("guide_delete", "start", { guideName });
  const normalized = guideName.toLowerCase().trim();
  const initialLength = guides.length;
  const filtered = guides.filter(g => g.guide !== normalized);

  if (filtered.length === initialLength) {
    logger.flow("guide_delete", "not_found", { guideName });
    return false;
  }

  guides.length = 0;
  guides.push(...filtered);

  try {
    const db = getDb();
    db.prepareCached("DELETE FROM guides WHERE guide = ? COLLATE NOCASE").run(normalized);
  } catch (error: unknown) {
    logger.error("Error deleting guide from DB:", { error: (error as Error).message });
  }

  logger.flow("guide_delete", "deleted", { guideName });
  return true;
}

export function practiceGuide(
  guides: Guide[],
  guideName: string,
  category: string,
  description: string = "",
  newContexts: string[] = [],
  newLearnings: string[] = [],
  outcome: string | null = null
): Guide {
  logger.flow("guide_practice", "start", { guide: guideName, category });
  let guide = findSimilarGuide(guides, guideName);

  if (!guide) {
    guide = createGuide(guideName, category, description, newContexts, newLearnings);
    guides.push(guide);
    logger.flow("guide_practice", "created_new", { guide: guideName });

    try {
      const db = getDb();
      upsertGuideToDb(db, guide);
    } catch (error: unknown) {
      logger.error("Error writing guide practice to DB:", { error: (error as Error).message });
    }

    logger.flow("guide_practice", "complete", { guide: guideName, usageCount: guide.usage_count, learningsCount: guide.learnings.length });
    return guide;
  }

  guide.usage_count += 1;
  guide.last_used = getToday();
  if (guide.auto_usage_count == null) guide.auto_usage_count = 0;
  logger.flow("guide_practice", "updated", { guide: guideName, usageCount: guide.usage_count });

  if (!guide.description && description) {
    guide.description = description.trim();
  }

  const existingContexts = new Set(guide.contexts.map(c => c.toLowerCase()));
  for (const ctx of newContexts) {
    const normalized = ctx.toLowerCase().trim();
    if (normalized && !existingContexts.has(normalized)) {
      guide.contexts.push(normalized);
      existingContexts.add(normalized);
    }
  }

  const existingLearnings = new Set(guide.learnings);
  for (const learning of newLearnings) {
    const trimmed = learning.trim();
    if (trimmed && !existingLearnings.has(trimmed)) {
      guide.learnings.push(trimmed);
      existingLearnings.add(trimmed);
    }
  }

  if (outcome === "success") {
    guide.success_count = (guide.success_count || 0) + 1;
  } else if (outcome === "failure") {
    guide.failure_count = (guide.failure_count || 0) + 1;
  }

  try {
    const db = getDb();
    upsertGuideToDb(db, guide);
  } catch (error: unknown) {
    logger.error("Error writing guide practice to DB:", { error: (error as Error).message });
  }

  logger.flow("guide_practice", "complete", { guide: guideName, usageCount: guide.usage_count, learningsCount: guide.learnings.length });
  return guide;
}

export function getTopGuides(guides: Guide[], limit: number = 20): Guide[] {
  return [...guides]
    .sort((a, b) => {
      const scoreA = (a.usage_count || 0) * 0.7 + (a.auto_usage_count || 0) * 0.3;
      const scoreB = (b.usage_count || 0) * 0.7 + (b.auto_usage_count || 0) * 0.3;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}

export function getGuidesByCategory(guides: Guide[], category: string): Guide[] {
  const normalized = category.toLowerCase().trim();
  return guides.filter(g => g.category === normalized);
}

export function formatGuidesForLLM(guides: Guide[]): string {
  if (guides.length === 0) {
    return `## Guides\n---\n(no guides tracked yet)\n---`;
  }

  const sorted = getTopGuides(guides, 30);

  const lines = sorted.map(guide => {
    return `[${guide.category}] ${guide.guide} — ${guide.usage_count}x usage, ${guide.learnings.length} learnings`;
  });

  return `## Guides\n---\n${lines.join("\n")}\n---`;
}

function tokenize(str: string): Set<string> {
  if (!str) return new Set();
  const tokens = str.toLowerCase()
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  return new Set(tokens);
}

function hasTokenMatch(text: string, target: string): boolean {
  const textTokens = tokenize(text);
  const targetTokens = tokenize(target);

  for (const token of textTokens) {
    if (targetTokens.has(token)) return true;
  }

  for (const textToken of textTokens) {
    for (const targetToken of targetTokens) {
      if (textToken.includes(targetToken) || targetToken.includes(textToken)) {
        return true;
      }
    }
  }

  return false;
}

export function suggestGuides(taskDescription: string, existingGuides: Guide[] = []): SuggestResult {
  logger.flow("guide_suggest", "start", { task: taskDescription?.slice(0, 50) });
  const suggestions: GuideSuggestion[] = [];
  const seen = new Set<string>();

  const allGuideDefs = Object.values(TASK_GUIDE_MAP).flat().map(def => ({
    ...def,
    keywords: def.keywords || []
  }));

  const descLower = taskDescription.toLowerCase();

  for (const guideDef of allGuideDefs) {
    if (seen.has(guideDef.guide)) continue;

    const guideMatch = descLower.includes(guideDef.guide);
    const keywordMatch = guideDef.keywords.some(kw => descLower.includes(kw.toLowerCase()));

    if (guideMatch || keywordMatch) {
      seen.add(guideDef.guide);
      const existing = existingGuides.find(g => g.guide === guideDef.guide);
      suggestions.push({
        ...guideDef,
        tracked: !!existing,
        usage_count: existing?.usage_count || 0,
        last_used: existing?.last_used || null,
        learnings: existing?.learnings || [],
        contexts: existing?.contexts || [],
      });
    }
  }

  if (existingGuides.length > 0) {
    try {
      const db = getDb();
      const terms = descLower
        .split(/\s+/)
        .filter(t => t.length > 2)
        .map(t => `"${t}"`)
        .join(" OR ");

      if (terms) {
        const rows = db.prepareCached(
          `SELECT g.* FROM guides_fts fts
           JOIN guides g ON g.id = fts.rowid
           WHERE guides_fts MATCH ?
           ORDER BY rank
           LIMIT 20`
        ).all(terms) as Record<string, unknown>[];

        logger.flow("guide_suggest", "fts_tracked_results", { count: rows.length });

        for (const row of rows) {
          const guideName = row.guide as string;
          if (seen.has(guideName)) continue;
          seen.add(guideName);

          const guideId = Number(row.id);
          const contexts = loadGuideContexts(db, guideId);
          const learnings = loadGuideLearnings(db, guideId);
          const guide = rowToGuide(row, contexts, learnings);

          suggestions.push({
            guide: guide.guide,
            category: guide.category,
            keywords: guide.contexts,
            tracked: true,
            usage_count: guide.usage_count,
            last_used: guide.last_used,
            learnings: guide.learnings,
            contexts: guide.contexts,
            description: guide.description,
          });
        }
      }
    } catch (error: unknown) {
      logger.error("FTS5 search failed for guide suggestions", { error: (error as Error).message });
    }
  }

  for (const existing of existingGuides) {
    if (seen.has(existing.guide)) continue;

    if (hasTokenMatch(descLower, existing.guide) ||
      existing.contexts.some(ctx => hasTokenMatch(descLower, ctx)) ||
      existing.learnings.some(l => hasTokenMatch(descLower, l))) {
      seen.add(existing.guide);
      suggestions.push({
        guide: existing.guide,
        category: existing.category,
        keywords: existing.contexts,
        tracked: true,
        usage_count: existing.usage_count,
        last_used: existing.last_used,
        learnings: existing.learnings,
        contexts: existing.contexts,
        description: existing.description,
      });
    }
  }

  const tracked = suggestions.filter(s => s.tracked);
  const missing = suggestions.filter(s => !s.tracked);

  logger.flow("guide_suggest", "complete", { total: suggestions.length, tracked: tracked.length, missing: missing.length });

  return {
    relevant: tracked,
    missing: missing,
    suggested: suggestions,
    summary: `Found ${suggestions.length} relevant guides (${tracked.length} tracked, ${missing.length} new)`,
  };
}

export function formatSuggestions(result: SuggestResult): string {
  let output = `=== GUIDE SUGGESTIONS ===\n`;
  output += `${result.summary}\n\n`;

  if (result.relevant.length > 0) {
    output += `TRACKED (you have experience):\n`;
    for (const s of result.relevant) {
      output += `  ✓ [${s.category}] ${s.guide} (${s.usage_count}x, last: ${s.last_used || 'n/a'})\n`;
      if (s.learnings && s.learnings.length > 0) {
        for (const l of s.learnings.slice(0, 3)) {
          output += `      💡 ${l}\n`;
        }
        if (s.learnings.length > 3) {
          output += `      ... and ${s.learnings.length - 3} more learnings\n`;
        }
      }
    }
    output += `\n`;
  }

  if (result.missing.length > 0) {
    output += `SUGGESTED (not tracked yet):\n`;
    for (const s of result.missing) {
      output += `  + [${s.category}] ${s.guide}\n`;
      if (s.keywords && s.keywords.length > 0) {
        output += `      keywords: ${s.keywords.slice(0, 5).join(", ")}\n`;
      }
    }
    output += `\n`;
  }

  if (result.suggested.length === 0) {
    output += `No relevant guides found for this task.\n`;
    output += `Try describing the task with more specific terms.\n`;
  }

  output += `========================`;
  return output;
}

export function formatGuideDetail(guide: Guide | null): string {
  if (!guide) {
    return "Guide not found.";
  }

  let detail = `=== GUIDE: ${guide.guide} ===\n`;
  detail += `Category: ${guide.category}\n`;
  detail += `Usage Count: ${guide.usage_count}\n`;
  detail += `Last Used: ${guide.last_used}\n`;

  if (guide.description) {
    detail += `\n=== DESCRIPTION / PROTOCOLS ===\n${guide.description}\n===============================\n`;
  }

  if (guide.contexts.length > 0) {
    detail += `Contexts: ${guide.contexts.join(", ")}\n`;
  }

  if (guide.learnings.length > 0) {
    detail += `Learnings:\n`;
    for (const l of guide.learnings) {
      detail += `  - ${l}\n`;
    }
  }

  const totalAttempts = (guide.success_count || 0) + (guide.failure_count || 0);
  if (totalAttempts > 0) {
    const rate = (guide.success_count || 0) / totalAttempts;
    detail += `Success Rate: ${rate.toFixed(2)} (${guide.success_count || 0}/${totalAttempts})\n`;
  }

  if (guide.anti_patterns && guide.anti_patterns.length > 0) {
    detail += `Anti-patterns:\n`;
    for (const ap of guide.anti_patterns) {
      detail += `  - ${ap}\n`;
    }
  }

  if (guide.known_pitfalls && guide.known_pitfalls.length > 0) {
    detail += `Known Pitfalls:\n`;
    for (const kp of guide.known_pitfalls) {
      detail += `  - ${kp}\n`;
    }
  }

  if (guide.depends_on && guide.depends_on.length > 0) {
    detail += `Depends on: ${guide.depends_on.join(", ")}\n`;
  }

  if (guide.superseded_by) {
    detail += `Superseded by: ${guide.superseded_by}\n`;
  }

  detail += `====================`;
  return detail;
}

export { TASK_GUIDE_MAP };

export function findGuideByName(name: string): Guide | null {
  return getGuideFromDb(name);
}

export function findSimilarGuideByName(name: string): Guide | null {
  const normalized = name.toLowerCase().trim();

  const exact = getGuideFromDb(normalized);
  if (exact) return exact;

  try {
    const db = getDb();
    const terms = normalized
      .split(/\s+/)
      .filter(t => t.length > 1 && !FTS_BOOLEAN_OPS.has(t))
      .map(t => `${t}*`)
      .join(" OR ");

    if (terms) {
      const row = db.prepareCached(
        `SELECT g.* FROM guides_fts fts
         JOIN guides g ON g.id = fts.rowid
         WHERE guides_fts MATCH ?
         ORDER BY rank
         LIMIT 1`
      ).get(terms) as Record<string, unknown> | undefined;

      if (row) {
        const guideId = Number(row.id);
        const contexts = loadGuideContexts(db, guideId);
        const learnings = loadGuideLearnings(db, guideId);
        return rowToGuide(row, contexts, learnings);
      }
    }
  } catch (err) {
    logger.warn("FTS5 search failed for findSimilarGuideByName", { error: String(err) });
  }

  try {
    const db = getDb();
    const row = db.prepareCached(
      `SELECT * FROM guides WHERE guide LIKE '%' || ? || '%' COLLATE NOCASE LIMIT 1`
    ).get(normalized) as Record<string, unknown> | undefined;

    if (row) {
      const guideId = Number(row.id);
      const contexts = loadGuideContexts(db, guideId);
      const learnings = loadGuideLearnings(db, guideId);
      return rowToGuide(row, contexts, learnings);
    }
  } catch (err) {
    logger.warn("LIKE fallback failed for findSimilarGuideByName", { error: String(err) });
  }

  return null;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall", "not", "near",
  "this", "that", "these", "those", "i", "we", "you", "he", "she",
  "they", "me", "us", "him", "her", "them", "my", "our", "your",
  "how", "what", "which", "who", "whom", "when", "where", "why",
]);

// FTS5 boolean operators — must be filtered out of unquoted prefix (${t}*)
// queries, otherwise "or"/"and"/"not"/"near" tokens crash with a syntax error.
const FTS_BOOLEAN_OPS = new Set(["and", "or", "not", "near"]);

export function suggestGuidesForTask(taskDescription: string): { guides: Array<{ name: string; relevance: number; reason: string }> } {
  const keywords = taskDescription
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t))
    .slice(0, 10);

  if (keywords.length === 0) return { guides: [] };

  const results: Array<{ name: string; relevance: number; reason: string; usage_count: number; last_used: string }> = [];

  try {
    const db = getDb();
    const ftsTerms = keywords.map(t => `${t}*`).join(" OR ");

    if (ftsTerms) {
      const rows = db.prepareCached(
        `SELECT g.guide, g.usage_count, g.last_used_at, g.category
         FROM guides_fts fts
         JOIN guides g ON g.id = fts.rowid
         WHERE guides_fts MATCH ?
         ORDER BY rank
         LIMIT 10`
      ).all(ftsTerms) as { guide: string; usage_count: number; last_used_at: string; category: string }[];

      for (const row of rows) {
        const daysSinceUsed = row.last_used_at
          ? (Date.now() - new Date(row.last_used_at).getTime()) / 86400000
          : 999;
        const recency = Math.max(0, 1 - daysSinceUsed / 90);
        const relevance = Math.min(1, (row.usage_count * 0.1) + (recency * 0.3) + 0.3);

        results.push({
          name: row.guide,
          relevance: Math.round(relevance * 100) / 100,
          reason: `Matched via search for: ${keywords.slice(0, 3).join(", ")}`,
          usage_count: row.usage_count,
          last_used: row.last_used_at,
        });
      }
    }
  } catch (err) {
    logger.warn("suggestGuidesForTask FTS failed", { error: String(err) });
  }

  results.sort((a, b) => b.relevance - a.relevance);
  const top3 = results.slice(0, 3).map(({ name, relevance, reason }) => ({ name, relevance, reason }));
  return { guides: top3 };
}

export function getTopGuidesFromDb(limit: number = 10): Guide[] {
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT * FROM guides ORDER BY usage_count DESC, last_used_at DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];

    return rows.map(row => {
      const guideId = Number(row.id);
      const contexts = loadGuideContexts(db, guideId);
      const learnings = loadGuideLearnings(db, guideId);
      return rowToGuide(row, contexts, learnings);
    });
  } catch (err) {
    logger.warn("getTopGuidesFromDb failed", { error: String(err) });
    return [];
  }
}

export function getGuidesByCategoryFromDb(category: string): Guide[] {
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT * FROM guides WHERE category = ? COLLATE NOCASE`
    ).all(category.toLowerCase().trim()) as Record<string, unknown>[];

    return rows.map(row => {
      const guideId = Number(row.id);
      const contexts = loadGuideContexts(db, guideId);
      const learnings = loadGuideLearnings(db, guideId);
      return rowToGuide(row, contexts, learnings);
    });
  } catch (err) {
    logger.warn("getGuidesByCategoryFromDb failed", { error: String(err) });
    return [];
  }
}
