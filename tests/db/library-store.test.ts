import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as lib from "../../src/db/library-store.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-lib-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedFragments(titles: string[], project: string | null = null): void {
  const stmt = db.prepareCached(
    `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', ?, 'ai', 0.7, datetime('now'), datetime('now'))`
  );
  // Store the normalized (lowercased) project key, mirroring the real write path
  // (addMemory → normalizeProject). collectFragmentSummaries normalizes its filter
  // the same way, so a mixed-case filter still matches (regression for bug #2).
  const normalized = project ? project.trim().toLowerCase() : null;
  for (const t of titles) {
    stmt.run("m" + Math.random().toString(36).slice(2, 14), t, t, t, normalized);
  }
}

function seedGuide(
  name: string,
  category: string,
  usageCount: number,
  successCount: number,
  failureCount: number,
  deprecated: boolean = false
): void {
  db.prepareCached(
    `INSERT INTO guides (guide, category, description, usage_count, success_count, failure_count, deprecated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(name, category, `${name} description`, usageCount, successCount, failureCount, deprecated ? 1 : 0);
}

function seedRelation(sourceLegacyId: string, targetLegacyId: string, type: string): void {
  const src = db.prepareCached(`SELECT id FROM memories WHERE legacy_id = ?`).get(sourceLegacyId) as { id: number } | undefined;
  const tgt = db.prepareCached(`SELECT id FROM memories WHERE legacy_id = ?`).get(targetLegacyId) as { id: number } | undefined;
  if (src && tgt) {
    db.prepareCached(`INSERT OR IGNORE INTO relations (source_id, target_id, type, created_at) VALUES (?, ?, ?, datetime('now'))`).run(src.id, tgt.id, type);
  }
}

describe("collectFragmentSummaries", () => {
  test("returns empty for empty DB", () => {
    const result = lib.collectFragmentSummaries(db);
    assert.deepEqual(result, []);
  });

  test("returns all fragments with computed fields", () => {
    seedFragments(["Fragment A", "Fragment B"]);
    const result = lib.collectFragmentSummaries(db);
    assert.equal(result.length, 2);
    assert.ok(result[0].id);
    assert.ok(result[0].title);
    assert.equal(result[0].type, "fact");
    assert.equal(typeof result[0].confidence, "number");
    assert.equal(typeof result[0].age_days, "number");
    assert.equal(typeof result[0].fragment_preview, "string");
  });

  test("filters by project", () => {
    seedFragments(["Alpha"], "projA");
    seedFragments(["Beta"], "projB");
    seedFragments(["Gamma"], null);

    const resultA = lib.collectFragmentSummaries(db, "projA");
    assert.equal(resultA.length, 1);
    assert.equal(resultA[0].title, "Alpha");

    const resultB = lib.collectFragmentSummaries(db, "projB");
    assert.equal(resultB.length, 1);
    assert.equal(resultB[0].title, "Beta");
  });

  test("includes age_days calculation", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.5, datetime('now', '-10 days'), datetime('now', '-10 days'))`
    ).run("m_age", "Old mem", "Old mem", "Old mem");

    const result = lib.collectFragmentSummaries(db);
    assert.equal(result.length, 1);
    assert.ok(result[0].age_days >= 10);
  });

  test("includes relation_count", () => {
    seedFragments(["Source", "Target"]);
    const ids = lib.collectFragmentSummaries(db).map(f => f.id);
    seedRelation(ids[0], ids[1], "supports");

    const result = lib.collectFragmentSummaries(db);
    const source = result.find(f => f.id === ids[0]);
    assert.ok(source);
    assert.equal(source.relation_count, 1);
  });
});

