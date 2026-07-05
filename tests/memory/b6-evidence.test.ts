import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import * as store from "../../src/db/memory-store.js";
import { sha256, addEvidence, getEvidence, checkStale } from "../../src/memory/evidence.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-b6-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("B6 — memory_evidence schema + hashing", () => {
  test("fresh DB has the memory_evidence table", () => {
    assert.ok(db.prepareCached("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_evidence'").get());
  });

  test("addEvidence stores a SHA-256 of the snippet", () => {
    const { id } = store.addMemory(db, "uses retry with backoff", "ai", "Retry", null, undefined, "pattern");
    addEvidence(db, id, { file: "src/retry.ts", symbol: "withBackoff", snippet: "await sleep(2 ** i * 1000)" });
    const rows = getEvidence(db, id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].snippet_hash, sha256("await sleep(2 ** i * 1000)"));
    assert.equal(rows[0].file_path, "src/retry.ts");
    assert.equal(rows[0].symbol, "withBackoff");
  });
});

describe("B6 — staleness check", () => {
  test("fresh when the cited snippet is still present in the file", () => {
    const { id } = store.addMemory(db, "config parse", "ai", "Cfg", null, undefined, "fact");
    addEvidence(db, id, { file: "cfg.ts", snippet: "const PORT = 3456" });
    const reports = checkStale(db, id, () => "// header\nconst PORT = 3456\nexport {}");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].stale, false);
  });

  test("stale when the snippet has drifted out of the file", () => {
    const { id } = store.addMemory(db, "config parse", "ai", "Cfg", null, undefined, "fact");
    addEvidence(db, id, { file: "cfg.ts", snippet: "const PORT = 3456" });
    const reports = checkStale(db, id, () => "const PORT = 8080 // changed");
    assert.equal(reports[0].stale, true);
    assert.match(reports[0].reason, /no longer found/);
  });

  test("stale when the cited file cannot be read", () => {
    const { id } = store.addMemory(db, "config parse", "ai", "Cfg", null, undefined, "fact");
    addEvidence(db, id, { file: "gone.ts", snippet: "x" });
    const reports = checkStale(db, id, () => { throw new Error("ENOENT"); });
    assert.equal(reports[0].stale, true);
    assert.match(reports[0].reason, /could not be read/);
  });

  test("no evidence → no reports (fragments without citations are unaffected)", () => {
    const { id } = store.addMemory(db, "plain fact", "ai", "Plain", null, undefined, "fact");
    assert.deepEqual(checkStale(db, id, () => ""), []);
  });
});
