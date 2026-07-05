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
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-b2-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("B2 — schema V5 (invalidated_at + fragment_history + trigger)", () => {
  test("fresh DB has the invalidated_at column, history table, and trigger", () => {
    const cols = db.prepareCached("PRAGMA table_info(memories)").all() as { name: string }[];
    assert.ok(cols.some(c => c.name === "invalidated_at"), "invalidated_at column present");

    const tbl = db.prepareCached("SELECT name FROM sqlite_master WHERE type='table' AND name='fragment_history'").get();
    assert.ok(tbl, "fragment_history table present");

    const trig = db.prepareCached("SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_history_au'").get();
    assert.ok(trig, "history trigger present");
  });

  test("an old (pre-V5) DB still opens and gains the column idempotently", () => {
    // Re-running migrations must be a no-op and not error.
    runMigrations(db);
    const cols = db.prepareCached("PRAGMA table_info(memories)").all() as { name: string }[];
    assert.ok(cols.some(c => c.name === "invalidated_at"));
  });
});

describe("B2 — fragment_history trigger", () => {
  test("records a prior version when CONTENT changes", () => {
    const { id } = store.addMemory(db, "original body", "ai", "Original title", null, undefined, "fact");
    store.updateMemory(db, id, { fragment: "revised body", title: "Revised title" });

    const history = store.getFragmentHistory(db, id);
    assert.equal(history.length, 1, "one prior version captured");
    assert.equal(history[0].fragment, "original body");
    assert.equal(history[0].title, "Original title");
  });

  test("does NOT record history for confidence-only changes (boost/decay)", () => {
    const { id } = store.addMemory(db, "stable body", "ai", "Stable", null, undefined, "fact");
    store.updateMemory(db, id, { confidence: 0.9 });
    store.boostConfidence(db, id, 0.02);
    store.decayMemories(db);
    assert.equal(store.getFragmentHistory(db, id).length, 0, "no history rows for non-content updates");
  });

  test("captures each successive content edit", () => {
    const { id } = store.addMemory(db, "v1", "ai", "T", null, undefined, "fact");
    store.updateMemory(db, id, { fragment: "v2" });
    store.updateMemory(db, id, { fragment: "v3" });
    const history = store.getFragmentHistory(db, id);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map(h => h.fragment), ["v2", "v1"], "newest-first");
  });
});

describe("B2 — logical invalidation (recall exclusion)", () => {
  test("invalidated fragments are hidden from recall but preserved", () => {
    const { id, legacy_id } = store.addMemory(db, "kafka partition rebalancing tips", "ai", "Kafka", null, undefined, "fact");

    // Visible before.
    assert.equal(store.searchMemories(db, "kafka").length, 1);

    assert.equal(store.invalidateMemory(db, id), true);

    // Hidden from recall...
    assert.equal(store.searchMemories(db, "kafka").length, 0, "excluded from search");
    assert.equal(store.searchMemories(db, "", { topK: 100 }).length, 0, "excluded from browse");
    // ...but still in the DB.
    const row = db.prepareCached("SELECT invalidated_at FROM memories WHERE legacy_id = ?").get(legacy_id) as { invalidated_at: string | null };
    assert.ok(row.invalidated_at, "row kept with a timestamp");

    // Visible when explicitly requested.
    assert.equal(store.searchMemories(db, "kafka", { includeInvalidated: true }).length, 1);
  });

  test("restore returns a fragment to recall", () => {
    const { id } = store.addMemory(db, "restorable content about redis", "ai", "Redis", null, undefined, "fact");
    store.invalidateMemory(db, id);
    assert.equal(store.searchMemories(db, "redis").length, 0);
    assert.equal(store.restoreMemory(db, id), true);
    assert.equal(store.searchMemories(db, "redis").length, 1, "back in recall after restore");
  });

  test("double-invalidate / double-restore report no change", () => {
    const { id } = store.addMemory(db, "idempotency body", "ai", "Idem", null, undefined, "fact");
    assert.equal(store.invalidateMemory(db, id), true);
    assert.equal(store.invalidateMemory(db, id), false, "already invalidated");
    assert.equal(store.restoreMemory(db, id), true);
    assert.equal(store.restoreMemory(db, id), false, "already live");
  });
});