describe("collectGuideSummaries", () => {
  test("returns empty for empty DB", () => {
    const result = lib.collectGuideSummaries(db);
    assert.deepEqual(result, []);
  });

  test("includes success_rate calculation", () => {
    seedGuide("react", "web-frontend", 10, 8, 2);
    const result = lib.collectGuideSummaries(db);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "react");
    assert.equal(result[0].success_rate, 0.8);
    assert.equal(result[0].usage_count, 10);
    assert.equal(result[0].success_count, 8);
    assert.equal(result[0].failure_count, 2);
  });

  test("returns null success_rate for unused guides", () => {
    seedGuide("unused", "dev-tool", 0, 0, 0);
    const result = lib.collectGuideSummaries(db);
    assert.equal(result.length, 1);
    assert.equal(result[0].success_rate, null);
    assert.equal(result[0].usage_count, 0);
  });
});

describe("collectRelationSummary", () => {
  test("identifies isolated fragments (no relations in either direction)", () => {
    seedFragments(["Lonely", "Connected"]);
    const ids = lib.collectFragmentSummaries(db).map(f => f.id);
    seedRelation(ids[1], ids[0], "related_to");

    const result = lib.collectRelationSummary(db, ids);
    assert.equal(result.isolated_fragment_ids.length, 0);
  });

  test("identifies truly isolated fragment with no relations at all", () => {
    seedFragments(["Lonely"]);
    const ids = lib.collectFragmentSummaries(db).map(f => f.id);
    const result = lib.collectRelationSummary(db, ids);
    assert.equal(result.isolated_fragment_ids.length, 1);
    assert.equal(result.isolated_fragment_ids[0], ids[0]);
  });

  test("identifies hub fragments (5+ relations)", () => {
    const titles: string[] = ["Hub"];
    for (let i = 0; i < 6; i++) titles.push(`Target ${i}`);
    seedFragments(titles);
    const summaries = lib.collectFragmentSummaries(db);
    const hub = summaries.find(s => s.title === "Hub")!;
    const targets = summaries.filter(s => s.title.startsWith("Target"));

    for (let i = 0; i < 6; i++) {
      seedRelation(hub.id, targets[i].id, "related_to");
    }

    const ids = summaries.map(f => f.id);
    const result = lib.collectRelationSummary(db, ids);
    assert.equal(result.hub_fragments.length, 1);
    assert.equal(result.hub_fragments[0].title, "Hub");
    assert.ok(result.hub_fragments[0].count >= 5);
  });

  test("counts by_type correctly", () => {
    seedFragments(["A", "B", "C"]);
    const ids = lib.collectFragmentSummaries(db).map(f => f.id);
    seedRelation(ids[0], ids[1], "supports");
    seedRelation(ids[1], ids[2], "contradicts");

    const result = lib.collectRelationSummary(db, ids);
    assert.ok(result.total >= 2);
    assert.ok(result.by_type["supports"] >= 1);
    assert.ok(result.by_type["contradicts"] >= 1);
  });
});

