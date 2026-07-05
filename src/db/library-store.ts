import type { LemmaDB } from "./database.js";
import { logger } from "../logger.js";

export interface FragmentSummary {
  id: string;
  title: string;
  type: string;
  project: string | null;
  confidence: number;
  age_days: number;
  access_count: number;
  positive_feedback: number;
  negative_feedback: number;
  distill_candidate: boolean;
  relation_count: number;
  fragment_preview: string;
}

export interface GuideSummary {
  name: string;
  category: string;
  usage_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number | null;
  learning_count: number;
  deprecated: boolean;
  source_memory_count: number;
}

export interface RelationSummary {
  total: number;
  by_type: Record<string, number>;
  isolated_fragment_ids: string[];
  hub_fragments: Array<{ id: string; title: string; count: number }>;
}

export interface AnalysisSignals {
  confidence_distribution: Record<string, number>;
  age_distribution: Record<string, number>;
  stale_fragments: Array<{ id: string; title: string; age_days: number; confidence: number }>;
  similarity_candidates: Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }>;
  distill_candidates: Array<{ id: string; title: string; type: string }>;
  low_performing_guides: Array<{ name: string; success_rate: number; usage: number }>;
  type_distribution: Record<string, number>;
  project_distribution: Record<string, number>;
  never_accessed_count: number;
  deprecated_guides: string[];
  superseded_fragments: Array<{ id: string; title: string }>;
  dangling_guide_links: Array<{ guide: string; memory_id: string }>;
}

export interface SessionActivity {
  recent_count: number;
  outcomes: Record<string, number>;
  most_accessed: Array<{ id: string; title: string; count: number }>;
  never_accessed_count: number;
}

export interface LibrarySnapshot {
  generated_at: string;
  total_memories: number;
  total_guides: number;
  total_sessions: number;
  health_status: string;
  fragments: FragmentSummary[];
  guides: GuideSummary[];
  relations: RelationSummary;
  signals: AnalysisSignals;
  session_activity: SessionActivity;
  suggestions: string[];
}

function wordOverlapScore(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

export function collectFragmentSummaries(db: LemmaDB, projectFilter?: string | null): FragmentSummary[] {
  const baseSql = `SELECT m.legacy_id as id, m.title, m.type, m.project, m.confidence,
    CAST(julianday('now') - julianday(m.created_at) AS INTEGER) as age_days,
    m.access_count, m.positive_feedback, m.negative_feedback, m.distill_candidate,
    COALESCE(rel.rel_count, 0) as relation_count,
    SUBSTR(m.fragment, 1, 80) as fragment_preview
    FROM memories m
    LEFT JOIN (SELECT source_id, COUNT(*) as rel_count FROM relations GROUP BY source_id) rel ON rel.source_id = m.id`;

  const sql = projectFilter
    ? baseSql + ` WHERE m.project = ? ORDER BY m.confidence DESC`
    : baseSql + ` ORDER BY m.confidence DESC`;

  // Normalize the filter to the canonical (trim + lowercase) project key so it
  // matches the normalized value stored on write; a raw "Lemma" would miss "lemma".
  const normalizedFilter = projectFilter ? projectFilter.trim().toLowerCase() : projectFilter;
  const stmt = db.prepareCached(sql);
  const rows = (normalizedFilter ? stmt.all(normalizedFilter) : stmt.all()) as Record<string, any>[];

  return rows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    type: row.type as string,
    project: (row.project as string) ?? null,
    confidence: row.confidence as number,
    age_days: (row.age_days as number) ?? 0,
    access_count: (row.access_count as number) ?? 0,
    positive_feedback: (row.positive_feedback as number) ?? 0,
    negative_feedback: (row.negative_feedback as number) ?? 0,
    distill_candidate: row.distill_candidate === 1,
    relation_count: (row.relation_count as number) ?? 0,
    fragment_preview: (row.fragment_preview as string) ?? "",
  }));
}

