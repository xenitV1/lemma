import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../../src/db/schema.js";
import { closeDb, getDb, setDataDir } from "../../src/db/database.js";
import { createBackup, previewRestore, restoreBackup } from "../../src/db/backup.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-upgrade-")); setDataDir(dir); });
afterEach(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(version: number, legacy = false, change?: (db: Database.Database) => void): string {
  const db = new Database(":memory:");
  try {
    for (const [step, ddl] of MIGRATIONS) {
      if (step > version) continue;
      db.exec(ddl);
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(step);
    }
    db.exec("INSERT INTO schema_version(version, applied_at) VALUES (-1, '2026-01-01 12:00:00')");
    db.prepare("INSERT INTO memories(id, legacy_id, title, fragment, type, project, access_count) VALUES (?, 'm-old', 'Türkçe çığ 第二', 'portable knowledge', 'fact', ?, ?)")
      .run(9007199254740993n, version < 3 ? '/home/user/Project' : 'project', 9007199254740995n);
    db.exec("INSERT INTO guides(id, guide, category, description) VALUES (17, 'old-guide', 'testing', 'preserved'); INSERT INTO guide_contexts(guide_id, context) VALUES (17, 'testing'); INSERT INTO sessions(id, status, project) VALUES ('old-session', 'completed', 'global')");
    if (legacy) {
      db.unsafeMode(true);
      try { db.exec(fs.readFileSync(new URL('./fixtures/unused-vec0.sql', import.meta.url), 'utf8')); }
      finally { db.unsafeMode(false); }
    }
    change?.(db);
    const bytes = db.serialize();
    const file = path.join(dir, `v${version}-${legacy}.lemma-backup`);
    fs.writeFileSync(file, JSON.stringify({ format: 'lemma-backup', format_version: 1, lemma_version: 'historical-schema-fixture', schema_version: version,
      created_at: '2026-01-01T00:00:00Z', database: bytes.toString('base64'), database_sha256: createHash('sha256').update(bytes).digest('hex') }));
    return file;
  } finally { db.close(); }
}

for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
  for (const legacy of [false, true]) {
    test(`schema ${version}, legacy=${legacy}: preview is read-only, restore preserves values and undo works`, () => {
      const file = fixture(version, legacy);
      const original = fs.readFileSync(file);
      const live = getDb().db;
      live.exec("INSERT INTO memories(legacy_id, title, fragment, type) VALUES ('receiver', 'Keep me', 'undo content', 'fact')");
      const preview = previewRestore(file);
      assert.equal(preview.schema_upgrade.required, version < 8);
      assert.equal(preview.schema_upgrade.from, version);
      assert.equal(preview.schema_upgrade.to, 8);
      assert.equal(preview.schema_upgrade.applied_versions.length, 8 - version);
      if (version < 3) assert.match(preview.schema_upgrade.notes.join(' '), /Project keys are normalized/);
      assert.deepEqual(live.prepare("SELECT legacy_id FROM memories").get(), { legacy_id: 'receiver' });
      assert.deepEqual(fs.readFileSync(file), original);
      const result = restoreBackup(preview.confirmation_token, true);
      const memory = live.prepare("SELECT id, title, project, access_count, access_window FROM memories").safeIntegers().get();
      assert.deepEqual(memory, { id: 9007199254740993n, title: 'Türkçe çığ 第二', project: 'project', access_count: 9007199254740995n,
        access_window: version < 4 ? 9007199254740995n : 0n });
      assert.deepEqual(live.prepare("SELECT project FROM sessions WHERE id='old-session'").get(), { project: version < 3 ? null : 'global' });
      assert.deepEqual(live.prepare("SELECT context FROM guide_contexts WHERE guide_id=17").get(), { context: 'testing' });
      assert.deepEqual(live.prepare("SELECT count(*) AS n FROM schema_version WHERE version > 0").get(), { n: 8 });
      assert.deepEqual(live.prepare("SELECT applied_at FROM schema_version WHERE version=-1").get(), { applied_at: '2026-01-01 12:00:00' });
      assert.deepEqual(live.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'portable'").get(), { n: 1 });
      assert.deepEqual(fs.readFileSync(file), original);
      const upgraded = createBackup();
      assert.equal(JSON.parse(fs.readFileSync(upgraded.path, 'utf8')).schema_version, 8);
      assert.equal(previewRestore(upgraded.path).schema_upgrade.required, false);
      restoreBackup(previewRestore(result.safety_backup_path).confirmation_token, true);
      assert.deepEqual(live.prepare("SELECT legacy_id FROM memories").get(), { legacy_id: 'receiver' });
    });
  }
}

test('rejects unknown, mismatched and incomplete historical schemas before changing the target', () => {
  const live = getDb().db;
  live.exec("INSERT INTO memories(title, fragment, type) VALUES ('receiver', 'retained', 'fact')");
  for (const change of [
    (db: Database.Database) => db.exec('CREATE TABLE extra_data(id INTEGER)'),
    (db: Database.Database) => db.exec('DELETE FROM schema_version WHERE version=1'),
    (db: Database.Database) => db.exec('INSERT INTO schema_version(version) VALUES (-2)'),
    (db: Database.Database) => db.exec('DROP INDEX idx_memories_project'),
  ]) {
    const file = fixture(2, false, change);
    assert.throws(() => previewRestore(file), /schema|version/i);
    assert.deepEqual(live.prepare('SELECT title FROM memories').get(), { title: 'receiver' });
  }
  for (const version of [0, 9, 2.5, '2']) {
    const file = fixture(2);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.schema_version = version;
    fs.writeFileSync(file, JSON.stringify(envelope));
    assert.throws(() => previewRestore(file), /Unsupported Lemma database schema/);
  }
  const file = fixture(2);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.schema_version = 1;
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => previewRestore(file), /schema|version/i);
});

test('historical upgrade still requires explicit approval and rejects a changed source', () => {
  const file = fixture(1);
  const preview = previewRestore(file);
  assert.throws(() => restoreBackup(preview.confirmation_token, false), /Explicit user confirmation/);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.created_at = '2026-01-02T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => restoreBackup(preview.confirmation_token, true), /backup changed/i);
});
