import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-b1-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

// Insert directly with a chosen confidence + age so Heat is controllable.
function seed(title: string, confidence: number, ageDays = 0): string {
  const legacy = "m" + Math.random().toString(36).slice(2, 14);
  db.prepareCached(
    `INSERT INTO memories (legacy_id, title, fragment, description, type, source, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'fact', 'ai', ?, datetime('now', ?), datetime('now'))`,
  ).run(legacy, title, title, title, confidence, `-${ageDays} days`);
  return legacy;
}

describe("B1 — Heat eviction to fragments_archive", () => {
  test("fresh DB has the fragments_archive table", () => {
    const tbl = db.prepareCached("SELECT name FROM sqlite_master WHERE type='table' AND name='fragments_archive'").get();
    assert.ok(tbl);
  });

  test("no-op when under capacity", () => {
    seed("a", 0.9); seed("b", 0.8);
    assert.equal(store.evictColdFragments(db, 10), 0);
    assert.equal(store.getArchiveCount(db), 0);
  });

  test("evicts the coldest fragments (lowest Heat) down to capacity, preserving them", () => {
    const hot = seed("hot high-confidence recent", 0.95, 0);
    const warm = seed("warm mid", 0.6, 30);
    const cold1 = seed("cold low-confidence old", 0.2, 300);
    const cold2 = seed("cold2 very old", 0.15, 400);

    // capacity 2 → evict the 2 coldest.
    const evicted = store.evictColdFragments(db, 2);
    assert.equal(evicted, 2);

    const liveIds = (db.prepareCached("SELECT legacy_id FROM memories").all() as { legacy_id: string }[]).map(r => r.legacy_id);
    assert.ok(liveIds.includes(hot) && liveIds.includes(warm), "hottest kept");
    assert.ok(!liveIds.includes(cold1) && !liveIds.includes(cold2), "coldest evicted");

    // Preserved in the archive (never hard-deleted).
    assert.equal(store.getArchiveCount(db), 2);
    const archived = (db.prepareCached("SELECT legacy_id FROM fragments_archive").all() as { legacy_id: string }[]).map(r => r.legacy_id);
    assert.ok(archived.includes(cold1) && archived.includes(cold2));
  });

  test("evicted fragments are gone from recall", () => {
    seed("keeper", 0.95, 0);
    const cold = seed("obscure evictable topic", 0.1, 500);
    store.evictColdFragments(db, 1);
    assert.equal(store.searchMemories(db, "obscure evictable").length, 0);
  });

  test("restoreFromArchive brings an evicted fragment back and empties its archive row", () => {
    seed("keeper", 0.95, 0);
    const cold = seed("restorable cold topic", 0.1, 500);
    store.evictColdFragments(db, 1);
    assert.equal(store.searchMemories(db, "restorable cold").length, 0);

    assert.equal(store.restoreFromArchive(db, cold), true);
    assert.equal(store.searchMemories(db, "restorable cold").length, 1, "back in recall");
    assert.equal(store.getArchiveCount(db), 0, "archive row consumed");
    // Restoring a non-archived id is a no-op.
    assert.equal(store.restoreFromArchive(db, "nope"), false);
  });
});