export function collectGuideSummaries(db: LemmaDB): GuideSummary[] {
  const sql = `SELECT g.guide as name, g.category, g.usage_count, g.success_count, g.failure_count,
    g.deprecated,
    COALESCE(lc.learning_count, 0) as learning_count,
    COALESCE(smc.source_memory_count, 0) as source_memory_count
    FROM guides g
    LEFT JOIN (SELECT guide_id, COUNT(*) as learning_count FROM guide_learnings GROUP BY guide_id) lc ON lc.guide_id = g.id
    LEFT JOIN (SELECT guide_id, COUNT(*) as source_memory_count FROM guide_memory_links WHERE link_type = 'source' GROUP BY guide_id) smc ON smc.guide_id = g.id
    ORDER BY g.usage_count DESC`;

  const rows = db.prepareCached(sql).all() as Record<string, any>[];

  return rows.map(row => ({
    name: row.name,
    category: row.category,
    usage_count: row.usage_count ?? 0,
    success_count: row.success_count ?? 0,
    failure_count: row.failure_count ?? 0,
    success_rate: row.usage_count > 0 ? row.success_count / row.usage_count : null,
    learning_count: row.learning_count ?? 0,
    deprecated: row.deprecated === 1,
    source_memory_count: row.source_memory_count ?? 0,
  }));
}

export function collectRelationSummary(db: LemmaDB, fragmentIds: string[]): RelationSummary {
  const totalRow = db.prepareCached(`SELECT COUNT(*) as total FROM relations`).get() as Record<string, unknown> | undefined;
  const total = (totalRow?.total as number) ?? 0;

  const byTypeRows = db.prepareCached(
    `SELECT type, COUNT(*) as count FROM relations GROUP BY type`
  ).all() as Record<string, unknown>[];
  const by_type: Record<string, number> = {};
  for (const row of byTypeRows) {
    by_type[row.type as string] = row.count as number;
  }

  const isolated_fragment_ids: string[] = [];
  if (fragmentIds.length > 0) {
    const placeholders = fragmentIds.map(() => "?").join(",");
    const sql = `SELECT m.legacy_id FROM memories m
      WHERE m.legacy_id IN (${placeholders})
      AND m.id NOT IN (SELECT source_id FROM relations)
      AND m.id NOT IN (SELECT target_id FROM relations)`;
    const isolatedRows = db.prepareCached(sql).all(...fragmentIds) as Record<string, unknown>[];
    for (const row of isolatedRows) {
      isolated_fragment_ids.push(row.legacy_id as string);
    }
  }

  const hubRows = db.prepareCached(
    `SELECT m.legacy_id as id, m.title, COUNT(r.id) as count
     FROM memories m JOIN relations r ON r.source_id = m.id
     GROUP BY m.id HAVING count >= 5 ORDER BY count DESC`
  ).all() as Record<string, unknown>[];

  const hub_fragments = hubRows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    count: row.count as number,
  }));

  return { total, by_type, isolated_fragment_ids, hub_fragments };
}

export function findSimilarPairs(
  fragments: FragmentSummary[],
  threshold: number = 0.3
): Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }> {
  if (fragments.length > 200) {
    logger.flow("library_snapshot", "similarity_skipped", { fragment_count: fragments.length });
    return [];
  }
  const pairs: Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }> = [];

  for (let i = 0; i < fragments.length; i++) {
    for (let j = i + 1; j < fragments.length; j++) {
      const a = fragments[i];
      const b = fragments[j];
      const score = wordOverlapScore(
        a.title + " " + a.fragment_preview,
        b.title + " " + b.fragment_preview
      );
      if (score >= threshold) {
        pairs.push({
          id_a: a.id,
          id_b: b.id,
          title_a: a.title,
          title_b: b.title,
          overlap: Math.round(score * 100) / 100,
        });
      }
    }
  }

  pairs.sort((a, b) => b.overlap - a.overlap);
  return pairs.slice(0, 20);
}

