#!/usr/bin/env node
/**
 * C2 real-server test — proves the quality_score revival works end-to-end over
 * the REAL Lemma MCP server (stdio), then inspects the SQLite DB directly.
 *
 *   1. memory_add → memory_read populates the formerly-dormant quality_score
 *   2. repeated negative memory_feedback builds a poor track record
 *   3. memory_read then surfaces a specific low-quality refine suggestion
 *   4. the DB row's quality_score is non-null and low
 *
 * Isolation: HOME → temp dir, so the real ~/.lemma DB is never touched.
 * Run:  node tests/manual/c2-quality-mcp.mjs   (after npm run build)
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

if (!fs.existsSync(SERVER_SCRIPT)) {
  console.error(`Built server not found. Run \`npm run build\` first.`);
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-c2-"));
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
const client = new Client({ name: "c2-test", version: "1.0.0" }, { capabilities: {} });

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.error(`  ✖ ${name}${extra ? " — " + extra : ""}`); }
};
const textOf = (r) => (r?.content?.[0]?.text) || "";
const call = (name, args) => client.callTool({ name, arguments: args });

try {
  await client.connect(transport);

  // 1. Add a fragment, then read it so boostOnAccess populates quality_score.
  await call("memory_add", {
    fragment: "The build cache lives in .turbo and must be cleared after a schema change.",
    type: "fact",
    title: "Turbo build cache",
  });
  const firstRead = await call("memory_read", { query: "build cache turbo schema" });
  check("memory_read returns the fragment", textOf(firstRead).includes("build cache") || textOf(firstRead).toLowerCase().includes("turbo"));

  // Locate the DB and confirm quality_score is now populated (was always NULL before C2).
  const dbPath = path.join(fakeHome, ".lemma", "lemma.db");
  check("lemma.db exists", fs.existsSync(dbPath), dbPath);
  let db = new Database(dbPath, { readonly: true });
  let row = db.prepare("SELECT legacy_id, quality_score, confidence FROM memories WHERE fragment LIKE '%.turbo%' LIMIT 1").get();
  db.close();
  check("quality_score populated after read (non-null)", row && row.quality_score !== null, row ? `got ${row.quality_score}` : "no row");
  check("populated quality_score is in [0,1]", row && row.quality_score >= 0 && row.quality_score <= 1, row ? `${row.quality_score}` : "");
  const legacyId = row?.legacy_id;

  // 2. Build a poor track record: repeated negative feedback (each drives a
  //    negative recall hit + negative_feedback, per the real handler).
  for (let i = 0; i < 4; i++) {
    await call("memory_feedback", { id: legacyId, useful: false });
  }

  // 3. proactive_analysis (the live surface for runFullAnalysis) should now flag
  //    the fragment below the quality threshold, citing the exact counters.
  const analysis = await call("proactive_analysis", {});
  const analysisText = textOf(analysis);
  check("low-quality refine suggestion surfaces", /below the quality threshold/i.test(analysisText), analysisText.slice(-500));
  check("suggestion cites the exact negative counters", /negative/i.test(analysisText));

  // 4. DB reflects a low, non-null quality_score.
  db = new Database(dbPath, { readonly: true });
  row = db.prepare("SELECT quality_score, negative_hits, negative_feedback FROM memories WHERE legacy_id = ?").get(legacyId);
  db.close();
  check("negative feedback recorded in DB", row && row.negative_feedback >= 4, row ? `neg_fb=${row.negative_feedback}` : "");
  check("negative hits recorded in DB", row && row.negative_hits >= 4, row ? `neg_hits=${row.negative_hits}` : "");
  check("quality_score dropped below threshold (0.35)", row && row.quality_score !== null && row.quality_score < 0.35, row ? `q=${row.quality_score}` : "");

  console.log(`\nfinal quality_score=${row?.quality_score}  neg_hits=${row?.negative_hits}  neg_fb=${row?.negative_feedback}`);
} catch (e) {
  failures++;
  console.error("FATAL:", e?.stack || e);
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
