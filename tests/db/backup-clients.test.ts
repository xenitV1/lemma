import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { getDb, closeDb, setDataDir, LemmaDB } from "../../src/db/database.js";
import { createBackup, previewRestore, restoreBackup } from "../../src/db/backup.js";

const worker = new URL('./backup-worker.ts', import.meta.url);
const cwd = new URL('../../', import.meta.url);
const options = { cwd, execArgv: ['--import', 'tsx', '--import', './tests/_setup.ts'], silent: true };

test('reports every peer and unverifiable lease without confusing same-process connections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-client-identities-'));
  setDataDir(dir);
  const db = getDb();
  const peers = [new LemmaDB(path.join(dir, 'lemma.db')), new LemmaDB(path.join(dir, 'lemma.db'))];
  try {
    fs.writeFileSync(path.join(dir, 'lemma.db.client-invalid'), '');
    const readiness = db.getRestoreReadiness();
    assert.equal(readiness.status, 'blocked');
    assert.equal(readiness.current_connection.pid, process.pid);
    assert.equal(readiness.blocking_connections.length, 2);
    assert.equal(new Set(readiness.blocking_connections.map(peer => peer.connection_id)).size, 2);
    for (const peer of readiness.blocking_connections) {
      assert.equal(peer.pid, process.pid);
      assert.equal(peer.same_process, true);
      assert.notEqual(peer.connection_id, readiness.current_connection.connection_id);
    }
    assert.equal(readiness.unverifiable_leases, 1);
    assert.equal(readiness.inspection_error, null);
    assert.match(readiness.message, /do not terminate the current process/);
    assert.equal(readiness.conversation_mapping, 'unavailable');
    assert.throws(() => db.withRestoreLock(() => assert.fail('must stay blocked')), /Cannot verify/);
  } finally {
    peers.forEach(peer => peer.close());
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connection inspection errors remain blocked and preserve current identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-client-inspection-'));
  setDataDir(dir);
  const db = getDb();
  try {
    mock.method(fs, 'readdirSync', () => { throw new Error('directory unavailable'); });
    const readiness = db.getRestoreReadiness();
    assert.equal(readiness.status, 'blocked');
    assert.equal(readiness.current_connection.pid, process.pid);
    assert.equal(readiness.inspection_error, 'directory unavailable');
    assert.throws(() => db.withRestoreLock(() => assert.fail('must stay blocked')), /Cannot inspect/);
  } finally {
    mock.restoreAll();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("another MCP process blocks restore; a terminated process does not strand a lock", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-backup-peer-'));
  setDataDir(dir);
  const backup = createBackup();
  const earlierPreview = previewRestore(backup.path);
  assert.equal(earlierPreview.readiness.status, 'ready');
  assert.equal(earlierPreview.readiness.current_connection.pid, process.pid);
  assert.deepEqual(earlierPreview.readiness.blocking_connections, []);
  const child = fork(worker, ['hold', path.join(dir, 'lemma.db')], options);
  const exited = once(child, 'exit');
  try {
    const ready = once(child, 'message');
    const [signal] = await Promise.race([ready, exited.then(() => { throw new Error('Peer failed before registration'); })]);
    assert.equal(signal, 'ready');
    assert.throws(() => restoreBackup(earlierPreview.confirmation_token, true), /Another Lemma client/, 'a connection opened after preview must still block restore');
    const blocked = previewRestore(backup.path);
    assert.equal(blocked.valid, true);
    assert.equal(blocked.readiness.status, 'blocked');
    assert.equal(blocked.readiness.current_connection.pid, process.pid);
    assert.equal(blocked.readiness.blocking_connections.length, 1);
    assert.equal(blocked.readiness.blocking_connections[0].pid, child.pid);
    assert.equal(blocked.readiness.blocking_connections[0].same_process, false);
    assert.equal(blocked.readiness.conversation_mapping, 'unavailable');
    assert.match(blocked.readiness.message, /Another Lemma client/);
    assert.equal(blocked.confirmation_token, null);
    assert.equal(blocked.expires_at, null);
    assert.throws(() => restoreBackup(blocked.confirmation_token, true), /not ready/);
    child.kill();
    await exited;
    const afterExit = previewRestore(backup.path).readiness;
    assert.equal(afterExit.status, 'ready');
    assert.deepEqual(afterExit.blocking_connections, [], 'terminated peers are excluded');
    assert.equal(restoreBackup(previewRestore(backup.path).confirmation_token, true).restored, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("process termination during replacement preserves current memory and a verified safety backup", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-backup-crash-'));
  setDataDir(dir);
  try {
    const db = getDb().db;
    db.exec("INSERT INTO memories(legacy_id,title,fragment,type) VALUES ('m','old','backup state','fact')");
    const backup = createBackup();
    db.exec("UPDATE memories SET fragment='current state' WHERE legacy_id='m'");
    closeDb();
    const child = fork(worker, ['crash', path.join(dir, 'lemma.db'), backup.path], options);
    const [code] = await once(child, 'exit');
    assert.equal(code, 73, 'fixture must reach the crash during replacement');
    const reopened = getDb().db;
    assert.equal((reopened.prepare("SELECT fragment FROM memories WHERE legacy_id='m'").get() as { fragment: string }).fragment, 'current state');
    assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(reopened.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'current'").all().length, 1);
    const safety = fs.readdirSync(path.join(dir, 'backups')).find(name => name.startsWith('before-restore-'));
    assert.ok(safety);
    assert.equal(previewRestore(path.join(dir, 'backups', safety)).valid, true);
    assert.equal(restoreBackup(previewRestore(backup.path).confirmation_token, true).restored, true);
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