export function collectAnalysisSignals(db: LemmaDB, fragments: FragmentSummary[]): AnalysisSignals {
  const confidenceBuckets = ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"];
  const confidence_distribution: Record<string, number> = {};
  for (const b of confidenceBuckets) confidence_distribution[b] = 0;

  const confRows = db.prepareCached(
    `SELECT CASE
       WHEN confidence < 0.2 THEN '0.0-0.2'
       WHEN confidence < 0.4 THEN '0.2-0.4'
       WHEN confidence < 0.6 THEN '0.4-0.6'
       WHEN confidence < 0.8 THEN '0.6-0.8'
       ELSE '0.8-1.0'
     END as bucket, COUNT(*) as count
     FROM memories GROUP BY bucket`
  ).all() as Record<string, unknown>[];
  for (const row of confRows) {
    const bucket = row.bucket as string;
    if (bucket in confidence_distribution) {
      confidence_distribution[bucket] = row.count as number;
    }
  }

  const ageBuckets = ["< 7", "7-30", "30-90", "> 90"];
  const age_distribution: Record<string, number> = {};
  for (const b of ageBuckets) age_distribution[b] = 0;

  const ageRows = db.prepareCached(
    `SELECT CASE
       WHEN julianday('now') - julianday(created_at) < 7 THEN '< 7'
       WHEN julianday('now') - julianday(created_at) < 30 THEN '7-30'
       WHEN julianday('now') - julianday(created_at) < 90 THEN '30-90'
       ELSE '> 90'
     END as bucket, COUNT(*) as count
     FROM memories GROUP BY bucket`
  ).all() as Record<string, unknown>[];
  for (const row of ageRows) {
    const bucket = row.bucket as string;
    if (bucket in age_distribution) {
      age_distribution[bucket] = row.count as number;
    }
  }

  const staleRows = db.prepareCached(
    `SELECT legacy_id as id, title,
       CAST(julianday('now') - julianday(created_at) AS INTEGER) as age_days,
       confidence
     FROM memories
     WHERE access_count = 0 AND julianday('now') - julianday(created_at) > 30 AND confidence < 0.5
     ORDER BY confidence ASC`
  ).all() as Record<string, unknown>[];
  const stale_fragments = staleRows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    age_days: (row.age_days as number) ?? 0,
    confidence: row.confidence as number,
  }));

  const similarity_candidates = findSimilarPairs(fragments);

  const distillRows = db.prepareCached(
    `SELECT legacy_id as id, title, type FROM memories WHERE distill_candidate = 1`
  ).all() as Record<string, unknown>[];
  const distill_candidates = distillRows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    type: row.type as string,
  }));

  const guidePerfRows = db.prepareCached(
    `SELECT guide as name,
       CASE WHEN usage_count > 0 THEN CAST(success_count AS REAL) / usage_count ELSE NULL END as success_rate,
       usage_count as usage
     FROM guides
     WHERE usage_count >= 3 AND deprecated = 0 AND (CAST(success_count AS REAL) / usage_count) < 0.4
     ORDER BY success_rate ASC`
  ).all() as Record<string, unknown>[];
  const low_performing_guides = guidePerfRows.map(row => ({
    name: row.name as string,
    success_rate: row.success_rate as number,
    usage: row.usage as number,
  }));

  const typeRows = db.prepareCached(
    `SELECT type, COUNT(*) as count FROM memories GROUP BY type`
  ).all() as Record<string, unknown>[];
  const type_distribution: Record<string, number> = {};
  for (const row of typeRows) {
    type_distribution[row.type as string] = row.count as number;
  }

  const projectRows = db.prepareCached(
    `SELECT COALESCE(project, 'null (global)') as project, COUNT(*) as count FROM memories GROUP BY project`
  ).all() as Record<string, unknown>[];
  const project_distribution: Record<string, number> = {};
  for (const row of projectRows) {
    project_distribution[row.project as string] = row.count as number;
  }

  const neverAccessedRow = db.prepareCached(
    `SELECT COUNT(*) as count FROM memories WHERE access_count = 0`
  ).get() as Record<string, unknown> | undefined;

  const deprecatedGuideRows = db.prepareCached(
    `SELECT guide FROM guides WHERE deprecated = 1`
  ).all() as Record<string, unknown>[];
  const deprecated_guides = deprecatedGuideRows.map(r => r.guide as string);

  const supersededRows = db.prepareCached(
    `SELECT DISTINCT m.legacy_id as id, m.title
     FROM memories m
     JOIN relations r ON r.source_id = m.id
     WHERE r.type = 'superseded_by'`
  ).all() as Record<string, unknown>[];
  const superseded_fragments = supersededRows.map(r => ({
    id: r.id as string,
    title: r.title as string,
  }));

  const danglingLinks: Array<{ guide: string; memory_id: string }> = [];
  const allLegacyIds = new Set(
    (db.prepareCached(`SELECT legacy_id FROM memories`).all() as Record<string, unknown>[]).map(r => r.legacy_id as string)
  );

  const guidesWithSources = db.prepareCached(
    `SELECT g.guide, g.source_memories, g.validated_by FROM guides g
     WHERE g.source_memories IS NOT NULL OR g.validated_by IS NOT NULL`
  ).all() as Record<string, unknown>[];
  for (const g of guidesWithSources) {
    const guideName = g.guide as string;
    for (const jsonField of [g.source_memories, g.validated_by]) {
      if (!jsonField || typeof jsonField !== "string") continue;
      try {
        const ids: string[] = JSON.parse(jsonField);
        for (const mid of ids) {
          if (!allLegacyIds.has(mid)) {
            danglingLinks.push({ guide: guideName, memory_id: mid });
          }
        }
      } catch {}
    }
  }

  return {
    confidence_distribution,
    age_distribution,
    stale_fragments,
    similarity_candidates,
    distill_candidates,
    low_performing_guides,
    type_distribution,
    project_distribution,
    never_accessed_count: (neverAccessedRow?.count as number) ?? 0,
    deprecated_guides,
    superseded_fragments,
    dangling_guide_links: danglingLinks,
  };
}

