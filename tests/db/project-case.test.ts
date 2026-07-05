import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import { addMemory, updateMemory, getMemoryStats, searchMemories } from "../../src/db/memory-store.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-case-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function getStoredProject(legacyId: string): string | null {
  const row = db.prepareCached("SELECT project FROM memories WHERE legacy_id = ?").get(legacyId) as
    | { project: string | null }
    | undefined;
  return row?.project ?? null;
}

describe("addMemory — project case normalization", () => {
  test("lowercases mixed-case project on store", () => {
    const { legacy_id } = addMemory(db, "fragment body", "ai", "Title", "MyProject");
    assert.equal(getStoredProject(legacy_id), "myproject");
  });

  test("trims surrounding whitespace before lowercasing", () => {
    const { legacy_id } = addMemory(db, "fragment body", "ai", "Title", "  SpacedProj  ");
    assert.equal(getStoredProject(legacy_id), "spacedproj");
  });

  test("collapses empty/whitespace project to null (global)", () => {
    const { legacy_id } = addMemory(db, "fragment body", "ai", "Title", "   ");
    assert.equal(getStoredProject(legacy_id), null);
  });

  test("keeps explicit null as null", () => {
    const { legacy_id } = addMemory(db, "fragment body", "ai", "Title", null);
    assert.equal(getStoredProject(legacy_id), null);
  });
});

describe("updateMemory — project case normalization", () => {
  test("normalizes project on update", () => {
    const { id, legacy_id } = addMemory(db, "fragment body", "ai", "Title", null);
    updateMemory(db, id, { project: "MixedCase" });
    assert.equal(getStoredProject(legacy_id), "mixedcase");
  });
});

describe("getMemoryStats — case-insensitive project filter", () => {
  test("matches stored mixed-case regardless of query case", () => {
    addMemory(db, "body one", "ai", "T1", "MyProject");
    // stored value is normalized to "myproject"; the query must match it from
    // any caller-supplied case without depending on the stored case.
    assert.equal(getMemoryStats(db, "MyProject").total, 1);
    assert.equal(getMemoryStats(db, "myproject").total, 1);
    assert.equal(getMemoryStats(db, "MYPROJECT").total, 1);
    assert.equal(getMemoryStats(db, "  myproject  ").total, 1);
  });

  test("collapses mixed-case variants into one bucket in by_project", () => {
    addMemory(db, "body one", "ai", "T1", "MyProject");
    addMemory(db, "body two", "ai", "T2", "myproject");
    addMemory(db, "body three", "ai", "T3", "MYPROJECT");
    const stats = getMemoryStats(db);
    // All three normalize to a single canonical key.
    assert.deepEqual(stats.by_project, { myproject: 3 });
  });

  test("excludes other projects and keeps global separate", () => {
    addMemory(db, "global one", "ai", "G1", null);
    addMemory(db, "a one", "ai", "A1", "alpha");
    addMemory(db, "b one", "ai", "B1", "Beta");
    const alphaStats = getMemoryStats(db, "alpha");
    assert.equal(alphaStats.total, 1);
    const betaStats = getMemoryStats(db, "BETA");
    assert.equal(betaStats.total, 1);
  });
});

describe("searchMemories — case-insensitive project filter (regression: bug #2)", () => {
  test("a mixed-case project filter matches normalized stored fragments", () => {
    addMemory(db, "use vite for bundling in this project", "ai", "Vite", "Lemma");
    // stored as normalized "lemma"; a query scoped to "Lemma"/"LEMMA" must match.
    assert.equal(searchMemories(db, "vite", { project: "lemma" }).length, 1);
    assert.equal(searchMemories(db, "vite", { project: "Lemma" }).length, 1);
    assert.equal(searchMemories(db, "vite", { project: "LEMMA" }).length, 1);
  });

  test("explicit null project returns global-only, not every project (regression: bug #3)", () => {
    addMemory(db, "prefer tabs over spaces globally", "ai", "GlobalPref", null);
    addMemory(db, "projA uses postgres database", "ai", "ProjA", "proja");
    const globalOnly = searchMemories(db, "", { project: null, topK: 100 });
    assert.ok(globalOnly.length >= 1);
    assert.ok(globalOnly.every(f => f.project === null),
      "a null-scoped query must not leak project-scoped fragments");
  });
});
