import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";
import { buildVectorsCached } from "../../src/intelligence/vector-cache.js";
import { buildVectors, findSemanticSimilar } from "../../src/intelligence/semantic.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-vcache-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(TMPDIR, { recursive: true, force: true }); });

function seedFrags(): MemoryFragment[] {
  const specs = [
    ["redis caching layer for sessions", "Redis"],
    ["postgres indexing and query planning", "Postgres"],
    ["kafka partition consumer groups", "Kafka"],
  ];
  return specs.map(([body, title]) => {
    const { legacy_id } = store.addMemory(db, body, "ai", title, null, undefined, "fact");
    return { id: legacy_id, title, fragment: body, description: "" } as MemoryFragment;
  });
}

describe("A4 — TF-IDF vector cache", () => {
  test("fresh DB has the tfidf_cache table", () => {
    assert.ok(db.prepareCached("SELECT name FROM sqlite_master WHERE type='table' AND name='tfidf_cache'").get());
  });

  test("populates the cache on first build and reuses it on the second", () => {
    const frags = seedFrags();
    assert.equal((db.prepareCached("SELECT COUNT(*) c FROM tfidf_cache").get() as { c: number }).c, 0);

    buildVectorsCached(db, frags);
    const after1 = (db.prepareCached("SELECT COUNT(*) c FROM tfidf_cache").get() as { c: number }).c;
    assert.equal(after1, 3, "all three cached");

    // Second call must not error and must keep the cache populated (hits).
    const vecs = buildVectorsCached(db, frags);
    assert.equal(vecs.length, 3);
    assert.equal((db.prepareCached("SELECT COUNT(*) c FROM tfidf_cache").get() as { c: number }).c, 3);
  });

  test("cached vectors rank queries the same as the live builder", () => {
    const frags = seedFrags();
    const live = findSemanticSimilar("redis session cache", buildVectors(frags), 3, -Infinity);
    const cachedVecs = buildVectorsCached(db, frags);
    const cached = findSemanticSimilar("redis session cache", cachedVecs, 3, -Infinity);
    assert.deepEqual(cached.map(r => r.memory_id), live.map(r => r.memory_id), "same ranking order");
  });

  test("refreshes the cached TF map when content changes", () => {
    const frags = seedFrags();
    buildVectorsCached(db, frags);
    const before = (db.prepareCached("SELECT content_hash FROM tfidf_cache WHERE legacy_id = ?").get(frags[0].id) as { content_hash: string }).content_hash;

    // Change the content of the first fragment and rebuild.
    frags[0] = { ...frags[0], fragment: "redis pub/sub and streams, completely rewritten" };
    buildVectorsCached(db, frags);
    const after = (db.prepareCached("SELECT content_hash FROM tfidf_cache WHERE legacy_id = ?").get(frags[0].id) as { content_hash: string }).content_hash;
    assert.notEqual(after, before, "hash refreshed on content change");
  });
});