export function collectSessionActivity(db: LemmaDB): SessionActivity {
  const recentRow = db.prepareCached(
    `SELECT COUNT(*) as count FROM sessions WHERE julianday('now') - julianday(started_at) <= 30`
  ).get() as Record<string, unknown> | undefined;

  const outcomeRows = db.prepareCached(
    `SELECT outcome, COUNT(*) as count FROM sessions WHERE outcome IS NOT NULL AND julianday('now') - julianday(started_at) <= 30 GROUP BY outcome`
  ).all() as Record<string, unknown>[];
  const outcomes: Record<string, number> = {};
  for (const row of outcomeRows) {
    outcomes[row.outcome as string] = row.count as number;
  }

  const mostAccessedRows = db.prepareCached(
    `SELECT m.legacy_id as id, m.title, m.access_count as count
     FROM memories m
     WHERE m.last_accessed_at IS NOT NULL AND julianday('now') - julianday(m.last_accessed_at) <= 30
     ORDER BY m.access_count DESC LIMIT 10`
  ).all() as Record<string, unknown>[];
  const most_accessed = mostAccessedRows.map(row => ({
    id: row.id as string,
    title: row.title as string,
    count: row.count as number,
  }));

  const neverAccessedRow = db.prepareCached(
    `SELECT COUNT(*) as count FROM memories WHERE access_count = 0`
  ).get() as Record<string, unknown> | undefined;

  return {
    recent_count: (recentRow?.count as number) ?? 0,
    outcomes,
    most_accessed,
    never_accessed_count: (neverAccessedRow?.count as number) ?? 0,
  };
}

export function generateSuggestions(snapshot: LibrarySnapshot): string[] {
  const suggestions: string[] = [];
  const { signals, relations, guides } = snapshot;

  if (signals.stale_fragments.length > 0) {
    suggestions.push(`HIGH: STALE: ${signals.stale_fragments.length} fragments have 0 access, >30 days old, confidence < 0.5 — consider memory_forget or memory_update`);
  }
  if (signals.similarity_candidates.length > 0) {
    suggestions.push(`HIGH: DUPLICATE: ${signals.similarity_candidates.length} pairs of similar fragments detected — consider memory_merge`);
  }
  if (signals.distill_candidates.length > 0) {
    suggestions.push(`HIGH: DISTILL: ${signals.distill_candidates.length} fragments flagged as distill_candidate — use guide_distill to promote them`);
  }
  if (relations.isolated_fragment_ids.length > 0) {
    suggestions.push(`MEDIUM: RELATE: ${relations.isolated_fragment_ids.length} isolated fragments — check for missing semantic connections`);
  }
  if (signals.low_performing_guides.length > 0) {
    suggestions.push(`MEDIUM: GUIDE_CLEANUP: ${signals.low_performing_guides.length} guide(s) have low success rate — consider guide_update or guide_forget`);
  }
  if (signals.dangling_guide_links.length > 0) {
    suggestions.push(`MEDIUM: ORPHAN: ${signals.dangling_guide_links.length} dangling guide-memory link(s) — clean up with guide_update`);
  }
  if (signals.superseded_fragments.length > 0) {
    suggestions.push(`MEDIUM: ARCHIVE: ${signals.superseded_fragments.length} superseded fragment(s) — consider memory_forget for outdated ones`);
  }
  const patternCount = signals.type_distribution["pattern"] ?? 0;
  const lessonCount = signals.type_distribution["lesson"] ?? 0;
  const factCount = signals.type_distribution["fact"] ?? 0;
  if (factCount > patternCount + lessonCount + 5) {
    suggestions.push(`MEDIUM: RETYPE: Heavy fact bias (${factCount} facts vs ${patternCount} patterns, ${lessonCount} lessons) — check if some facts should be reclassified as patterns or lessons`);
  }
  const deprecatedCount = guides.filter(g => g.deprecated).length;
  if (deprecatedCount > 0) {
    suggestions.push(`LOW: DEPRECATED: ${deprecatedCount} deprecated guide(s) — consider guide_forget or guide_update`);
  }
  if (signals.never_accessed_count > 0) {
    suggestions.push(`LOW: ARCHIVE: ${signals.never_accessed_count} never-accessed memories — review and consider memory_forget for obsolete ones`);
  }

  return suggestions;
}

