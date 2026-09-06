import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getDb, closeDb, setDataDir, LemmaDB } from "../../src/db/database.js";
import { createBackup, previewRestore, restoreBackup, RESTORE_PREVIEW_TTL_MS } from "../../src/db/backup.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-backup-test-"));
  setDataDir(dir);
});

afterEach(() => {
  mock.restoreAll();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unverifiable client registration blocks preview without changing memory', () => {
  const backup = createBackup();
  const before = dump();
  const lease = path.join(dir, 'lemma.db.client-invalid');
  fs.writeFileSync(lease, '');
  try {
    const preview = previewRestore(backup.path);
    assert.equal(preview.valid, true);
    assert.equal(preview.readiness.status, 'blocked');
    assert.match(preview.readiness.message, /Cannot verify/);
    assert.equal(preview.confirmation_token, null);
    assert.deepEqual(dump(), before);
  } finally {
    fs.unlinkSync(lease);
  }
  assert.equal(previewRestore(backup.path).readiness.status, 'ready');
});

function seed(): void {
  const db = getDb().db;
  db.exec(`
    INSERT INTO memories(id, legacy_id, title, fragment, type, project) VALUES
      (101, 'm-first', 'Türkçe hafıza', 'portable knowledge', 'fact', NULL),
      (102, 'm-second', '第二', 'project knowledge', 'pattern', 'project-a');
    UPDATE memories SET parent_id = 101, invalidated_at = '2026-01-01' WHERE id = 102;
    UPDATE memories SET title = 'Updated Türkçe' WHERE id = 101;
    INSERT INTO relations(source_id, target_id, type, note) VALUES (101, 102, 'related_to', 'retained');
    INSERT INTO guides(id, guide, category, description, protocol) VALUES (201, 'portable-guide', 'testing', 'guide body', '["step"]');
    INSERT INTO guide_contexts(guide_id, context) VALUES (201, 'backup');
    INSERT INTO guide_learnings(guide_id, learning) VALUES (201, 'learned');
    INSERT INTO guide_memory_links(guide_id, memory_id, link_type) VALUES (201, 101, 'source');
    INSERT INTO sessions(id, task_type, status, outcome) VALUES ('s-complete', 'testing', 'completed', 'success'), ('s-active', 'testing', 'active', NULL);
    INSERT INTO session_guide_usage(session_id, guide_id) VALUES ('s-complete', 201);
    INSERT INTO session_memory_links(session_id, memory_id, interaction_type) VALUES ('s-complete', 101, 'created');
    INSERT INTO feedback_log(memory_id, useful, context) VALUES (101, 1, 'restorable');
    INSERT INTO session_attempts(session_id, seq, approach, outcome, related_memory_id) VALUES ('s-complete', 1, 'safe copy', 'promising', 101);
    INSERT INTO improvement_suggestions(session_id, suggestion) VALUES ('s-complete', 'a suggestion');
    INSERT INTO fragments_archive(legacy_id, title, fragment, type, confidence, source) VALUES ('m-archive', 'old', 'archive body', 'fact', 0.5, 'ai');
    INSERT INTO memory_evidence(memory_id, file_path, snippet, snippet_hash) VALUES (101, 'C:\\old-computer\\project\\app.ts', 'evidence', 'hash');
    INSERT INTO tfidf_cache(legacy_id, content_hash, terms) VALUES ('m-first', 'cachehash', '{"portable":1}');
  `);
  db.prepare("UPDATE memories SET access_count = ? WHERE id = 101").run(9007199254740993n);
}

function dump(db = getDb().db): Record<string, unknown[]> {
  const tables = (db.pragma("table_list") as { name: string; schema: string; type: string }[])
    .filter(t => t.schema === "main" && t.type === "table" && t.name !== "sqlite_schema");
  return Object.fromEntries(tables.map(t => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).safeIntegers().all()]));
}

function backupDatabase(file: string): Database.Database {
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  return new Database(Buffer.from(envelope.database, "base64"));
}

