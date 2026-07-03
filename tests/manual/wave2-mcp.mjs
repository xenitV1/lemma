#!/usr/bin/env node
/**
 * Wave 2 real-server test — exercises B3 (non-destructive consolidation) and
 * B4 (conflict resolution + spot-decay) over the REAL Lemma MCP server (stdio),
 * inspecting the SQLite DB where needed. No LLM required.
 *
 * Run:  node tests/manual/wave2-mcp.mjs   (after npm run build)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const SERVER_SCRIPT = path.join(REPO, "dist", "index.js");
if (!fs.existsSync(SERVER_SCRIPT)) { console.error("Run `npm run build` first."); process.exit(2); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-w2-"));
const projectDir = path.join(tmpRoot, "proj");
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_SCRIPT],
  cwd: projectDir,
  env: { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config") },
});
const client = new Client({ name: "w2-test", version: "1.0.0" }, { capabilities: {} });

let failures = 0;
const check = (n, c, e) => { if (c) console.log(`  ✔ ${n}`); else { failures++; console.error(`  ✖ ${n}${e ? " — " + e : ""}`); } };
const textOf = (r) => (r?.content?.[0]?.text) || "";
const call = (name, args) => client.callTool({ name, arguments: args });
const dbPath = path.join(fakeHome, ".lemma", "lemma.db");
const openDb = () => new Database(dbPath, { readonly: true });
const idFromAdd = (t) => (t.match(/\[(m[0-9a-f]{12})\]/) || [])[1];

try {
  await client.connect(transport);

  // --- B4: conflicting high-overlap add surfaces CONFLICT + RESOLVE + spot-decay ---
  const first = await call("memory_add", { fragment: "Tabs are recommended for indentation in the codebase.", type: "warning", title: "Indentation A" });
  const firstId = idFromAdd(textOf(first));
  check("first fragment added", !!firstId, textOf(first).slice(0, 120));
  let confBefore = null;
  { const db = openDb(); confBefore = (db.prepare("SELECT confidence FROM memories WHERE legacy_id=?").get(firstId) || {}).confidence; db.close(); }

  // High topic overlap + opposing sentiment, but low word overlap so dedup (0.80) doesn't block it.
  const second = await call("memory_add", { fragment: "However, avoid tabs for indentation; the codebase prefers spaces.", type: "warning", title: "Indentation B" });
  const secondText = textOf(second);
  check("conflict surfaced on contradictory add", /CONFLICT/i.test(secondText), secondText.slice(-300));
  check("resolution suggestion surfaced (win-heuristic)", /RESOLVE/i.test(secondText), secondText.slice(-300));
  check("resolution suggests memory_relate supersedes", /supersedes/i.test(secondText));

  { const db = openDb(); const after = (db.prepare("SELECT confidence FROM memories WHERE legacy_id=?").get(firstId) || {}).confidence; db.close();
    check("loser fragment was spot-decayed (~-0.1)", after < confBefore, `before=${confBefore} after=${after}`); }

  // --- B3: consolidate merge keeps sources (superseded), does not delete ---
  const s1 = idFromAdd(textOf(await call("memory_add", { fragment: "Redis is used for the rate-limiter bucket store.", type: "fact", title: "Redis rate limit" })));
  const s2 = idFromAdd(textOf(await call("memory_add", { fragment: "The rate limiter stores buckets in Redis with a 60s TTL.", type: "fact", title: "Redis TTL" })));
  const merge = await call("memory_merge", { ids: [s1, s2], title: "Rate limiter storage", fragment: "The rate limiter stores token buckets in Redis (60s TTL).", consolidate: true });
  const mergeText = textOf(merge);
  check("merge reports non-destructive consolidation", /Consolidated/i.test(mergeText) && /reversible/i.test(mergeText), mergeText.slice(0, 200));
  { const db = openDb();
    const kept = db.prepare("SELECT COUNT(*) n FROM memories WHERE legacy_id IN (?,?)").get(s1, s2).n;
    check("consolidate kept both source fragments", kept === 2, `kept=${kept}`);
    const lowConf = db.prepare("SELECT COUNT(*) n FROM memories WHERE legacy_id IN (?,?) AND confidence <= 0.1").get(s1, s2).n;
    check("sources down-weighted to <=0.1", lowConf === 2, `lowConf=${lowConf}`);
    db.close(); }

  // --- B3: forget consolidate archives instead of deleting ---
  const f1 = idFromAdd(textOf(await call("memory_add", { fragment: "The legacy cron job runs nightly at 2am UTC.", type: "fact", title: "Cron" })));
  const forget = await call("memory_forget", { id: f1, consolidate: true });
  check("forget consolidate reports archive (not delete)", /Archived/i.test(textOf(forget)), textOf(forget).slice(0, 160));
  { const db = openDb(); const row = db.prepare("SELECT confidence FROM memories WHERE legacy_id=?").get(f1); db.close();
    check("archived fragment kept and down-weighted", !!row && row.confidence <= 0.05, row ? `conf=${row.confidence}` : "row missing"); }

  console.log("");
} catch (e) {
  failures++;
  console.error("FATAL:", e?.stack || e);
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