export function collectLibrarySnapshot(
  db: LemmaDB,
  options?: { project?: string | null; focus?: string }
): LibrarySnapshot {
  const project = options?.project ?? null;
  const focus = options?.focus ?? "full";

  const needFragments = focus === "full" || focus === "stale" || focus === "duplicates" || focus === "orphans";
  const fragments = needFragments ? collectFragmentSummaries(db, project) : [];
  const fragmentIds = fragments.map(f => f.id);

  const needGuides = focus === "full" || focus === "guides";
  const needRelations = focus === "full" || focus === "orphans";
  const needSignals = focus === "full" || focus === "stale" || focus === "duplicates" || focus === "distill" || focus === "guides";
  const needSessions = focus === "full";

  const guides = needGuides ? collectGuideSummaries(db) : [];
  const relations = needRelations
    ? collectRelationSummary(db, fragmentIds)
    : { total: 0, by_type: {} as Record<string, number>, isolated_fragment_ids: [] as string[], hub_fragments: [] as Array<{ id: string; title: string; count: number }> };
  const signals = needSignals
    ? collectAnalysisSignals(db, fragments)
    : {
        confidence_distribution: {} as Record<string, number>,
        age_distribution: {} as Record<string, number>,
        stale_fragments: [] as Array<{ id: string; title: string; age_days: number; confidence: number }>,
        similarity_candidates: [] as Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }>,
        distill_candidates: [] as Array<{ id: string; title: string; type: string }>,
        low_performing_guides: [] as Array<{ name: string; success_rate: number; usage: number }>,
        type_distribution: {} as Record<string, number>,
        project_distribution: {} as Record<string, number>,
        never_accessed_count: 0,
        deprecated_guides: [] as string[],
        superseded_fragments: [] as Array<{ id: string; title: string }>,
        dangling_guide_links: [] as Array<{ guide: string; memory_id: string }>,
      };
  const session_activity = needSessions
    ? collectSessionActivity(db)
    : { recent_count: 0, outcomes: {} as Record<string, number>, most_accessed: [] as Array<{ id: string; title: string; count: number }>, never_accessed_count: 0 };

  const totalMemRow = db.prepareCached(`SELECT COUNT(*) as count FROM memories`).get() as Record<string, unknown> | undefined;
  const totalGuideRow = db.prepareCached(`SELECT COUNT(*) as count FROM guides`).get() as Record<string, unknown> | undefined;
  const totalSessionRow = db.prepareCached(`SELECT COUNT(*) as count FROM sessions`).get() as Record<string, unknown> | undefined;

  const snapshot: LibrarySnapshot = {
    generated_at: new Date().toISOString(),
    total_memories: (totalMemRow?.count as number) ?? 0,
    total_guides: (totalGuideRow?.count as number) ?? 0,
    total_sessions: (totalSessionRow?.count as number) ?? 0,
    health_status: "HEALTHY",
    fragments,
    guides,
    relations,
    signals,
    session_activity,
    suggestions: [],
  };

  snapshot.suggestions = generateSuggestions(snapshot);
  snapshot.health_status = snapshot.suggestions.length === 0 ? "HEALTHY" : "NEEDS ATTENTION";

  logger.flow("library_snapshot", "collected", {
    fragments: snapshot.total_memories,
    guides: snapshot.total_guides,
    suggestions: snapshot.suggestions.length,
  });

  return snapshot;
}