function changeBackup(file: string, change: (db: Database.Database) => void): void {
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = backupDatabase(file);
  try {
    change(db);
    const image = db.serialize();
    envelope.database = image.toString("base64");
    envelope.database_sha256 = createHash("sha256").update(image).digest("hex");
    fs.writeFileSync(file, JSON.stringify(envelope));
  } finally { db.close(); }
}

describe("portable database backups", () => {
  test("includes uncheckpointed WAL data, every ordinary table, Unicode and 64-bit IDs/counters", () => {
    seed();
    const live = getDb().db;
    live.pragma("wal_autocheckpoint = 0");
    const expected = dump();
    const result = createBackup(path.join(dir, 'Yedekler çığ'));
    assert.equal(result.verified, true);
    assert.equal(result.summary.archived_memories, 1);
    assert.equal(live.pragma("journal_mode", { simple: true }), "wal");
    const copy = backupDatabase(result.path);
    try { assert.deepEqual(dump(copy), expected); } finally { copy.close(); }
    assert.deepEqual(dump(), expected, "backup must not mutate the live database");
    assert.match(result.message, /outside this computer/);
    const next = createBackup();
    assert.notEqual(next.path, result.path);
    assert.ok(fs.existsSync(result.path));
  });

  test("restores into another directory, preserves all history and links, and leaves settings alone", () => {
    seed();
    const backup = createBackup();
    const expected = dump();
    const targetDir = path.join(dir, 'new-computer');
    setDataDir(targetDir);
    const target = getDb();
    fs.writeFileSync(path.join(targetDir, 'config.json'), '{"machine":"new"}');
    target.db.exec("INSERT INTO memories(legacy_id, title, fragment, type) VALUES ('m-new', 'newer', 'safety backup content', 'fact')");
    const before = dump();
    const preview = previewRestore(backup.path);
    assert.equal(preview.backup.memories, 2);
    assert.equal(preview.current.memories, 1);
    assert.deepEqual(dump(), before, "preview is read-only");
    const result = restoreBackup(preview.confirmation_token, true);
    assert.equal(result.restored, true);
    assert.equal(getDb(), target, "the MCP connection keeps the same database handle");
    assert.equal(result.closed_sessions, 1);
    const actual = dump();
    const actualSessions = actual.sessions;
    delete actual.sessions;
    delete expected.sessions;
    assert.deepEqual(actual, expected);
    const active = actualSessions.find((s: any) => s.id === 's-active') as any;
    assert.equal(active.status, 'abandoned');
    assert.equal(active.outcome, 'abandoned');
    assert.ok(active.ended_at);
    assert.equal(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf8'), '{"machine":"new"}');
    const safety = backupDatabase(result.safety_backup_path);
    try { assert.deepEqual(dump(safety), before); } finally { safety.close(); }
    assert.equal(target.db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'portable'").all().length, 1);
    assert.equal(target.db.prepare("SELECT rowid FROM guides_fts WHERE guides_fts MATCH 'body'").all().length, 1);
    target.db.exec("UPDATE memories SET fragment = 'afterrestore' WHERE id = 101");
    assert.equal(target.db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'afterrestore'").all().length, 1);
    assert.throws(() => restoreBackup(preview.confirmation_token, true), /missing or expired/);
  });

  test("requires an explicit confirmation and a server-issued preview", () => {
    seed();
    const preview = previewRestore(createBackup().path);
    const before = dump();
    assert.throws(() => restoreBackup(preview.confirmation_token, false), /Explicit user confirmation/);
    assert.throws(() => restoreBackup('invented-token', true), /missing or expired/);
    assert.deepEqual(dump(), before);
  });

  test("rejects expired previews", () => {
    seed();
    const preview = previewRestore(createBackup().path);
    const time = Date.now();
    mock.method(Date, 'now', () => time + RESTORE_PREVIEW_TTL_MS + 1);
    assert.throws(() => restoreBackup(preview.confirmation_token, true), /missing or expired/);
  });

  test("rejects a changed target, changed backup, and changed connection", () => {
    seed();
    const backup = createBackup();
    const preview = previewRestore(backup.path);
    getDb().db.exec("UPDATE memories SET fragment = 'new knowledge' WHERE id = 101");
    const updated = dump();
    assert.throws(() => restoreBackup(preview.confirmation_token, true), /memory changed after preview/);
    assert.deepEqual(dump(), updated);
    const preview2 = previewRestore(backup.path);
    const envelope = JSON.parse(fs.readFileSync(backup.path, 'utf8'));
    envelope.created_at = '2025-01-01T00:00:00.000Z';
    fs.writeFileSync(backup.path, JSON.stringify(envelope));
    assert.throws(() => restoreBackup(preview2.confirmation_token, true), /backup changed after preview/);
    const preview3 = previewRestore(backup.path);
    closeDb();
    assert.throws(() => restoreBackup(preview3.confirmation_token, true), /connection changed/);
  });

  test("rejects corrupt, incompatible, and relationally invalid backups without writes", () => {
    seed();
    const before = dump();
    const corrupt = createBackup().path;
    const envelope = JSON.parse(fs.readFileSync(corrupt, 'utf8'));
    envelope.database_sha256 = '0'.repeat(64);
    fs.writeFileSync(corrupt, JSON.stringify(envelope));
    assert.throws(() => previewRestore(corrupt), /checksum/);
    const wrongFormat = createBackup().path;
    const changed = JSON.parse(fs.readFileSync(wrongFormat, 'utf8'));
    changed.format_version = 999;
    fs.writeFileSync(wrongFormat, JSON.stringify(changed));
    assert.throws(() => previewRestore(wrongFormat), /format/);
    const wrongSchema = createBackup().path;
    changeBackup(wrongSchema, db => db.exec('DROP INDEX idx_memories_project'));
    assert.throws(() => previewRestore(wrongSchema), /schema/);
    const brokenLinks = createBackup().path;
    changeBackup(brokenLinks, db => {
      db.pragma('foreign_keys=OFF');
      db.exec('UPDATE memory_evidence SET memory_id = 99999');
    });
    assert.throws(() => previewRestore(brokenLinks), /broken database relationships/);
    assert.deepEqual(dump(), before);
  });

  test("does not replace memory when the mandatory safety backup cannot be written", () => {
    seed();
    const backup = createBackup(path.join(dir, 'external'));
    const preview = previewRestore(backup.path);
    const before = dump();
    fs.writeFileSync(path.join(dir, 'backups'), 'blocked directory');
    assert.throws(() => restoreBackup(preview.confirmation_token, true));
    assert.deepEqual(dump(), before);
    assert.equal(getDb().db.inTransaction, false);
    assert.equal(getDb().db.pragma('synchronous', { simple: true }), 1);
  });

  test("rolls back data, triggers and search indexes on an interrupted replacement", () => {
    seed();
    const backup = createBackup();
    const live = getDb().db;
    live.exec("UPDATE memories SET fragment='keepcurrent' WHERE id=101");
    const before = dump();
    const preview = previewRestore(backup.path);
    const original = live.exec.bind(live);
    mock.method(live, 'exec', (sql: string) => {
      if (sql.includes("VALUES ('rebuild')")) throw new Error('simulated restore failure');
      return original(sql);
    });
    assert.throws(() => restoreBackup(preview.confirmation_token, true), /simulated restore failure.*Safety backup/);
    mock.restoreAll();
    assert.deepEqual(dump(), before);
    assert.equal(live.inTransaction, false);
    assert.equal(live.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'keepcurrent'").all().length, 1);
    live.exec("UPDATE memories SET fragment='stillworking' WHERE id=101");
    assert.equal(live.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'stillworking'").all().length, 1);
  });

  test("blocks other registered connections and prevents opens during restore", () => {
    seed();
    const backup = createBackup();
    const preview = previewRestore(backup.path);
    const before = dump();
    const other = new LemmaDB(path.join(dir, 'lemma.db'));
    try {
      assert.throws(() => restoreBackup(preview.confirmation_token, true), /Another Lemma client/);
      assert.deepEqual(dump(), before);
    } finally { other.close(); }
    getDb().withRestoreLock(() => {
      assert.throws(() => new LemmaDB(path.join(dir, 'lemma.db')), /database is locked/);
    });
    assert.equal(restoreBackup(previewRestore(backup.path).confirmation_token, true).restored, true);
  });
});