describe("collectAnalysisSignals", () => {
  test("computes confidence distribution", () => {
    seedFragments(["Conf1"]);
    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok("0.6-0.8" in signals.confidence_distribution);
    assert.equal(signals.confidence_distribution["0.6-0.8"], 1);
  });

  test("computes age distribution", () => {
    seedFragments(["Recent"]);
    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok("< 7" in signals.age_distribution);
    assert.equal(signals.age_distribution["< 7"], 1);
  });

  test("identifies stale fragments (old + unused + low confidence)", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.3, 0, datetime('now', '-60 days'), datetime('now', '-60 days'))`
    ).run("m_old1", "Old fragment", "Old fragment", "Old fragment");

    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok(signals.stale_fragments.length >= 1);
    assert.equal(signals.stale_fragments[0].title, "Old fragment");
    assert.ok(signals.stale_fragments[0].age_days >= 30);
    assert.ok(signals.stale_fragments[0].confidence < 0.5);
  });

  test("identifies distill candidates", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, distill_candidate, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.7, 1, datetime('now'), datetime('now'))`
    ).run("m_dist1", "Distillable", "Distillable", "Distillable");

    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.equal(signals.distill_candidates.length, 1);
    assert.equal(signals.distill_candidates[0].title, "Distillable");
  });

  test("identifies never-accessed count", () => {
    seedFragments(["NeverAccessed"]);
    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok(signals.never_accessed_count >= 1);
  });

  test("identifies deprecated guides", () => {
    seedGuide("old-guide", "dev-tool", 5, 3, 2, true);
    seedGuide("active-guide", "dev-tool", 3, 2, 1, false);
    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.equal(signals.deprecated_guides.length, 1);
    assert.equal(signals.deprecated_guides[0], "old-guide");
  });

  test("identifies superseded fragments", () => {
    seedFragments(["Old Version", "New Version"]);
    const summaries = lib.collectFragmentSummaries(db);
    const oldFrag = summaries.find(s => s.title === "Old Version")!;
    const newFrag = summaries.find(s => s.title === "New Version")!;
    seedRelation(newFrag.id, oldFrag.id, "supersedes");

    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok(signals.superseded_fragments.length >= 1);
    assert.ok(signals.superseded_fragments.some(s => s.title === "Old Version"));
  });

  test("detects dangling guide links from JSON fields", () => {
    db.prepareCached(
      `INSERT INTO guides (guide, category, description, source_memories, usage_count, success_count, failure_count, deprecated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run("broken-guide", "test", "desc", JSON.stringify(["m_nonexistent_1", "m_nonexistent_2"]), 0, 0, 0, 0);

    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok(signals.dangling_guide_links.length >= 2);
    assert.ok(signals.dangling_guide_links.every(d => d.guide === "broken-guide"));
  });

  test("guide_memory_links table is protected by FK — no dangling possible", () => {
    seedFragments(["Existing"]);
    const memRow = db.prepareCached(`SELECT id FROM memories WHERE title = 'Existing'`).get() as { id: number } | undefined;
    db.prepareCached(
      `INSERT INTO guides (guide, category, description, usage_count, success_count, failure_count, deprecated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run("link-guide", "test", "desc", 0, 0, 0, 0);
    const guideRow = db.prepareCached(`SELECT id FROM guides WHERE guide = ?`).get("link-guide") as { id: number } | undefined;
    db.prepareCached(
      `INSERT OR IGNORE INTO guide_memory_links (guide_id, memory_id, link_type) VALUES (?, ?, 'source')`
    ).run(guideRow!.id, memRow!.id);

    const fragments = lib.collectFragmentSummaries(db);
    const signals = lib.collectAnalysisSignals(db, fragments);
    assert.ok(!signals.dangling_guide_links.some(d => d.guide === "link-guide"));
  });
});

describe("findSimilarPairs", () => {
  test("detects high-overlap fragment pairs", () => {
    const fragments: lib.FragmentSummary[] = [
      { id: "a1", title: "React hooks state management", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "React hooks state management" },
      { id: "b1", title: "React hooks state patterns", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "React hooks state patterns" },
    ];
    const pairs = lib.findSimilarPairs(fragments);
    assert.ok(pairs.length >= 1);
    assert.ok(pairs[0].overlap >= 0.3);
  });

  test("ignores low-overlap pairs", () => {
    const fragments: lib.FragmentSummary[] = [
      { id: "a2", title: "Quantum physics entanglement", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "Quantum physics entanglement" },
      { id: "b2", title: "Cooking recipes Italian pasta", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "Cooking recipes Italian pasta" },
    ];
    const pairs = lib.findSimilarPairs(fragments);
    assert.equal(pairs.length, 0);
  });

  test("limits to top 20 pairs", () => {
    const fragments: lib.FragmentSummary[] = [];
    for (let i = 0; i < 25; i++) {
      fragments.push({
        id: `x${i}`,
        title: `React component state management hooks pattern ${i}`,
        type: "fact",
        project: null,
        confidence: 0.7,
        age_days: 0,
        access_count: 0,
        positive_feedback: 0,
        negative_feedback: 0,
        distill_candidate: false,
        relation_count: 0,
        fragment_preview: `React component state management hooks pattern ${i}`,
      });
    }
    const pairs = lib.findSimilarPairs(fragments);
    assert.ok(pairs.length <= 20);
  });

  test("skips similarity when fragment count > 200", () => {
    const fragments: lib.FragmentSummary[] = [];
    for (let i = 0; i < 201; i++) {
      fragments.push({
        id: `y${i}`,
        title: `Duplicate content title ${i}`,
        type: "fact",
        project: null,
        confidence: 0.7,
        age_days: 0,
        access_count: 0,
        positive_feedback: 0,
        negative_feedback: 0,
        distill_candidate: false,
        relation_count: 0,
        fragment_preview: `Duplicate content title ${i}`,
      });
    }
    const pairs = lib.findSimilarPairs(fragments);
    assert.equal(pairs.length, 0);
  });
});