function fmtFragmentTable(fragments: FragmentSummary[]): string {
  const L: string[] = [];
  L.push(
    "ID".padEnd(13) + "| " +
    "Type".padEnd(9) + "| " +
    "Project".padEnd(10) + "| " +
    "Conf".padStart(5) + " | " +
    "Age(d)".padStart(6) + " | " +
    "Access".padStart(6) + " | " +
    "Feedback".padEnd(9) + "| " +
    "Distill".padEnd(8) + "| " +
    "Rels".padStart(4) + " | " +
    "Title"
  );
  for (const f of fragments) {
    const title = f.title.length > 60 ? f.title.substring(0, 57) + "..." : f.title;
    const proj = (f.project ?? "null").padEnd(10).substring(0, 10);
    L.push(
      f.id.padEnd(13) + "| " +
      f.type.padEnd(9) + "| " +
      proj + "| " +
      f.confidence.toFixed(2).padStart(5) + " | " +
      String(f.age_days).padStart(6) + " | " +
      String(f.access_count).padStart(6) + " | " +
      `+${f.positive_feedback}/-${f.negative_feedback}`.padEnd(9) + "| " +
      (f.distill_candidate ? "YES" : "no").padEnd(8) + "| " +
      String(f.relation_count).padStart(4) + " | " +
      title
    );
  }
  return L.join("\n");
}

function fmtGuideTable(guides: GuideSummary[]): string {
  const L: string[] = [];
  L.push(
    "Name".padEnd(15) + "| " +
    "Category".padEnd(13) + "| " +
    "Usage".padStart(5) + " | " +
    "Success Rate".padEnd(13) + "| " +
    "Learnings".padStart(9) + " | " +
    "Deprecated".padEnd(11) + "| " +
    "Source Mems"
  );
  for (const g of guides) {
    const rate = g.success_rate !== null
      ? `${g.success_count}/${g.usage_count} (${g.success_rate.toFixed(2)})`
      : "0/0 (N/A)";
    L.push(
      g.name.padEnd(15).substring(0, 15) + "| " +
      g.category.padEnd(13).substring(0, 13) + "| " +
      String(g.usage_count).padStart(5) + " | " +
      rate.padEnd(13) + "| " +
      String(g.learning_count).padStart(9) + " | " +
      (g.deprecated ? "yes" : "no").padEnd(11) + "| " +
      String(g.source_memory_count)
    );
  }
  return L.join("\n");
}

function fmtHistogram(lines: string[], title: string, dist: Record<string, number>): void {
  lines.push(`${title}:`);
  const values = Object.values(dist);
  const max = Math.max(...values, 0);
  for (const [bucket, count] of Object.entries(dist)) {
    const bar = max > 0 ? "\u2588".repeat(Math.round((count / max) * 30)) : "";
    lines.push(`  [${bucket}]:`.padEnd(12) + `${String(count).padStart(4)}  ${bar}`);
  }
  lines.push("");
}

