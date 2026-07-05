import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";
import { computeSelfConsistency, scanOutcomeConsistency, outcomeConsistencySuggestions } from "../../src/intelligence/consistency.js";

describe("C4 — computeSelfConsistency (pure)", () => {
  test("unanimous success is corroborated", () => {
    const r = computeSelfConsistency(["success", "success", "success", "success"]);
    assert.equal(r.verdict, "corroborated");
    assert.equal(r.successRate, 1);
    assert.equal(r.agreement, 1);
  });

  test("mostly-failure is unreliable", () => {
    const r = computeSelfConsistency(["failure", "failure", "success", "failure"]);
    assert.equal(r.verdict, "unreliable");
    assert.ok(r.successRate <= 0.34);
  });

  test("50/50 split is divergent", () => {
    const r = computeSelfConsistency(["success", "failure", "success", "failure"]);
    assert.equal(r.verdict, "divergent");
    assert.ok(r.agreement < 0.5);
  });

  test("fewer than 3 outcomes is insufficient", () => {
    assert.equal(computeSelfConsistency(["success", "success"]).verdict, "insufficient");
    assert.equal(computeSelfConsistency([]).verdict, "insufficient");
  });

  test("unknown outcome strings are ignored", () => {
    const r = computeSelfConsistency(["success", "bogus", "success", "success"]);
    assert.equal(r.total, 3, "only known outcomes counted");
    assert.equal(r.verdict, "corroborated");
  });
});

describe("C4 — scanOutcomeConsistency + suggestions (DB)", () => {
  let TMPDIR: string;
  let db: LemmaDB;

  beforeEach(() => {
    TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-consistency-"));
    db = new LemmaDB(path.join(TMPDIR, "test.db"));
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  });

  function addSession(id: string, outcome: string): void {
    db.prepareCached(
      `INSERT INTO sessions (id, status, outcome, started_at) VALUES (?, 'completed', ?, datetime('now'))`,
    ).run(id, outcome);
  }
  function link(sessionId: string, memoryId: number): void {
    db.prepareCached(
      `INSERT OR IGNORE INTO session_memory_links (session_id, memory_id, interaction_type) VALUES (?, ?, 'read')`,
    ).run(sessionId, memoryId);
  }

  test("aggregates per-fragment outcomes and flags a divergent fragment", () => {
    const { id, legacy_id } = store.addMemory(db, "flaky retry pattern", "ai", "Retry", null, undefined, "pattern");
    addSession("s1", "success"); addSession("s2", "failure");
    addSession("s3", "success"); addSession("s4", "failure");
    for (const s of ["s1", "s2", "s3", "s4"]) link(s, id);

    const scan = scanOutcomeConsistency(db);
    const r = scan.get(legacy_id)!;
    assert.ok(r, "fragment present in scan");
    assert.equal(r.total, 4);
    assert.equal(r.verdict, "divergent");

    const suggestions = outcomeConsistencySuggestions(db, () => "Retry");
    assert.ok(suggestions.some(s => s.message.includes(legacy_id) && /divergent/i.test(s.message)));
  });

  test("a consistently-successful fragment is not flagged for review", () => {
    const { id, legacy_id } = store.addMemory(db, "solid pattern", "ai", "Solid", null, undefined, "pattern");
    for (const [i, o] of ["success", "success", "success", "success"].entries()) {
      addSession(`ok${i}`, o); link(`ok${i}`, id);
    }
    const r = scanOutcomeConsistency(db).get(legacy_id)!;
    assert.equal(r.verdict, "corroborated");
    const suggestions = outcomeConsistencySuggestions(db, () => "Solid");
    // No review flag for this fragment; only the aggregate corroboration note.
    assert.ok(!suggestions.some(s => s.message.includes(legacy_id) && /(divergent|unreliable)/i.test(s.message)));
    assert.ok(suggestions.some(s => /corroborated/i.test(s.message)));
  });
});