describe("generateSuggestions", () => {
  test("returns correct priority order", () => {
    const snapshot: lib.LibrarySnapshot = {
      generated_at: new Date().toISOString(),
      total_memories: 5,
      total_guides: 1,
      total_sessions: 0,
      health_status: "HEALTHY",
      fragments: [],
      guides: [{ name: "bad", category: "test", usage_count: 5, success_count: 1, failure_count: 4, success_rate: 0.2, learning_count: 0, deprecated: true, source_memory_count: 0 }],
      relations: { total: 0, by_type: {}, isolated_fragment_ids: ["x1"], hub_fragments: [],  },
      signals: {
        confidence_distribution: {},
        age_distribution: {},
        stale_fragments: [{ id: "s1", title: "stale", age_days: 60, confidence: 0.3 }],
        similarity_candidates: [{ id_a: "a", id_b: "b", title_a: "ta", title_b: "tb", overlap: 0.5 }],
        distill_candidates: [{ id: "d1", title: "dist", type: "pattern" }],
        low_performing_guides: [{ name: "bad", success_rate: 0.2, usage: 5 }],
        type_distribution: {},
        project_distribution: {},
        never_accessed_count: 3,
        deprecated_guides: [],
        superseded_fragments: [],
        dangling_guide_links: [],
      },
      session_activity: { recent_count: 0, outcomes: {}, most_accessed: [], never_accessed_count: 3 },
      suggestions: [],
    };

    const suggestions = lib.generateSuggestions(snapshot);
    assert.ok(suggestions.length >= 4);

    const firstHigh = suggestions.findIndex(s => s.startsWith("HIGH"));
    const firstMedium = suggestions.findIndex(s => s.startsWith("MEDIUM"));
    const firstLow = suggestions.findIndex(s => s.startsWith("LOW"));
    assert.ok(firstHigh < firstMedium);
    assert.ok(firstMedium < firstLow);
  });

  test("suggests RETYPE when fact-heavy", () => {
    const snapshot: lib.LibrarySnapshot = {
      generated_at: new Date().toISOString(),
      total_memories: 20,
      total_guides: 0,
      total_sessions: 0,
      health_status: "HEALTHY",
      fragments: [],
      guides: [],
      relations: { total: 0, by_type: {}, isolated_fragment_ids: [], hub_fragments: [],  },
      signals: {
        confidence_distribution: {},
        age_distribution: {},
        stale_fragments: [],
        similarity_candidates: [],
        distill_candidates: [],
        low_performing_guides: [],
        type_distribution: { fact: 15, pattern: 2, lesson: 1 },
        project_distribution: {},
        never_accessed_count: 0,
        deprecated_guides: [],
        superseded_fragments: [],
        dangling_guide_links: [],
      },
      session_activity: { recent_count: 0, outcomes: {}, most_accessed: [], never_accessed_count: 0 },
      suggestions: [],
    };
    const suggestions = lib.generateSuggestions(snapshot);
    assert.ok(suggestions.some(s => s.includes("RETYPE")));
  });

  test("suggests ORPHAN when dangling guide links exist", () => {
    const snapshot: lib.LibrarySnapshot = {
      generated_at: new Date().toISOString(),
      total_memories: 1,
      total_guides: 1,
      total_sessions: 0,
      health_status: "HEALTHY",
      fragments: [],
      guides: [],
      relations: { total: 0, by_type: {}, isolated_fragment_ids: [], hub_fragments: [],  },
      signals: {
        confidence_distribution: {},
        age_distribution: {},
        stale_fragments: [],
        similarity_candidates: [],
        distill_candidates: [],
        low_performing_guides: [],
        type_distribution: {},
        project_distribution: {},
        never_accessed_count: 0,
        deprecated_guides: [],
        superseded_fragments: [],
        dangling_guide_links: [{ guide: "test", memory_id: "m_dead" }],
      },
      session_activity: { recent_count: 0, outcomes: {}, most_accessed: [], never_accessed_count: 0 },
      suggestions: [],
    };
    const suggestions = lib.generateSuggestions(snapshot);
    assert.ok(suggestions.some(s => s.includes("ORPHAN")));
  });

  test("returns empty for healthy DB", () => {
    const snapshot: lib.LibrarySnapshot = {
      generated_at: new Date().toISOString(),
      total_memories: 2,
      total_guides: 0,
      total_sessions: 0,
      health_status: "HEALTHY",
      fragments: [],
      guides: [],
      relations: { total: 0, by_type: {}, isolated_fragment_ids: [], hub_fragments: [],  },
      signals: {
        confidence_distribution: {},
        age_distribution: {},
        stale_fragments: [],
        similarity_candidates: [],
        distill_candidates: [],
        low_performing_guides: [],
        type_distribution: {},
        project_distribution: {},
        never_accessed_count: 0,
        deprecated_guides: [],
        superseded_fragments: [],
        dangling_guide_links: [],
      },
      session_activity: { recent_count: 0, outcomes: {}, most_accessed: [], never_accessed_count: 0 },
      suggestions: [],
    };

    const suggestions = lib.generateSuggestions(snapshot);
    assert.deepEqual(suggestions, []);
  });
});