export function formatLibrarySnapshot(snapshot: LibrarySnapshot, focus: string): string {
  const L: string[] = [];

  L.push("== LIBRARY MODE SNAPSHOT ==");
  L.push(`Generated: ${snapshot.generated_at}`);
  L.push(`Total memories: ${snapshot.total_memories} | Total guides: ${snapshot.total_guides} | Total sessions: ${snapshot.total_sessions}`);
  L.push(`Database health: ${snapshot.health_status} (${snapshot.suggestions.length} issues)`);
  L.push("");

  if (focus === "full") {
    if (snapshot.fragments.length > 0) {
      L.push(`== MEMORY FRAGMENTS (${snapshot.fragments.length}) ==`);
      L.push("");
      L.push(fmtFragmentTable(snapshot.fragments));
      L.push("");
    }

    if (snapshot.guides.length > 0) {
      L.push(`== GUIDES (${snapshot.guides.length}) ==`);
      L.push("");
      L.push(fmtGuideTable(snapshot.guides));
      L.push("");
    }

    L.push(`== RELATIONS (${snapshot.relations.total} total) ==`);
    L.push("");
    if (Object.keys(snapshot.relations.by_type).length > 0) {
      L.push("Type          | Count");
      for (const [type, count] of Object.entries(snapshot.relations.by_type)) {
        L.push(`${type.padEnd(14)}| ${count}`);
      }
      L.push("");
    }
    L.push(`Isolated fragments (0 relations): ${snapshot.relations.isolated_fragment_ids.length}`);
    if (snapshot.relations.hub_fragments.length > 0) {
      L.push(`Hub fragments (5+ relations): ${snapshot.relations.hub_fragments.length}`);
      for (const h of snapshot.relations.hub_fragments) {
        L.push(`  - ${h.id} (${h.count} relations): ${h.title}`);
      }
    }
    L.push("");

    L.push("== ANALYSIS SIGNALS ==");
    L.push("");
    fmtHistogram(L, "Confidence Distribution", snapshot.signals.confidence_distribution);
    fmtHistogram(L, "Age Distribution", snapshot.signals.age_distribution);

    L.push(`Stale Fragments (0 access, > 30 days old, confidence < 0.5): ${snapshot.signals.stale_fragments.length}`);
    for (const s of snapshot.signals.stale_fragments) {
      L.push(`  - ${s.id} (age: ${s.age_days}d, conf: ${s.confidence.toFixed(2)}): ${s.title}`);
    }
    L.push("");

    L.push(`Similarity Candidates (word overlap >= 0.3 between pairs): ${snapshot.signals.similarity_candidates.length} pairs`);
    for (const p of snapshot.signals.similarity_candidates) {
      L.push(`  - ${p.title_a} (${p.id_a}) <-> ${p.title_b} (${p.id_b}) (overlap: ${p.overlap.toFixed(2)})`);
    }
    L.push("");

    L.push(`Distill Candidates (flagged but not yet distilled): ${snapshot.signals.distill_candidates.length}`);
    for (const d of snapshot.signals.distill_candidates) {
      L.push(`  - ${d.id}: ${d.title}`);
    }
    L.push("");

    if (snapshot.signals.low_performing_guides.length > 0) {
      L.push(`Low-performing Guides (usage >= 3, success rate < 0.4): ${snapshot.signals.low_performing_guides.length}`);
      for (const g of snapshot.signals.low_performing_guides) {
        L.push(`  - ${g.name}: ${g.success_rate?.toFixed(2) ?? "N/A"} success rate (${g.usage} uses)`);
      }
      L.push("");
    }

    if (snapshot.signals.deprecated_guides.length > 0) {
      L.push(`Deprecated Guides: ${snapshot.signals.deprecated_guides.length}`);
      for (const name of snapshot.signals.deprecated_guides) {
        L.push(`  - ${name}`);
      }
      L.push("");
    }

    if (snapshot.signals.superseded_fragments.length > 0) {
      L.push(`Superseded Fragments: ${snapshot.signals.superseded_fragments.length}`);
      for (const s of snapshot.signals.superseded_fragments) {
        L.push(`  - ${s.id}: ${s.title}`);
      }
      L.push("");
    }

    if (snapshot.signals.dangling_guide_links.length > 0) {
      L.push(`Dangling Guide Links (guide references deleted memory): ${snapshot.signals.dangling_guide_links.length}`);
      for (const d of snapshot.signals.dangling_guide_links) {
        L.push(`  - guide "${d.guide}" references deleted memory ${d.memory_id}`);
      }
      L.push("");
    }

    const typeEntries = Object.entries(snapshot.signals.type_distribution);
    if (typeEntries.length > 0) {
      L.push("Type Distribution:");
      L.push(typeEntries.map(([t, c]) => `${t}: ${c}`).join(" | "));
      L.push("");
    }

    const projEntries = Object.entries(snapshot.signals.project_distribution);
    if (projEntries.length > 0) {
      L.push("Project Distribution:");
      for (const [p, c] of projEntries) {
        L.push(`  ${p}: ${c}`);
      }
      L.push("");
    }

    if (snapshot.signals.never_accessed_count > 0) {
      L.push(`Never-accessed memories: ${snapshot.signals.never_accessed_count}`);
      L.push("");
    }

    L.push("== SESSION ACTIVITY ==");
    L.push("");
    L.push(`Recent sessions (last 30 days): ${snapshot.session_activity.recent_count}`);
    const outcomeEntries = Object.entries(snapshot.session_activity.outcomes);
    if (outcomeEntries.length > 0) {
      L.push(`Outcomes: ${outcomeEntries.map(([o, c]) => `${o}: ${c}`).join(", ")}`);
    }
    if (snapshot.session_activity.most_accessed.length > 0) {
      L.push(
        "Most accessed memories (active in last 30 days): " +
        snapshot.session_activity.most_accessed
          .slice(0, 5)
          .map(m => `${m.id} (${m.count}x)`)
          .join(", ")
      );
    }
    L.push(`Never-accessed memories: ${snapshot.session_activity.never_accessed_count}`);
    L.push("");

    if (snapshot.suggestions.length > 0) {
      L.push("== SUGGESTED ACTIONS ==");
      L.push("");
      let num = 1;
      const high = snapshot.suggestions.filter(s => s.startsWith("HIGH"));
      const medium = snapshot.suggestions.filter(s => s.startsWith("MEDIUM"));
      const low = snapshot.suggestions.filter(s => s.startsWith("LOW"));

      if (high.length > 0) {
        L.push("HIGH PRIORITY:");
        for (const s of high) {
          L.push(`${num++}. ${s.replace(/^HIGH: /, "")}`);
        }
        L.push("");
      }
      if (medium.length > 0) {
        L.push("MEDIUM PRIORITY:");
        for (const s of medium) {
          L.push(`${num++}. ${s.replace(/^MEDIUM: /, "")}`);
        }
        L.push("");
      }
      if (low.length > 0) {
        L.push("LOW PRIORITY:");
        for (const s of low) {
          L.push(`${num++}. ${s.replace(/^LOW: /, "")}`);
        }
        L.push("");
      }
    }
  } else if (focus === "stale") {
    L.push(`Stale Fragments (0 access, > 30 days old, confidence < 0.5): ${snapshot.signals.stale_fragments.length}`);
    for (const s of snapshot.signals.stale_fragments) {
      L.push(`  - ${s.id} (age: ${s.age_days}d, conf: ${s.confidence.toFixed(2)}): ${s.title}`);
    }
  } else if (focus === "duplicates") {
    L.push(`Similarity Candidates (word overlap >= 0.3 between pairs): ${snapshot.signals.similarity_candidates.length} pairs`);
    for (const p of snapshot.signals.similarity_candidates) {
      L.push(`  - ${p.id_a} <-> ${p.id_b} (overlap: ${p.overlap.toFixed(2)})`);
    }
  } else if (focus === "orphans") {
    L.push(`== RELATIONS (${snapshot.relations.total} total) ==`);
    L.push("");
    if (Object.keys(snapshot.relations.by_type).length > 0) {
      L.push("Type          | Count");
      for (const [type, count] of Object.entries(snapshot.relations.by_type)) {
        L.push(`${type.padEnd(14)}| ${count}`);
      }
      L.push("");
    }
    L.push(`Isolated fragments (0 relations): ${snapshot.relations.isolated_fragment_ids.length}`);
    if (snapshot.relations.isolated_fragment_ids.length > 0) {
      for (const id of snapshot.relations.isolated_fragment_ids) {
        L.push(`  - ${id}`);
      }
    }
    if (snapshot.relations.hub_fragments.length > 0) {
      L.push(`Hub fragments (5+ relations): ${snapshot.relations.hub_fragments.length}`);
      for (const h of snapshot.relations.hub_fragments) {
        L.push(`  - ${h.id} (${h.count} relations): ${h.title}`);
      }
    }
    if (snapshot.signals.dangling_guide_links.length > 0) {
      L.push("");
      L.push(`Dangling Guide Links: ${snapshot.signals.dangling_guide_links.length}`);
      for (const d of snapshot.signals.dangling_guide_links) {
        L.push(`  - guide "${d.guide}" references deleted memory ${d.memory_id}`);
      }
    }
  } else if (focus === "distill") {
    L.push(`Distill Candidates (flagged but not yet distilled): ${snapshot.signals.distill_candidates.length}`);
    for (const d of snapshot.signals.distill_candidates) {
      L.push(`  - ${d.id}: ${d.title}`);
    }
  } else if (focus === "guides") {
    if (snapshot.guides.length > 0) {
      L.push(`== GUIDES (${snapshot.guides.length}) ==`);
      L.push("");
      L.push(fmtGuideTable(snapshot.guides));
      L.push("");
    }
    if (snapshot.signals.low_performing_guides.length > 0) {
      L.push(`Low-performing Guides (usage >= 3, success rate < 0.4): ${snapshot.signals.low_performing_guides.length}`);
      for (const g of snapshot.signals.low_performing_guides) {
        L.push(`  - ${g.name}: ${g.success_rate?.toFixed(2) ?? "N/A"} success rate (${g.usage} uses)`);
      }
    }
  }

  return L.join("\n");
}
