#!/usr/bin/env node
// Real stdio MCP acceptance with disposable homes; never opens the user's memory.
// Run after npm run build: node tests/manual/backup-mcp-smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-backup-stdio-"));
const connections = [];
let checks = 0;
function check(label, condition) {
  assert.ok(condition, label);
  checks++;
  console.log("PASS " + label);
}
async function open(homeName) {
  const home = path.join(root, homeName);
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "dist", "index.js")],
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  const client = new Client({ name: "backup-acceptance", version: "1.0.0" });
  const connection = { client, transport, home, stderr: () => stderr };
  connections.push(connection);
  await client.connect(transport);
  return connection;
}
async function call(connection, name, args = {}) {
  const result = await connection.client.callTool({ name, arguments: args });
  assert.ok(!result.isError, name + ": " + JSON.stringify(result));
  return result;
}
function data(result) {
  assert.ok(result.structuredContent, "structured MCP result");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
const original = "Original Türkçe çığ 第二 backup acceptance";
const later = "Only after backup acceptance marker";
try {
  let main = await open("first-home");
  if (process.argv.includes("--legacy-vectors")) {
    await main.client.close();
    const fixtureDb = new Database(path.join(main.home, ".lemma", "lemma.db"));
    try {
      fixtureDb.unsafeMode(true); // Only this disposable legacy fixture uses schema writes.
      fixtureDb.exec(fs.readFileSync(new URL("../db/fixtures/unused-vec0.sql", import.meta.url), "utf8"));
    } finally { fixtureDb.unsafeMode(false); fixtureDb.close(); }
    main = await open("first-home");
    console.log("Testing an upgraded installation with unused legacy vec0 scaffolding");
  }
  const registry = await main.client.listTools();
  check("new backup tools are discoverable over stdio",
    ["backup_create", "backup_preview", "backup_restore"].every(name => registry.tools.some(t => t.name === name)));
  await call(main, "memory_add", { title: original, fragment: "Synthetic portable Unicode knowledge.", project: "acceptance" });
  await call(main, "session_end", { outcome: "success" });
  const backup = data(await call(main, "backup_create"));
  check("verified backup exists inside the disposable home",
    backup.verified && backup.path.startsWith(main.home + path.sep) && fs.existsSync(backup.path));
  await call(main, "memory_add", { title: later, fragment: "Synthetic data to distinguish current memory from the backup.", project: "acceptance" });
  await call(main, "session_end", { outcome: "success" });
  const early = data(await call(main, "backup_preview", { path: backup.path }));
  check("single connection is ready", early.readiness.status === "ready" && typeof early.confirmation_token === "string");
  check("preview identifies the serving process", early.readiness.current_connection.pid === main.transport.pid);
  check("preview shows the current and backup record difference", early.current.memories === early.backup.memories + 1);
  const peer = await open("first-home");
  const race = await main.client.callTool({ name: "backup_restore", arguments: { confirmation_token: early.confirmation_token, confirm: true } });
  check("a second real server opened after preview blocks restore",
    race.isError && JSON.stringify(race).includes("Another Lemma client"));
  const blocked = data(await call(main, "backup_preview", { path: backup.path }));
  check("blocked preview still validates the backup and explains the blocker",
    blocked.valid && blocked.readiness.status === "blocked" && blocked.readiness.message.includes("Keep this MCP connection open"));
  check("blocked preview does not issue approval or expiry", blocked.confirmation_token === null && blocked.expires_at === null);
  check("preview identifies the other real MCP process without guessing its conversation",
    blocked.readiness.current_connection.pid === main.transport.pid &&
    blocked.readiness.blocking_connections.length === 1 &&
    blocked.readiness.blocking_connections[0].pid === peer.transport.pid &&
    blocked.readiness.blocking_connections[0].same_process === false &&
    blocked.readiness.conversation_mapping === "unavailable");
  await peer.client.close();
  const ready = data(await call(main, "backup_preview", { path: backup.path }));
  check("closing only the peer makes the original connection ready", ready.readiness.status === "ready");
  const denied = await main.client.callTool({ name: "backup_restore", arguments: { confirmation_token: ready.confirmation_token, confirm: false } });
  check("missing explicit confirmation is rejected", denied.isError === true);
  const restored = data(await call(main, "backup_restore", { confirmation_token: ready.confirmation_token, confirm: true }));
  check("restore succeeds on the same live connection", restored.restored && restored.verified);
  check("verified safety backup is present in the disposable home",
    restored.safety_backup_path.startsWith(main.home + path.sep) && fs.existsSync(restored.safety_backup_path));
  const restoredText = JSON.stringify(await call(main, "memory_read", { all: true }));
  check("restored memory contains the original Unicode record", restoredText.includes(original));
  check("the post-backup record was removed", !restoredText.includes(later));
  await call(main, "memory_add", { title: "Writes work after restore", fragment: "A synthetic post-restore write succeeds.", project: "acceptance" });
  check("the same connection can write after restore",
    JSON.stringify(await call(main, "memory_read", { all: true })).includes("Writes work after restore"));
  await call(main, "session_end", { outcome: "success" });
  const undoPreview = data(await call(main, "backup_preview", { path: restored.safety_backup_path }));
  const undone = data(await call(main, "backup_restore", { confirmation_token: undoPreview.confirmation_token, confirm: true }));
  check("safety backup can restore the previous state", undone.restored &&
    JSON.stringify(await call(main, "memory_read", { all: true })).includes(later));
  const fresh = await open("second-home");
  await fresh.client.listTools();
  const importPreview = data(await call(fresh, "backup_preview", { path: backup.path }));
  check("a separate installation directory accepts the portable backup", importPreview.valid && importPreview.readiness.status === "ready");
  const imported = data(await call(fresh, "backup_restore", { confirmation_token: importPreview.confirmation_token, confirm: true }));
  check("restore into the second installation succeeds", imported.restored &&
    JSON.stringify(await call(fresh, "memory_read", { all: true })).includes(original));
  console.log("ALL " + checks + " REAL STDIO CHECKS PASSED");
} catch (error) {
  console.error(error);
  for (const connection of connections) console.error(connection.stderr());
  process.exitCode = 1;
} finally {
  for (const connection of connections.reverse()) {
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }
  // Verify the final absolute target is the disposable root before recursive removal.
  const resolved = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith("lemma-backup-stdio-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
