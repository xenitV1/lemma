import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getServer } from "../../src/server/index.js";
import { handleCallTool } from "../../src/server/handlers.js";
import { setTrafficEnabled } from "../../src/server/traffic-log.js";
import { serializeToolCall } from "../../src/server/tool-queue.js";
import { getDb, closeDb, setDataDir, LemmaDB } from "../../src/db/database.js";
import { setConfigDir, resetConfig } from "../../src/memory/config.js";
import * as virtual from "../../src/sessions/virtual.js";
import type { ConnectionInspection } from "../../src/db/clients.js";

test("MCP backup/preview/confirmation/restore works on the same live connection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-backup-mcp-'));
  setDataDir(dir);
  setConfigDir(dir);
  resetConfig();
  setTrafficEnabled(false);
  virtual.setSessionLogDir(path.join(dir, 'sessions'));
  virtual.discardVirtualSession();
  const client = new Client({ name: 'backup-test', version: '1.0.0' });
  const server = getServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'backup_create'));
    assert.ok(tools.tools.find(t => t.name === 'backup_restore')?.annotations?.destructiveHint);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result;
    };
    getDb().db.exec("INSERT INTO memories(legacy_id,title,fragment,type) VALUES ('m-old','Original','portable memory','fact')");
    const created = await call('backup_create');
    const backupPath = (created.structuredContent as { path: string }).path;
    assert.equal(virtual.getCurrentVirtualSession(), null, 'backup must not auto-start a session');
    await call('session_start', { task_type: 'testing' });
    await call('memory_add', { title: 'New knowledge', fragment: 'unrelated new information collected after the backup', project: 'test' });
    assert.ok(virtual.getCurrentVirtualSession());
    const older = await call('backup_preview', { path: backupPath });
    const olderToken = (older.structuredContent as { confirmation_token: string }).confirmation_token;
    const peer = new LemmaDB(path.join(dir, 'lemma.db'));
    try {
      const blockedResult = await call('backup_preview', { path: backupPath });
      const blocked = blockedResult.structuredContent as { valid: boolean; readiness: { status: string; message: string }; confirmation_token: null; expires_at: null; current: { memories: number }; message: string };
      assert.equal(blocked.valid, true);
      assert.equal(blocked.readiness.status, 'blocked');
      const connections = blocked.readiness as typeof blocked.readiness & ConnectionInspection;
      assert.equal(connections.current_connection.pid, process.pid);
      assert.equal(connections.blocking_connections.length, 1);
      assert.equal(connections.blocking_connections[0].same_process, true);
      assert.notEqual(connections.current_connection.connection_id, connections.blocking_connections[0].connection_id);
      assert.match(blocked.readiness.message, /Keep this MCP connection open/);
      assert.equal(blocked.confirmation_token, null);
      assert.equal(blocked.expires_at, null);
      assert.equal(blocked.current.memories, 2);
      assert.match(blocked.message, /Do not ask for restore confirmation yet/);
      assert.deepEqual(JSON.parse((blockedResult.content as { text: string }[])[0].text), blocked);
    } finally {
      peer.close();
    }
    const staleApproval = await client.callTool({ name: 'backup_restore', arguments: { confirmation_token: olderToken, confirm: true } });
    assert.equal(staleApproval.isError, true, 'a blocked preview invalidates older approvals even after the peer closes');
    const previewResult = await call('backup_preview', { path: backupPath });
    assert.equal((previewResult.structuredContent as { readiness: { status: string } }).readiness.status, 'ready');
    const preview = previewResult.structuredContent as { confirmation_token: string; current: { memories: number } };
    assert.equal(preview.current.memories, 2);
    const text = (previewResult.content as { type: string; text: string }[])[0].text;
    assert.deepEqual(JSON.parse(text), previewResult.structuredContent, 'no unrelated lifecycle reminders');
    const denied = await client.callTool({ name: 'backup_restore', arguments: { confirmation_token: preview.confirmation_token, confirm: false } });
    assert.equal(denied.isError, true);
    const restored = await call('backup_restore', { confirmation_token: preview.confirmation_token, confirm: true });
    assert.equal((restored.structuredContent as { restored: boolean }).restored, true);
    assert.equal(virtual.getCurrentVirtualSession(), null);
    assert.equal(virtual.finalizeVirtualSession(), null, 'old lifecycle must not write into restored data');
    assert.equal((getDb().db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
    const read = await call('memory_read', { all: true });
    assert.match(JSON.stringify(read), /Original/);
    assert.doesNotMatch(JSON.stringify(read), /New knowledge/);
    await call('memory_add', { title: 'After restore', fragment: 'normal writes continue after restoring', project: 'test' });
    assert.equal((getDb().db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n, 2);
  } finally {
    virtual.discardVirtualSession();
    await client.close();
    await server.close();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP backup handlers reject invalid arguments before using the database", async () => {
  for (const [name, args] of [
    ['backup_create', { directory: 123 }],
    ['backup_create', { overwrite: true }],
    ['backup_preview', {}],
    ['backup_preview', { path: '' }],
    ['backup_restore', { confirmation_token: 'anything', confirm: 'true' }],
  ] as const) {
    const result = await handleCallTool({ params: { name, arguments: args } });
    assert.equal(result.isError, true);
  }
});

test("queued requests wait for earlier lifecycle work and recover after a rejected call", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = serializeToolCall(async () => { order.push('handler'); await gate; order.push('lifecycle'); });
  const second = serializeToolCall(async () => { order.push('restore'); });
  await Promise.resolve();
  assert.deepEqual(order, ['handler']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['handler', 'lifecycle', 'restore']);
  await assert.rejects(serializeToolCall(async () => { throw new Error('failed request'); }));
  assert.equal(await serializeToolCall(async () => 'still usable'), 'still usable');
});