describe("formatLibrarySnapshot", () => {
  test("produces valid text with all sections in full mode", () => {
    seedFragments(["Test Fragment"]);
    const snapshot = lib.collectLibrarySnapshot(db);
    const text = lib.formatLibrarySnapshot(snapshot, "full");
    assert.ok(text.includes("LIBRARY MODE SNAPSHOT"));
    assert.ok(text.includes("Generated:"));
    assert.ok(text.includes("Total memories:"));
    assert.ok(text.includes("Database health:"));
  });

  test("respects focus=stale filter", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.3, 0, datetime('now', '-60 days'), datetime('now', '-60 days'))`
    ).run("m_stale", "Stale one", "Stale one", "Stale one");

    const snapshot = lib.collectLibrarySnapshot(db, { focus: "stale" });
    const text = lib.formatLibrarySnapshot(snapshot, "stale");
    assert.ok(text.includes("Stale Fragments"));
    assert.ok(!text.includes("ANALYSIS SIGNALS"));
    assert.ok(!text.includes("SESSION ACTIVITY"));
  });

  test("respects focus=guides filter", () => {
    seedGuide("react", "web-frontend", 5, 4, 1);
    const snapshot = lib.collectLibrarySnapshot(db, { focus: "guides" });
    const text = lib.formatLibrarySnapshot(snapshot, "guides");
    assert.ok(text.includes("GUIDES"));
    assert.ok(!text.includes("ANALYSIS SIGNALS"));
    assert.ok(!text.includes("SESSION ACTIVITY"));
  });
});

describe("collectLibrarySnapshot", () => {
  test("with single fragment returns valid structure", () => {
    seedFragments(["Single"]);
    const snapshot = lib.collectLibrarySnapshot(db);
    assert.equal(snapshot.total_memories, 1);
    assert.equal(snapshot.fragments.length, 1);
    assert.equal(snapshot.fragments[0].title, "Single");
    assert.ok(snapshot.generated_at);
    assert.equal(typeof snapshot.health_status, "string");
    assert.ok(Array.isArray(snapshot.suggestions));
  });
});

describe("collectSessionActivity", () => {
  test("returns recent session count", () => {
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, status, started_at) VALUES (?, 'implementation', 'completed', datetime('now'))`
    ).run("sess1");

    const activity = lib.collectSessionActivity(db);
    assert.equal(activity.recent_count, 1);
  });

  test("outcomes only include last 30 days", () => {
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, status, outcome, started_at, ended_at) VALUES (?, 'implementation', 'completed', 'success', datetime('now', '-10 days'), datetime('now', '-10 days'))`
    ).run("sess_recent");
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, status, outcome, started_at, ended_at) VALUES (?, 'implementation', 'completed', 'failure', datetime('now', '-60 days'), datetime('now', '-60 days'))`
    ).run("sess_old");

    const activity = lib.collectSessionActivity(db);
    assert.equal(activity.recent_count, 1);
    assert.equal(activity.outcomes["success"], 1);
    assert.equal(activity.outcomes["failure"], undefined);
  });

  test("most_accessed only includes memories accessed in last 30 days", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, last_accessed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.9, 100, datetime('now', '-5 days'), datetime('now'), datetime('now'))`
    ).run("m_recent", "Recent Access", "Recent Access", "Recent Access");
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, last_accessed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.9, 500, datetime('now', '-90 days'), datetime('now'), datetime('now'))`
    ).run("m_old", "Old Access", "Old Access", "Old Access");

    const activity = lib.collectSessionActivity(db);
    assert.ok(activity.most_accessed.some(m => m.id === "m_recent"));
    assert.ok(!activity.most_accessed.some(m => m.id === "m_old"));
  });
});

