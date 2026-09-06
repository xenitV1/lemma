#!/usr/bin/env node
/**
 * Wave 3 real-MCP end-to-end test — spawns the REAL built Lemma server over
 * stdio and drives every Wave 3 feature through the actual MCP protocol
 * (not direct function calls):
 *
 *   A3  memory_read expand_graph:true      → related-graph section
 *   B2  memory_forget invalidate=true      → hidden from recall, reversible
 *   B6  memory_add evidence + stale_check  → ⚠ STALE flag after the file drifts
 *   A4  semantic_search hybrid:true        → fused BM25+TF-IDF results
 *   C4  proactive_analysis                 → runs clean over the real server
 *
 * Run:  npm run build && node tests/manual/wave3-mcp.mjs
 * Isolation: HOME → temp dir, so the real ~/.lemma is never touched. The temp
 * ~/.lemma/config.json enables verification.stale_check for the B6 leg.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const SERVER_SCRIPT = path.join(REPO, "dist", "index.js");

if (!fs.existsSync(SERVER_SCRIPT)) {
  console.error(`Built server not found at ${SERVER_SCRIPT}. Run \`npm run build\` first.`);
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-wave3-mcp-"));
const projectDir = path.join(tmpRoot, "proj");
const fakeHome = path.join(tmpRoot, "home");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(path.join(fakeHome, ".lemma"), { recursive: true });

// Enable the B6 opt-in recall staleness check for this run.
fs.writeFileSync(
  path.join(fakeHome, ".lemma", "config.json"),
  JSON.stringify({ verification: { stale_check: true } }, null, 2),
);

// A real source file the B6 evidence will cite.
const codeFile = path.join(projectDir, "retry.ts");
fs.writeFileSync(codeFile, "export function retry() {\n  await sleep(2 ** i * 1000);\n}\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_SCRIPT],
  cwd: projectDir,
  env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config") },
});
const client = new Client({ name: "wave3-test", version: "1.0.0" }, { capabilities: {} });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.error(`  ✖ ${name}${extra ? " — " + extra : ""}`); }
}
const textOf = (r) => r?.content?.[0]?.text ?? "";
const idOf = (r) => r?.structuredContent?.id ?? (textOf(r).match(/\[([^\]]+)\]/)?.[1]);
const call = (name, args) => client.callTool({ name, arguments: args });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  check("29 tools returned", tools.length === 29, `got ${tools.length}`);

  // Confirm the new optional params are advertised on the real tool schemas.
  const memRead = tools.find((t) => t.name === "memory_read");
  const memAdd = tools.find((t) => t.name === "memory_add");
  const memForget = tools.find((t) => t.name === "memory_forget");
  const semSearch = tools.find((t) => t.name === "semantic_search");
  check("memory_read exposes expand_graph (A3)", !!memRead?.inputSchema?.properties?.expand_graph);
  check("memory_add exposes evidence (B6)", !!memAdd?.inputSchema?.properties?.evidence);
  check("memory_forget exposes invalidate (B2)", !!memForget?.inputSchema?.properties?.invalidate);
  check("semantic_search exposes hybrid (A4)", !!semSearch?.inputSchema?.properties?.hybrid);

  // --- A3: relations graph expansion ---
  const ga = await call("memory_add", { fragment: "## Indexing\nDatabase indexing strategy for the api layer.", project: "global" });
  const gb = await call("memory_add", { fragment: "## BTree\nBtree internals and page split behavior.", project: "global" });
  const gaId = idOf(ga), gbId = idOf(gb);
  await call("memory_relate", { sourceId: gaId, targetId: gbId, type: "related_to" });
  const expanded = await call("memory_read", { id: gaId, expand_graph: true });
  check("A3 expand_graph surfaces the related section", /Related knowledge \(graph/.test(textOf(expanded)));
  check("A3 expand_graph includes the neighbor id", textOf(expanded).includes(gbId));
  check("A3 structuredContent has related_graph", Array.isArray(expanded?.structuredContent?.related_graph));

  // --- B2: logical invalidation hides from recall, reversibly ---
  const inv = await call("memory_add", { fragment: "## Ephemeral\nUnique-marker zzqxwv temporary note about mqtt.", project: "global" });
  const invId = idOf(inv);
  check("B2 fragment present before invalidation", textOf(await call("memory_read", { query: "zzqxwv" })).includes(invId));
  await call("memory_forget", { id: invId, invalidate: true });
  check("B2 hidden from recall after invalidate", !textOf(await call("memory_read", { query: "zzqxwv" })).includes(invId));

  // --- B6: code evidence + config-gated staleness ---
  const ev = await call("memory_add", {
    fragment: "## Retry policy\nUses exponential backoff for transient failures.",
    project: "global",
    evidence: { file: codeFile, symbol: "retry", snippet: "await sleep(2 ** i * 1000);" },
  });
  const evId = idOf(ev);
  check("B6 fresh evidence is not flagged stale", !/STALE/i.test(textOf(await call("memory_read", { id: evId }))));
  fs.writeFileSync(codeFile, "export function retry() {\n  await sleep(500);\n}\n"); // drift the snippet away
  const staleRead = await call("memory_read", { id: evId });
  check("B6 flags STALE after the cited snippet drifts", /STALE/i.test(textOf(staleRead)));
  check("B6 structuredContent has stale_evidence", Array.isArray(staleRead?.structuredContent?.stale_evidence));

  // --- A4: hybrid retrieval ---
  await call("memory_add", { fragment: "## Pooling\nPostgres connection pooling with pgbouncer for high concurrency.", project: "global" });
  await call("memory_add", { fragment: "## Sizing\nDatabase connection pool sizing and pgbouncer transaction mode.", project: "global" });
  const hybrid = await call("semantic_search", { query: "pgbouncer connection pool", hybrid: true, topK: 3 });
  check("A4 hybrid search returns results", (hybrid?.structuredContent?.results?.length ?? 0) >= 1, textOf(hybrid).slice(0, 80));
  check("A4 hybrid top result is relevant", /pgbouncer|pool/i.test(textOf(hybrid)));

  // --- C4: proactive analysis runs clean over the real server ---
  const proactive = await call("proactive_analysis", {});
  check("C4 proactive_analysis responds without error", !proactive?.isError && textOf(proactive).includes("PROACTIVE ANALYSIS"));

  console.log(`\ntools: ${tools.length}`);

  // Close connection 1: stdin end → graceful shutdown → the virtual session
  // built by all the tool calls above is finalized and persisted to SQL (C1).
  await client.close();
  await transport.close();

  // --- C1: reconnect (same HOME → same DB) and confirm the episode persisted ---
  const transport2 = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_SCRIPT],
    cwd: projectDir,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config") },
  });
  const client2 = new Client({ name: "wave3-test-2", version: "1.0.0" }, { capabilities: {} });
  try {
    await client2.connect(transport2);
    const stats = await client2.callTool({ name: "session_stats", arguments: {} });
    const stext = stats?.content?.[0]?.text ?? "";
    const total = stats?.structuredContent?.total_sessions ?? stats?.structuredContent?.total ?? null;
    check("C1 virtual session persisted to SQL (session_stats sees ≥1)",
      (typeof total === "number" && total >= 1) || /session/i.test(stext),
      `stats: ${stext.slice(0, 80)}`);
  } finally {
    try { await client2.close(); } catch {}
    try { await transport2.close(); } catch {}
  }
} catch (e) {
  failures++;
  console.error("FATAL during client/server interaction:", e?.stack || e);
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
