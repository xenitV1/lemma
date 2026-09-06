import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getDb, setDataDir, closeDb } from "../../src/db/database.js";
import { createBackup, previewRestore, restoreBackup } from "../../src/db/backup.js";

const fixture = fs.readFileSync(new URL("./fixtures/unused-vec0.sql", import.meta.url), "utf8");
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-legacy-backup-"));
  setDataDir(path.join(root, "source"));
});
afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
function addLegacy() {
  const db = getDb().db;
  db.unsafeMode(true); // Fixture only: emulate a table from the removed extension.
  try { db.exec(fixture); } finally { db.unsafeMode(false); }
  assert.equal(getDb().db.pragma("integrity_check", { simple: true }), "ok");
}
function info() {
  return getDb().db.prepare("SELECT * FROM memory_vectors_info ORDER BY key").all();
}

for (const sourceLegacy of [false, true]) {
  for (const targetLegacy of [false, true]) {
    test(`backup/restore between source legacy=${sourceLegacy} and target legacy=${targetLegacy}`, () => {
      const source = getDb().db;
      source.exec("INSERT INTO memories(legacy_id,title,fragment,type) VALUES ('m-portable','Türkçe 第二','retained knowledge','fact')");
      if (sourceLegacy) addLegacy();
      const before = source.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
      const backup = createBackup();
      assert.deepEqual(source.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), before, "backup does not edit source schema");
      const sourceInfo = sourceLegacy ? info() : undefined;
      const envelope = JSON.parse(fs.readFileSync(backup.path, "utf8"));
      const snapshot = new Database(Buffer.from(envelope.database, "base64"));
      try {
        if (sourceLegacy) assert.deepEqual(snapshot.prepare("SELECT * FROM memory_vectors_info ORDER BY key").all(), sourceInfo, "snapshot retains legacy metadata");
      } finally { snapshot.close(); }
      setDataDir(path.join(root, "target"));
      if (targetLegacy) {
        addLegacy();
        getDb().db.exec("UPDATE memory_vectors_info SET value='v0.1.10' WHERE key='CREATE_VERSION'; UPDATE memory_vectors_info SET value=10 WHERE key='CREATE_VERSION_PATCH'");
      }
      const targetInfo = targetLegacy ? info() : undefined;
      getDb().db.exec("INSERT INTO memories(legacy_id,title,fragment,type) VALUES ('m-current','current','safety backup record','fact')");
      const preview = previewRestore(backup.path);
      assert.equal(preview.readiness.status, "ready");
      assert.match(preview.compatibility_note, /does not recreate/);
      const restored = restoreBackup(preview.confirmation_token, true);
      assert.equal(restored.restored, true);
      assert.deepEqual(getDb().db.prepare("SELECT title FROM memories").all(), [{ title: "Türkçe 第二" }]);
      assert.equal(getDb().db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'retained'").all().length, 1);
      if (targetLegacy) assert.deepEqual(info(), targetInfo, "existing empty legacy metadata stays untouched");
      else assert.equal(getDb().db.prepare("SELECT name FROM sqlite_master WHERE name='memory_vectors'").get(), undefined);
      const undo = previewRestore(restored.safety_backup_path);
      assert.equal(restoreBackup(undo.confirmation_token, true).restored, true);
      assert.deepEqual(getDb().db.prepare("SELECT title FROM memories").all(), [{ title: "current" }]);
    });
  }
}

for (const [label, sql, error] of [
  ["nonempty rowids", "INSERT INTO memory_vectors_rowids(id) VALUES (1)", /contain data/],
  ["nonempty vector payload", "INSERT INTO memory_vectors_vector_chunks00 VALUES (1, x'01')", /contain data/],
  ["nonempty chunks", "INSERT INTO memory_vectors_chunks(size,validity,rowids) VALUES (1,x'01',x'01')", /contain data/],
  ["unknown metadata", "INSERT INTO memory_vectors_info VALUES ('user-data','keep')", /metadata/],
  ["changed schema", "ALTER TABLE memory_vectors_info ADD COLUMN extra TEXT", /legacy vector schema/],
  ["unrelated table", "CREATE TABLE memory_vectors_extra(data TEXT)", /Incompatible database schema/],
  ["same-name trigger", "CREATE TRIGGER memory_vectors_chunks AFTER INSERT ON memories BEGIN SELECT 1; END", /Incompatible database schema/],
  ["prior vector writes", "INSERT INTO memory_vectors_rowids(id) VALUES (1); DELETE FROM memory_vectors_rowids", /prior write history/],
] as const) {
  test("rejects legacy residue with " + label, () => {
    addLegacy();
    const cleanBackup = createBackup();
    getDb().db.exec(sql);
    assert.throws(() => createBackup(), error);
    assert.throws(() => previewRestore(cleanBackup.path), error, "unsupported target must also be rejected");
  });
}

test("rejects vector data inside an otherwise valid backup before preview", () => {
  addLegacy();
  const backup = createBackup();
  const envelope = JSON.parse(fs.readFileSync(backup.path, "utf8"));
  const db = new Database(Buffer.from(envelope.database, "base64"));
  db.exec("INSERT INTO memory_vectors_rowids(id) VALUES (1)");
  const bytes = db.serialize();
  db.close();
  envelope.database = bytes.toString("base64");
  envelope.database_sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(backup.path, JSON.stringify(envelope));
  assert.throws(() => previewRestore(backup.path), /contain data/);
});
