// CONFIRM-ONLY: no fixes. Runs each tool, dumps real structuredContent keys vs
// outputSchema expected keys, and flags -32602 validation breaks separately
// from silent (non-required) shape mismatches.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-conf-"));
const fh = path.join(tmp, "h"); const proj = path.join(tmp, "p");
fs.mkdirSync(fh,{recursive:true}); fs.mkdirSync(proj,{recursive:true});
const t = new StdioClientTransport({ command: process.execPath, args:[path.resolve("dist/index.js")], cwd: proj, env:{...process.env, HOME:fh, XDG_CONFIG_HOME:path.join(fh,".config")} });
const c = new Client({name:"conf",version:"1"}, {capabilities:{}});
await c.connect(t);
const { tools } = await c.listTools();
const expected = {};
for (const tl of tools) if (tl.outputSchema?.properties) expected[tl.name] = Object.keys(tl.outputSchema.properties);

async function run(name, args) {
  let r;
  try { r = await c.callTool({name, arguments: args}); }
  catch (e) {
    return { name, error: String(e.message).slice(0,200) };
  }
  const got = r.structuredContent ? Object.keys(r.structuredContent) : [];
  const exp = expected[name] || [];
  const missing = exp.filter(k => !(k in (r.structuredContent||{})));
  return { name, got, expected: exp, missing, isError: !!r.isError };
}

const results = [];
// setup
await c.callTool({name:"session_start", arguments:{task_type:"testing", technologies:["node"]}});
const a = await c.callTool({name:"memory_add", arguments:{fragment:"## X\n### Context\nA.\n- one", title:"A", type:"fact"}});
const idA = a.structuredContent?.id;
const b = await c.callTool({name:"memory_add", arguments:{fragment:"## Y\n### Context\nB.\n- two", title:"B", type:"fact"}});
const idB = b.structuredContent?.id;

results.push(await run("memory_read", {query:"x", limit:5}));
if (idA) results.push(await run("memory_read", {id: idA}));
results.push(await run("memory_stats", {}));
results.push(await run("memory_audit", {}));
results.push(await run("session_stats", {count:2}));
results.push(await run("memory_library", {limit:5}));
results.push(await run("project_analytics", {}));
results.push(await run("conflict_scan", {}));
results.push(await run("proactive_analysis", {}));
results.push(await run("semantic_search", {query:"x", topK:3}));
results.push(await run("guide_get", {}));

console.log("\n=== OUTPUT SCHEMA vs ACTUAL DATA — CONFIRMATION ===\n");
const breaks = [], silent = [], ok = [];
for (const r of results) {
  if (r.error) { breaks.push(r); }
  else if (r.missing && r.missing.length > 0) silent.push(r);
  else ok.push(r);
  const tag = r.error ? "❌-32602" : (r.missing?.length ? "⚠️ silent-mismatch" : "✅");
  console.log(`${tag} ${r.name}`);
  if (r.error) { console.log(`      ${r.error}`); }
  else if (r.missing?.length) {
    console.log(`      expected: ${r.expected.join(", ")}`);
    console.log(`      actual:   ${r.got.join(", ")}`);
    console.log(`      MISSING:  ${r.missing.join(", ")}`);
  }
}
console.log(`\nSUMMARY: ${breaks.length} validation-break(-32602) | ${silent.length} silent mismatch | ${ok.length} clean`);
await c.close(); await t.close();
fs.rmSync(tmp,{recursive:true,force:true});