describe("findSimilarPairs (word overlap via findSimilarPairs)", () => {
  test("returns overlap 1.0 for identical title+preview strings", () => {
    const fragments: lib.FragmentSummary[] = [
      { id: "s1", title: "hello world foo bar", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "hello world foo bar" },
      { id: "s2", title: "hello world foo bar", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "hello world foo bar" },
    ];
    const pairs = lib.findSimilarPairs(fragments);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].overlap, 1);
  });

  test("returns empty for completely different strings", () => {
    const fragments: lib.FragmentSummary[] = [
      { id: "s3", title: "alpha beta gamma", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "alpha beta gamma" },
      { id: "s4", title: "delta epsilon zeta", type: "fact", project: null, confidence: 0.7, age_days: 0, access_count: 0, positive_feedback: 0, negative_feedback: 0, distill_candidate: false, relation_count: 0, fragment_preview: "delta epsilon zeta" },
    ];
    const pairs = lib.findSimilarPairs(fragments);
    assert.equal(pairs.length, 0);
  });
});

describe("edge cases", () => {
  test("handles very long fragment text (truncation)", () => {
    const longTitle = "A".repeat(200);
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.7, datetime('now'), datetime('now'))`
    ).run("m_long", longTitle, longTitle, longTitle);

    const result = lib.collectFragmentSummaries(db);
    assert.equal(result.length, 1);
    assert.ok(result[0].fragment_preview.length <= 80);
    assert.ok(result[0].title.length <= 200);
  });

  test("handles special characters in titles", () => {
    const specialTitle = "Test with 'quotes' and \"double\" and <html> & stuff";
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.7, datetime('now'), datetime('now'))`
    ).run("m_special", specialTitle, specialTitle, specialTitle);

    const result = lib.collectFragmentSummaries(db);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, specialTitle);
  });

  test("handles database with only stale fragments", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.3, 0, datetime('now', '-60 days'), datetime('now', '-60 days'))`
    ).run("m_stale1", "Stale A", "Stale A", "Stale A");
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'fact', NULL, 'ai', 0.2, 0, datetime('now', '-90 days'), datetime('now', '-90 days'))`
    ).run("m_stale2", "Stale B", "Stale B", "Stale B");

    const snapshot = lib.collectLibrarySnapshot(db);
    assert.ok(snapshot.signals.stale_fragments.length >= 2);
    assert.ok(snapshot.suggestions.some(s => s.includes("STALE")));
  });

  test("handles database with only high-confidence well-accessed fragments", () => {
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'lesson', NULL, 'ai', 0.95, 10, datetime('now'), datetime('now'))`
    ).run("m_hc1", "Optimized React Rendering", "Optimized React Rendering", "Optimized React Rendering");
    db.prepareCached(
      `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'pattern', NULL, 'ai', 0.88, 5, datetime('now'), datetime('now'))`
    ).run("m_hc2", "Database Connection Pooling", "Database Connection Pooling", "Database Connection Pooling");

    const snapshot = lib.collectLibrarySnapshot(db);
    assert.equal(snapshot.signals.stale_fragments.length, 0);
    assert.equal(snapshot.signals.similarity_candidates.length, 0);
    assert.equal(snapshot.signals.distill_candidates.length, 0);
    assert.ok(snapshot.suggestions.length <= 2, `Expected <= 2 suggestions but got ${snapshot.suggestions.length}: ${snapshot.suggestions.join("; ")}`);
  });

  test("handles all fragments in one project", () => {
    seedFragments(["P1", "P2", "P3"], "single-project");
    const snapshot = lib.collectLibrarySnapshot(db, { project: "single-project" });
    assert.equal(snapshot.fragments.length, 3);
    assert.ok(snapshot.fragments.every(f => f.project === "single-project"));
  });

  test("handles all global fragments", () => {
    seedFragments(["G1", "G2"], null);
    const snapshot = lib.collectLibrarySnapshot(db);
    assert.ok(snapshot.fragments.every(f => f.project === null));
  });

  test("handles all deprecated guides", () => {
    seedGuide("deprecated1", "dev-tool", 5, 3, 2, true);
    seedGuide("deprecated2", "web-frontend", 2, 1, 1, true);
    const guides = lib.collectGuideSummaries(db);
    assert.ok(guides.every(g => g.deprecated));
  });

  test("collectLibrarySnapshot with empty database returns valid structure", () => {
    const snapshot = lib.collectLibrarySnapshot(db);
    assert.equal(snapshot.total_memories, 0);
    assert.equal(snapshot.total_guides, 0);
    assert.equal(snapshot.total_sessions, 0);
    assert.equal(snapshot.fragments.length, 0);
    assert.equal(snapshot.guides.length, 0);
    assert.equal(snapshot.health_status, "HEALTHY");
    assert.deepEqual(snapshot.suggestions, []);
  });

  test("formatLibrarySnapshot shows isolated count in full mode", () => {
    seedFragments(["Test"]);
    const snapshot = lib.collectLibrarySnapshot(db);
    const text = lib.formatLibrarySnapshot(snapshot, "full");
    assert.ok(text.includes("Isolated fragments"));
  });

  test("formatLibrarySnapshot shows deprecated guides and dangling links when present", () => {
    db.prepareCached(
      `INSERT INTO guides (guide, category, description, source_memories, usage_count, success_count, failure_count, deprecated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run("dead-guide", "test", "desc", JSON.stringify(["m_ghost"]), 0, 0, 0, 1);

    seedFragments(["Filler"]);
    const snapshot = lib.collectLibrarySnapshot(db, { focus: "full" });
    const text = lib.formatLibrarySnapshot(snapshot, "full");
    assert.ok(text.includes("Deprecated Guides"));
    assert.ok(text.includes("Dangling Guide Links"));
  });
});
