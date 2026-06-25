// PROVES project-scoped memory injection end-to-end:
//   S1: fresh install (empty DB) -> global seed memories injected on startup
//   S2: save a project note in projA -> new day/session in projA -> note appears
//   S3: open projB (same DB) -> projA note is HIDDEN (project isolation)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";

const REPO = path.resolve(".");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-inj-"));
const HOME = path.join(tmp, "home");
const projA = path.join(tmp, "projA");
const projB = path.join(tmp, "projB");
fs.mkdirSync(HOME,{recursive:true}); fs.mkdirSync(projA,{recursive:true}); fs.mkdirSync(projB,{recursive:true});

async function withServer(cwd, fn) {
  const t = new StdioClientTransport({ command: process.execPath, args:[path.join(REPO,"dist/index.js")], cwd,
    env:{...process.env, HOME, XDG_CONFIG_HOME:path.join(HOME,".config")} });
  const c = new Client({name:"inj",version:"1"}, {capabilities:{}});
  await c.connect(t);
  try { return await fn(c); }
  finally { try{await c.close();}catch{} try{await t.close();}catch{} }
}

function extractMemoryIndex(instructions) {
  const m = instructions.match(/## Your current memory[\s\S]*?(?=\n## |$)/);
  return (m?m[0]:instructions).trim();
}
function extractInject(toolDesc) {
  const m = toolDesc.match(/YOUR PERSISTENT MEMORY[\s\S]*$/);
  return m ? m[0].slice(0,400) : "(no inject)";
}

console.log("=".repeat(70));
console.log("S1 — FRESH INSTALL (empty DB), project projA");
console.log("=".repeat(70));
await withServer(projA, async (c) => {
  const instr = c.getInstructions();
  console.log(">> instructions 'Your current memory':");
  console.log(extractMemoryIndex(instr));
  const { tools } = await c.listTools();
  const mr = tools.find(t=>t.name==="memory_read");
  console.log("\n>> memory_read tool inject (first 400 chars):");
  console.log(extractInject(mr.description));
});

console.log("\n" + "=".repeat(70));
console.log("S2 — SAVE project note in projA (NO explicit project), then REOPEN projA");
console.log("=".repeat(70));
await withServer(projA, async (c) => {
  // NOTE: no `project` arg — relies on auto-detect (cwd basename = proja)
  const r = await c.callTool({name:"memory_add", arguments:{
    fragment:"## projA deployment\n### Context\nSpecial deploy step.\n- run npm run build:assets before deploy",
    title:"projA deployment note", type:"lesson"}});
  console.log(">> saved note (no project arg), id:", r.structuredContent?.id);
});
await new Promise(res=>setTimeout(res, 400)); // ensure DB flushed/closed
await withServer(projA, async (c) => {
  const instr = c.getInstructions();
  console.log(">> REOPENED projA — instructions 'Your current memory':");
  console.log(extractMemoryIndex(instr));
  const { tools } = await c.listTools();
  const mr = tools.find(t=>t.name==="memory_read");
  const inj = extractInject(mr.description);
  console.log("\n>> REOPENED projA — memory_read inject contains the note?", inj.includes("projA deployment"));
});

console.log("\n" + "=".repeat(70));
console.log("S3 — OPEN projB (same DB) — projA note must be HIDDEN");
console.log("=".repeat(70));
await withServer(projB, async (c) => {
  const instr = c.getInstructions();
  const idx = extractMemoryIndex(instr);
  console.log(">> projB instructions 'Your current memory':");
  console.log(idx);
  const { tools } = await c.listTools();
  const mr = tools.find(t=>t.name==="memory_read");
  const inj = extractInject(mr.description);
  console.log("\n>> projA note HIDDEN in projB?", !inj.includes("projA deployment"), "| global seed still present?", inj.includes("Task Complexity") || idx.includes("Task") || idx.includes("no saved") === false ? "yes" : "check");
});

fs.rmSync(tmp,{recursive:true,force:true});
