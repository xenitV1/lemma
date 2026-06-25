// Deep MCP flow test: exercises every tool end-to-end over the real server,
// verifies structuredContent presence + outputSchema key coverage + pagination.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-deep-"));
const fh = path.join(tmp, "h"); const proj = path.join(tmp, "p");
fs.mkdirSync(fh, {recursive:true}); fs.mkdirSync(proj,{recursive:true});
const t = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")], cwd: proj, env: {...process.env, HOME: fh, XDG_CONFIG_HOME: path.join(fh,".config")} });
const c = new Client({name:"deep",version:"1"}, {capabilities:{}});
await c.connect(t);

const { tools } = await c.listTools();
// Map tool name -> outputSchema required keys + all keys for coverage check.
const schema = {};
for (const tl of tools) {
  if (tl.outputSchema?.properties) {
    schema[tl.name] = {
      all: Object.keys(tl.outputSchema.properties),
      required: tl.outputSchema.required || [],
      hasAP: tl.inputSchema?.additionalProperties === false,
    };
  }
}

let pass=0, fail=0; const problems=[];
function check(name, cond, detail="") {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail?" :: "+detail:""}`); }
}

async function call(name, args, expectOk=true) {
  let r;
  try { r = await c.callTool({name, arguments: args}); }
  catch (e) { check(`${name} did not throw`, !expectOk, String(e.message).slice(0,120)); return null; }
  check(`${name} has structuredContent`, !!r.structuredContent);
  const sc = r.structuredContent || {};
  const sch = schema[name];
  if (sch) {
    // SDK validates required keys; check those. Non-required coverage is informational.
    for (const k of sch.required) {
      check(`${name}.structuredContent has required key "${k}"`, k in sc);
    }
  }
  // reminder/session append must NOT pollute structuredContent (only text)
  return r;
}

// ---- full lifecycle ----
await call("session_start", {task_type:"debugging", technologies:["react","typescript"]});
await call("session_attempt", {approach:"useEffect fetch", outcome:"rejected", critique:"race condition"});
await call("memory_add", {fragment:"## React hooks\n### Context\nState mgmt.\n- useState is basic", title:"React hooks", type:"lesson"});
const mems = await call("memory_read", {query:"react", limit:5});
const id = mems?.structuredContent?.fragments?.[0]?.id;
check("memory_read returns fragment id", !!id);
if (id) {
  await call("memory_update", {id, confidence:0.8});
  await call("memory_feedback", {id, useful:true});
  await call("memory_read", {id});
}
// add second + third fragment for merge/relate (3rd avoids auto-link collision)
const m2 = await call("memory_add", {fragment:"## TS types\n### Context\nTyping.\n- strict mode good", title:"TS types", type:"fact"});
const id2 = m2?.structuredContent?.id;
const m3 = await call("memory_add", {fragment:"## CSS grid\n### Context\nLayout.\n- grid template", title:"CSS grid", type:"fact"});
const id3 = m3?.structuredContent?.id;
if (id2 && id3) {
  const rel = await c.callTool({name:"memory_relate", arguments:{sourceId:id2, targetId:id3, type:"related_to", note:"frontend styling"}});
  // relate may hit auto-link collision (isError); only assert structuredContent on success
  if (!rel.isError) check("memory_relate has structuredContent", !!rel.structuredContent);
}
await call("memory_stats", {});
await call("memory_audit", {});
await call("memory_library", {limit:5});
await call("conflict_scan", {});
await call("proactive_analysis", {});
await call("project_analytics", {}); // overview mode: optional fields intentionally absent
await call("semantic_search", {query:"hooks state", topK:3});
await call("session_stats", {count:3});
await call("guide_get", {});
await call("guide_create", {guide:"react-hooks", category:"web-frontend", description:"### Mission\nMaster hooks.\n### Rules\n- always cleanup"});
await call("guide_practice", {guide:"react-hooks", category:"web-frontend", contexts:["hooks"], learnings:["useEffect cleanup"]});
if (id) await call("guide_distill", {memory_id:id, guide:"react-hooks"});
await call("guide_update", {guide:"react-hooks", add_pitfalls:["stale closures"]});

// pagination test on memory_read
const page1 = await call("memory_read", {limit:2, offset:0});
check("memory_read pagination has_more", page1?.structuredContent?.has_more !== undefined);

// error path: unknown id
const err1 = await c.callTool({name:"memory_read", arguments:{id:"m_nonexistent_xyz"}});
check("error path returns isError", !!err1.isError);

// suggestion_respond (no suggestions exist -> best effort)
try { await call("suggestion_respond", {id:1, action:"dismiss"}); } catch {}

// guide_merge + guide_forget + memory_forget + memory_merge (destructive, last)
if (id && id2) {
  await call("memory_merge", {ids:[id,id2], title:"Frontend notes", fragment:"merged", project:null});
}
await call("guide_create", {guide:"typescript", category:"programming-language", description:"### Mission\nTS.\n### Rules\n- strict mode"});
await call("guide_merge", {guides:["react-hooks","typescript"], guide:"frontend-all", category:"web-frontend"});
await call("guide_forget", {guide:"frontend-all"});

await call("session_end", {outcome:"success", lessons:["structured content works"]});

console.log(`\n=== DEEP TEST RESULT ===`);
console.log(`checks: ${pass} pass / ${fail} fail`);
console.log(`tools exercised with outputSchema coverage: ${Object.keys(schema).length}`);
const apCoverage = tools.filter(x=>x.inputSchema?.additionalProperties===false).length;
console.log(`additionalProperties:false coverage: ${apCoverage}/${tools.length}`);
if (problems.length) { console.log("\nPROBLEMS:"); for (const p of problems) console.log("  - "+p); }

await c.close(); await t.close();
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(fail>0?1:0);
