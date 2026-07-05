import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";
import { reciprocalRankFusion, mmrRerank, hybridSearch } from "../../src/intelligence/hybrid.js";

describe("A4 — Reciprocal Rank Fusion", () => {
  test("rewards items ranked highly by multiple rankers", () => {
    const rrf = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    // 'a' (ranks 0,1) and 'b' (ranks 1,0) both appear in both lists near the top.
    assert.ok(rrf.get("b")! > rrf.get("c")!, "b (in both) beats c (in one)");
    assert.ok(rrf.get("a")! > rrf.get("d")!, "a (in both) beats d (in one)");
  });

  test("uses the k constant (default 60)", () => {
    const rrf = reciprocalRankFusion([["x"]]);
    assert.ok(Math.abs(rrf.get("x")! - 1 / 61) < 1e-9);
  });
});

describe("A4 — MMR rerank", () => {
  test("suppresses a near-duplicate in favor of a diverse item", () => {
    // a and b are identical (sim 1); c is unrelated (sim 0).
    const sim = (x: string, y: string) => (x === y ? 1 : (new Set([x, y]).size === 2 && [x, y].every(v => v === "a" || v === "b") ? 0.95 : 0));
    const ranked = [
      { id: "a", relevance: 1.0 },
      { id: "b", relevance: 0.98 },
      { id: "c", relevance: 0.9 },
    ];
    const order = mmrRerank(ranked, sim, 0.7, 2);
    assert.equal(order[0], "a", "most relevant first");
    assert.equal(order[1], "c", "diverse c chosen over near-duplicate b");
  });

  test("lambda=1 is pure relevance order", () => {
    const order = mmrRerank(
      [{ id: "a", relevance: 0.5 }, { id: "b", relevance: 0.9 }],
      () => 1,
      1,
    );
    assert.deepEqual(order, ["b", "a"]);
  });
});

describe("A4 — hybridSearch (DB)", () => {
  let TMPDIR: string;
  let db: LemmaDB;
  beforeEach(() => {
    TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-hybrid-"));
    db = new LemmaDB(path.join(TMPDIR, "test.db"));
    runMigrations(db);
  });
  afterEach(() => { db.close(); fs.rmSync(TMPDIR, { recursive: true, force: true }); });

  test("fuses keyword + semantic and returns relevant fragments", () => {
    store.addMemory(db, "postgres connection pooling with pgbouncer for high concurrency", "ai", "PG pooling", null, undefined, "fact");
    store.addMemory(db, "database connection pool sizing and pgbouncer transaction mode", "ai", "Pool sizing", null, undefined, "fact");
    store.addMemory(db, "react hooks useEffect cleanup and dependency arrays", "ai", "React hooks", null, undefined, "fact");

    const results = hybridSearch(db, "pgbouncer connection pool", { topK: 3 });
    assert.ok(results.length >= 1);
    // The pgbouncer fragments should outrank the unrelated react one.
    const top = results[0].memory_id;
    const topFrag = db.prepareCached("SELECT fragment FROM memories WHERE legacy_id = ?").get(top) as { fragment: string };
    assert.match(topFrag.fragment, /pgbouncer|pool/i);
    assert.ok(!/react/i.test(topFrag.fragment), "unrelated fragment not ranked first");
  });

  test("excludes invalidated fragments from hybrid results", () => {
    const { id } = store.addMemory(db, "obscure kafka rebalancing note", "ai", "Kafka", null, undefined, "fact");
    store.invalidateMemory(db, id);
    const results = hybridSearch(db, "kafka rebalancing", { topK: 5 });
    assert.equal(results.length, 0);
  });

  test("empty query / empty DB returns []", () => {
    assert.deepEqual(hybridSearch(db, "anything", { topK: 5 }), []);
  });
});
