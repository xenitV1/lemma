import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { LemmaDB } from "../../src/db/database.js";

const worker = new URL('./backup-worker.ts', import.meta.url);
const cwd = new URL('../../', import.meta.url);
const options = { cwd, execArgv: ['--import', 'tsx', '--import', './tests/_setup.ts'], silent: true };

const leases = (dir: string) => fs.readdirSync(dir).filter(name => name.startsWith('lemma.db.client-')).sort();

/** Cleanup for failure paths: end a child that is still running and wait for it, so a failed test does not leave the run hanging. */
async function stopChild(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

/** PID of a process that has already exited, so the OS reports it as gone. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(child.pid, 'expected a pid from the short-lived child');
  return child.pid;
}

test('a process that exits with its connection still open removes its lease', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-lease-exit-'));
  const child = fork(worker, ['exit-open', path.join(dir, 'lemma.db')], options);
  const exited = once(child, 'exit');
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('worker exited before registering'); })]);
    assert.equal(signal, 'ready');
    assert.equal(leases(dir).length, 1, 'the worker registers one lease');
    child.send('exit');
    const [code] = await exited;
    assert.equal(code, 0);
    assert.deepEqual(leases(dir), [], 'process.exit() must not leave the lease behind');
  } finally {
    await stopChild(child, exited);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the exit hook never leaves a lease missing while its connection is still open', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-lease-emit-exit-'));
  const child = fork(worker, ['emit-exit', path.join(dir, 'lemma.db')], options);
  const exited = once(child, 'exit');
  try {
    const [report] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('worker exited without reporting'); })]);
    await exited;
    const { open, leases: remaining } = report as { open: boolean; leases: number };
    // The hook must close the connection before the lease disappears; here both happen.
    assert.equal(open, false, 'the hook closes the SQLite connection');
    assert.equal(remaining, 0, 'and only then removes the lease');
  } finally {
    await stopChild(child, exited);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a connection removes leases of processes that no longer exist, and keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-lease-sweep-'));
  const dbPath = path.join(dir, 'lemma.db');
  const stale = `lemma.db.client-${deadPid()}-${randomUUID()}`;
  const live = `lemma.db.client-${process.pid}-${randomUUID()}`;
  const unverifiable = 'lemma.db.client-invalid';
  // Seed the database once so the directory has a real lemma.db.
  new LemmaDB(dbPath).close();
  for (const name of [stale, live, unverifiable]) fs.writeFileSync(path.join(dir, name), '');
  const db = new LemmaDB(dbPath);
  try {
    const remaining = leases(dir);
    assert.ok(!remaining.includes(stale), 'a lease whose process is gone is removed');
    assert.ok(remaining.includes(live), 'a lease whose process is alive is kept (it may still be using the memory)');
    assert.ok(remaining.includes(unverifiable), 'a lease that cannot be verified is kept');
    assert.equal(db.getRestoreReadiness().status, 'blocked', 'kept leases still block restore');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP server removes its lease when the client closes stdin', { timeout: 60000 }, async () => {
  // Isolated home: the server always uses ~/.lemma, so point the home directory at a temp dir.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-lease-server-'));
  const lemmaDir = path.join(home, '.lemma');
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(server, 'exit');
  try {
    server.stdout.resume();
    server.stderr.resume();
    const deadline = Date.now() + 45000;
    while (!(fs.existsSync(lemmaDir) && leases(lemmaDir).length > 0)) {
      if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}`);
      if (Date.now() > deadline) throw new Error('server never registered a lease');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
    assert.deepEqual(leases(lemmaDir), [], 'a clean shutdown must not leave the lease behind');
  } finally {
    await stopChild(server, exited);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
