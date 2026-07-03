#!/usr/bin/env node
/**
 * Real-LLM end-to-end test: GLM-5.1 (Z.AI coding-plan endpoint) acts as the
 * calling agent and drives the REAL Lemma MCP server over stdio through an
 * OpenAI-style tool-calling loop. This exercises Lemma the way a live coding
 * agent would — no mocks, no unit-test shims.
 *
 *   Turn 1 (session A): agent is told a fact → expected to call memory_add.
 *   Turn 2 (session B, fresh chat): agent is asked to recall it → expected to
 *           call memory_read and answer from Lemma's memory, not from the chat
 *           history (which no longer contains the fact).
 *
 * Secret handling: the API key is read from env ZAI_API_KEY only — never written
 * to disk or logged (matches Lemma's local-first / secret-redaction ethos).
 *
 * Run:  ZAI_API_KEY=... node tests/manual/glm-agent-mcp.mjs   (after npm run build)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4";
const MODEL = process.env.ZAI_MODEL || "glm-5.1";

if (!API_KEY) {
  console.error("Set ZAI_API_KEY in the environment (Z.AI coding-plan key).");
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const SERVER_SCRIPT = path.join(REPO, "dist", "index.js");
if (!fs.existsSync(SERVER_SCRIPT)) {
  console.error("Run `npm run build` first.");
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-glm-"));
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
const client = new Client({ name: "glm-agent", version: "1.0.0" }, { capabilities: {} });

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.error(`  ✖ ${name}${extra ? " — " + extra : ""}`); }
};

const toolCallLog = [];

async function chat(messages, tools) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 1500 }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message;
}

// Run one agent "conversation" to completion, executing any tool calls against
// the real Lemma server. Returns the final assistant text.
async function runAgent(systemPrompt, userPrompt, tools) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  for (let step = 0; step < 6; step++) {
    const msg = await chat(messages, tools);
    if (!msg) break;
    const calls = msg.tool_calls || [];
    // Push assistant turn (content may be null when only tool_calls are present).
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls.length ? calls : undefined });
    if (!calls.length) return msg.content || "";
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      toolCallLog.push({ name: tc.function.name, args });
      let resultText = "";
      try {
        const r = await client.callTool({ name: tc.function.name, arguments: args });
        resultText = (r?.content || []).map((c) => c.text || "").join("\n").slice(0, 4000);
      } catch (e) {
        resultText = `ERROR: ${e?.message || e}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
    }
  }
  return "";
}

try {
  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  check("real Lemma server exposes 26 tools", mcpTools.length === 26, `got ${mcpTools.length}`);

  // MCP tool schemas → OpenAI function tools. Lemma injects memory into some
  // descriptions; truncate so the tool list stays focused for the model.
  const tools = mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: (t.description || "").split("\n")[0].slice(0, 240),
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));

  const SYS =
    "You are a coding agent with a persistent memory system exposed as tools " +
    "(memory_add, memory_read, and others). When the user tells you a durable " +
    "fact about their project, persist it with memory_add. When the user asks " +
    "about something you may have stored earlier, use memory_read to recall it " +
    "before answering. Keep answers short.";

  // --- Turn 1: teach a fact (fresh chat) ---
  await runAgent(
    SYS,
    "For this project: the deploy script is scripts/deploy.sh and it requires the " +
      "environment variable AWS_PROFILE=prod. Please remember this for later.",
    tools,
  );
  const addCalls = toolCallLog.filter((c) => c.name === "memory_add");
  check("agent called memory_add to persist the fact", addCalls.length >= 1);
  const savedText = JSON.stringify(addCalls).toLowerCase();
  check("persisted content mentions deploy.sh", savedText.includes("deploy.sh"));
  check("persisted content mentions AWS_PROFILE", savedText.includes("aws_profile"));

  // --- Turn 2: recall in a brand-new chat (no fact in history) ---
  const recallCountBefore = toolCallLog.filter((c) => c.name === "memory_read").length;
  const answer = await runAgent(
    SYS,
    "What is the deploy script for this project and which environment variable must be set? " +
      "Check your memory first.",
    tools,
  );
  const readCalls = toolCallLog.filter((c) => c.name === "memory_read").length - recallCountBefore;
  check("agent called memory_read to recall", readCalls >= 1);
  const ans = (answer || "").toLowerCase();
  check("final answer names deploy.sh", ans.includes("deploy.sh"), answer?.slice(0, 200));
  check("final answer names AWS_PROFILE=prod", ans.includes("aws_profile") && ans.includes("prod"), answer?.slice(0, 200));

  console.log(`\nmodel=${MODEL}  tool calls: ${toolCallLog.map((c) => c.name).join(", ")}`);
  console.log(`final answer: ${(answer || "").slice(0, 300)}`);
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
