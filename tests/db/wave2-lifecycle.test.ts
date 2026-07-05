import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";
import { setConfigDir, resetConfig } from "../../src/memory/config.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-wave2-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
  setConfigDir(TMPDIR);
  resetConfig();
});

afterEach(() => {
  db.close();
  resetConfig();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seed(type: string, confidence = 0.7, accessCount = 0): number {
  const legacy = "m" + Math.random().toString(36).slice(2, 14);
  const r = db.prepareCached(
    `INSERT INTO memories (legacy_id, title, fragment, description, type, source, confidence, access_count, access_window, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(legacy, `${type} title`, `${type} content`, `${type} desc`, type, confidence, accessCount, accessCount);
  return Number(r.lastInsertRowid);
}

function writeConfig(decay: unknown): void {
  fs.writeFileSync(path.join(TMPDIR, "config.json"), JSON.stringify({ decay }), "utf-8");
  resetConfig();
}

function confOf(id: number): number {
  return (db.prepareCached("SELECT confidence FROM memories WHERE id = ?").get(id) as { confidence: number }).confidence;
}

describe("B5 — decay model (config-gated)", () => {
  test("linear (default) drops confidence by 0.002 for unaccessed fragments", () => {
    const id = seed("fact", 0.7, 0);
    const changed = store.decayMemories(db);
    assert.ok(changed >= 1);
    assert.ok(Math.abs(confOf(id) - 0.698) < 1e-6, `expected 0.698, got ${confOf(id)}`);
  });

  test("ebbinghaus is type-aware: fast-decay warning drops more than slow-decay pattern", () => {
    writeConfig({ model: "ebbinghaus", half_life_days: { pattern: 180, warning: 30, fact: 60, lesson: 90, context: 120 } });
    const warn = seed("warning", 0.7, 0);
    const pat = seed("pattern", 0.7, 0);
    store.decayMemories(db);
    const warnConf = confOf(warn);
    const patConf = confOf(pat);
    assert.ok(warnConf < 0.7 && patConf < 0.7, "both should decay");
    assert.ok(warnConf < patConf, `warning (${warnConf}) should decay faster than pattern (${patConf})`);
  });

  test("accessed fragments are spared by decay", () => {
    const id = seed("fact", 0.7, 3); // access_count > 0
    store.decayMemories(db);
    assert.equal(confOf(id), 0.7, "accessed fragment must not decay");
  });
});

describe("B3 — non-destructive consolidation", () => {
  test("consolidate=true keeps sources, supersedes them, and down-weights", () => {
    const a = seed("fact", 0.8);
    const b = seed("fact", 0.8);
    const newId = store.mergeMemories(db, [a, b], "Merged", "merged content", undefined, true);
    assert.ok(newId);
    // Sources still exist (non-destructive).
    const remaining = db.prepareCached("SELECT COUNT(*) as n FROM memories WHERE id IN (?, ?)").get(a, b) as { n: number };
    assert.equal(remaining.n, 2, "sources must be kept");
    // Down-weighted so recall ignores them.
    assert.ok(confOf(a) <= 0.1 && confOf(b) <= 0.1, "sources must be down-weighted");
    // Merged supersedes each source.
    const rels = db.prepareCached(
      "SELECT COUNT(*) as n FROM relations WHERE source_id = ? AND type = 'supersedes' AND target_id IN (?, ?)",
    ).get(newId, a, b) as { n: number };
    assert.equal(rels.n, 2, "merged must supersede both sources");
  });

  test("default merge (consolidate=false) hard-deletes sources", () => {
    const a = seed("fact", 0.8);
    const b = seed("fact", 0.8);
    store.mergeMemories(db, [a, b], "Merged", "merged content");
    const remaining = db.prepareCached("SELECT COUNT(*) as n FROM memories WHERE id IN (?, ?)").get(a, b) as { n: number };
    assert.equal(remaining.n, 0, "sources must be deleted in default merge");
  });
});

describe("decay preserves the lifetime access_count (regression: window/lifetime collision)", () => {
  test("access_count survives a decay run; only the decay window resets", () => {
    const id = seed("fact", 0.7, 5); // access_count = access_window = 5
    store.decayMemories(db);
    const row = db.prepareCached(
      "SELECT access_count, access_window FROM memories WHERE id = ?"
    ).get(id) as { access_count: number; access_window: number };
    assert.equal(row.access_count, 5, "lifetime access_count must NOT be reset by decay");
    assert.equal(row.access_window, 0, "decay window must reset to 0");
    // And an accessed fragment (window > 0) is spared from confidence decay.
    assert.equal(confOf(id), 0.7, "accessed fragment must not decay");
  });

  test("an unaccessed fragment (window 0) still decays and keeps its lifetime count", () => {
    const id = seed("fact", 0.7, 0);
    store.decayMemories(db);
    const row = db.prepareCached(
      "SELECT access_count, access_window FROM memories WHERE id = ?"
    ).get(id) as { access_count: number; access_window: number };
    assert.equal(row.access_count, 0);
    assert.ok(Math.abs(confOf(id) - 0.698) < 1e-6, `expected 0.698, got ${confOf(id)}`);
  });
});
