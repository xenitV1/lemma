#!/usr/bin/env node
// Export/import synthetic MCP backups between operating systems.
// node tests/manual/backup-portability.mjs export|import <bundle-dir> [--legacy-vectors]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LemmaDB } from "../../dist/db/database.js";
import { runMigrations } from "../../dist/db/migration.js";
import { disableLogger } from "../../dist/logger.js";
disableLogger();

const [mode, bundleArg] = process.argv.slice(2);
assert.ok(mode === "export" || mode === "import", "export or import mode required");
assert.ok(bundleArg && path.isAbsolute(bundleArg), "absolute synthetic bundle directory required");
const bundle = path.resolve(bundleArg);
const legacy = process.argv.includes("--legacy-vectors");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-portability-"));
const project = path.join(home, "project");
fs.mkdirSync(project);
const dbPath = path.join(home, ".lemma", "lemma.db");
const fixtureDb = new LemmaDB(dbPath);
runMigrations(fixtureDb);
if (legacy) {
  fixtureDb.db.unsafeMode(true);
  try { fixtureDb.db.exec(fs.readFileSync(new URL("../db/fixtures/unused-vec0.sql", import.meta.url), "utf8")); }
  finally { fixtureDb.db.unsafeMode(false); }
}
if (mode === "export") {
  fixtureDb.db.exec(`
    INSERT INTO memories(id,legacy_id,title,fragment,type,project) VALUES
      (101,'m-first','Türkçe çığ 第二','portable Unicode knowledge','fact',NULL),
      (102,'m-second','Invalidated record','project knowledge','pattern','project-a');
    UPDATE memories SET parent_id=101,invalidated_at='2026-01-01' WHERE id=102;
    UPDATE memories SET title='Updated Türkçe çığ 第二' WHERE id=101;
    INSERT INTO relations(source_id,target_id,type,note) VALUES (101,102,'related_to','retained');
    INSERT INTO guides(id,guide,category,description,protocol) VALUES (201,'portable-guide','testing','guide body','["step"]');
    INSERT INTO guide_contexts(guide_id,context) VALUES (201,'backup');
    INSERT INTO guide_learnings(guide_id,learning) VALUES (201,'learned');
    INSERT INTO guide_memory_links(guide_id,memory_id,link_type) VALUES (201,101,'source');
    INSERT INTO sessions(id,task_type,status,outcome) VALUES ('s-complete','testing','completed','success');
    INSERT INTO session_guide_usage(session_id,guide_id) VALUES ('s-complete',201);
    INSERT INTO session_memory_links(session_id,memory_id,interaction_type) VALUES ('s-complete',101,'created');
    INSERT INTO feedback_log(memory_id,useful,context) VALUES (101,1,'restorable');
    INSERT INTO session_attempts(session_id,seq,approach,outcome,related_memory_id) VALUES ('s-complete',1,'safe copy','promising',101);
    INSERT INTO improvement_suggestions(session_id,suggestion) VALUES ('s-complete','a suggestion');
    INSERT INTO fragments_archive(legacy_id,title,fragment,type,confidence,source) VALUES ('m-archive','old','archive body','fact',0.5,'ai');
    INSERT INTO memory_evidence(memory_id,file_path,snippet,snippet_hash) VALUES (101,'C:/synthetic-old-project/app.ts','evidence','hash');
    INSERT INTO tfidf_cache(legacy_id,content_hash,terms) VALUES ('m-first','cachehash','{"portable":1}');
  `);
  fixtureDb.db.prepare("INSERT INTO memories(id,legacy_id,title,fragment,type) VALUES (?,'m-large','Large ID','64-bit identifier','fact')").run(9007199254740993n);
  fixtureDb.db.prepare("UPDATE memories SET access_count=? WHERE id=101").run(9007199254740995n);
} else {
  fixtureDb.db.exec("INSERT INTO memories(legacy_id,title,fragment,type) VALUES ('receiver','Receiver current state','synthetic safety backup content','fact')");
}
fixtureDb.close();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  cwd: project,
  env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
const client = new Client({ name: "cross-platform-backup", version: "1.0.0" });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, name + ": " + JSON.stringify(result));
  return result.structuredContent;
}
function dump() {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = {};
    const tables = db.pragma("table_list")
      .filter(t => t.schema === "main" && t.type === "table" && t.name !== "sqlite_schema" && !t.name.startsWith("memory_vectors"))
      .map(t => t.name).sort();
    for (const name of tables) rows[name] = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').raw().safeIntegers().all();
    return JSON.parse(JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? { bigint: value.toString() } : value));
  } finally { db.close(); }
}
try {
  await client.connect(transport);
  await client.listTools();
  if (mode === "export") {
    fs.mkdirSync(bundle, { recursive: true });
    assert.ok(!fs.existsSync(path.join(bundle, "manifest.json")), "use a new bundle directory");
    const backup = await call("backup_create", { directory: bundle });
    assert.equal(backup.verified, true);
    const rows = dump();
    fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({
      synthetic_fixture: true, producer: process.platform, node: process.version,
      legacy_source: legacy, backup_filename: path.basename(backup.path), rows,
    }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ mode, producer: process.platform, legacy, tables: Object.keys(rows).length, verified: true, bundle }));
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
    assert.equal(manifest.synthetic_fixture, true);
    assert.notEqual(manifest.producer, process.platform, "this test must cross operating systems");
    assert.equal(path.basename(manifest.backup_filename), manifest.backup_filename);
    const before = dump();
    const preview = await call("backup_preview", { path: path.join(bundle, manifest.backup_filename) });
    assert.equal(preview.valid, true);
    assert.equal(preview.readiness.status, "ready");
    const result = await call("backup_restore", { confirmation_token: preview.confirmation_token, confirm: true });
    assert.equal(result.restored, true);
    assert.equal(result.verified, true);
    assert.deepEqual(dump(), manifest.rows, "every ordinary application table and sqlite_sequence must match across OSes, including 64-bit values");
    const safety = await call("backup_preview", { path: result.safety_backup_path });
    const undone = await call("backup_restore", { confirmation_token: safety.confirmation_token, confirm: true });
    assert.equal(undone.restored, true);
    assert.deepEqual(dump(), before, "safety backup must restore the receiver's original records");
    console.log(JSON.stringify({ mode, from: manifest.producer, to: process.platform,
      source_legacy: manifest.legacy_source, target_legacy: legacy,
      compared_tables: Object.keys(manifest.rows).length, all_rows_equal: true, safety_undo: true }));
  }
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  const resolved = fs.realpathSync(home);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("lemma-portability-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
