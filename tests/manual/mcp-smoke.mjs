#!/usr/bin/env node
/**
 * MCP smoke test — spawns the REAL Lemma server over stdio and exercises the
 * two prompt channels end-to-end via the MCP protocol:
 *
 *   1. `initialize`   → the `instructions` field (teaching content, no AGENTS.md)
 *   2. `tools/list`   → per-tool ⚠️ nudges, memory_read still carries memory content
 *
 * Plus the startup migration: a seeded stale Lemma block in AGENTS.md must be
 * surgically removed while the user's own AGENTS.md content is preserved.
 *
 * Run:  node tests/manual/mcp-smoke.mjs
 *   (after `npm run build` — needs dist/index.js)
 *
 * Isolation: spawns the server with HOME pointed at a temp dir, so the real
 * ~/.lemma memory/DB is never read or written.
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

// Isolated env so the real ~/.lemma memory/DB is never touched.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-mcp-smoke-"));
const projectDir = path.join(tmpRoot, "smoke-proj");
const fakeHome = path.join(tmpRoot, "fake-home");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });

// Pre-seed AGENTS.md: real user content + a stale Lemma-injected block + more user content.
const seeded =
  "# My Project Rules\n\nDo good work.\n" +
  "<!-- lemma:start -->\n## Lemma — Persistent Memory System\nOLD INJECTED CONTENT\n<!-- lemma:end -->\n" +
  "\n## More Rules\n\nBe nice.\n";
fs.writeFileSync(path.join(projectDir, "AGENTS.md"), seeded);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_SCRIPT],
  cwd: projectDir,
  env: { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config") },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✖ ${name}${extra ? " — " + extra : ""}`);
  }
}

try {
  await client.connect(transport); // performs the initialize handshake

  // --- 1. instructions channel (MCP `instructions` field) ---
  const instructions = client.getInstructions();
  check("instructions is a non-empty string", typeof instructions === "string" && instructions.length > 0, `got ${typeof instructions}`);
  check("instructions has 'Persistent Memory'", instructions?.includes("Persistent Memory"));
  check("instructions has 'memory_add'", instructions?.includes("memory_add"));
  check("instructions has 'ENGLISH'", instructions?.includes("ENGLISH"));
  check("instructions has NO 'AGENTS.md'", !(instructions?.includes("AGENTS.md")));

  // --- 2. tools/list channel ---
  const { tools } = await client.listTools();
  check("26 tools returned", tools.length === 26, `got ${tools.length}`);
  const memRead = tools.find((t) => t.name === "memory_read");
  const memAdd = tools.find((t) => t.name === "memory_add");
  const sessStart = tools.find((t) => t.name === "session_start");
  check("memory_read carries its nudge", memRead?.description.includes("ALWAYS read before acting"));
  check("memory_read still carries memory content", memRead?.description.includes("PERSISTENT MEMORY") || memRead?.description.includes("No memories yet"));
  check("memory_add carries its nudge", memAdd?.description.includes("Save new knowledge IMMEDIATELY"));
  check("session_start carries its nudge", sessStart?.description.includes("FIRST when starting a task"));
  const sessAttempt = tools.find((t) => t.name === "session_attempt");
  check("session_attempt tool exists", !!sessAttempt);
  check("session_attempt carries its nudge", sessAttempt?.description.includes("dead ends"));
  const offenders = tools.filter((t) => t.description?.includes("AGENTS.md")).map((t) => t.name);
  check("NO tool description mentions AGENTS.md", offenders.length === 0, `offending: ${offenders.join(", ")}`);

  // --- 3. AGENTS.md startup migration (removeAgentsMd ran during initializeContext) ---
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const after = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf-8") : null;
  check("AGENTS.md still exists (real user content remains)", after !== null && after.length > 0);
  check("AGENTS.md: stale Lemma block removed", !!after && !after.includes("lemma:start") && !after.includes("OLD INJECTED CONTENT"));
  check("AGENTS.md: user content preserved", !!after && after.includes("My Project Rules") && after.includes("Be nice"));

  // --- 4. Continuity flow over the real server ---
  async function call(toolName, args) {
    return client.callTool({ name: toolName, arguments: args });
  }
  await call("session_start", { task_type: "debugging", technologies: ["react"] });
  await call("session_attempt", { approach: "useState derived cache", outcome: "rejected", critique: "re-render loop" });
  await call("session_end", { outcome: "success", final_approach: "useMemo" });
  const secondStart = await call("session_start", { task_type: "debugging", technologies: ["react"] });
  const recallText = (secondStart.content?.[0]?.text) || "";
  check("continuity recall surfaces prior dead end", recallText.includes("useState derived cache"));
  check("continuity recall has Dead ends heading", recallText.includes("Dead ends"));

  console.log(`\ninstructions: ${instructions?.length ?? 0} chars (~${Math.ceil((instructions?.length ?? 0) / 3.5)} tokens)  |  tools: ${tools.length}`);
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
