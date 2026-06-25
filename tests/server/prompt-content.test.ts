import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { INSTRUCTIONS_TEMPLATE, TOOL_NUDGES } from "../../src/server/prompt-content.js";
import { TOOLS } from "../../src/server/tools.js";

describe("INSTRUCTIONS_TEMPLATE", () => {
  test("is a non-empty English string", () => {
    assert.ok(typeof INSTRUCTIONS_TEMPLATE === "string");
    assert.ok(INSTRUCTIONS_TEMPLATE.length > 200);
  });

  test("contains the core teaching sections", () => {
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("Persistent Memory"));
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("How to work"));
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("Writing a fragment"));
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("Relations"));
  });

  test("references the memory pipeline", () => {
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("memory_read"));
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("memory_add"));
    assert.ok(INSTRUCTIONS_TEMPLATE.includes("ENGLISH"));
  });

  test("never references AGENTS.md", () => {
    assert.ok(!INSTRUCTIONS_TEMPLATE.includes("AGENTS.md"));
  });
});

describe("TOOL_NUDGES", () => {
  test("every key is a real tool name", () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    for (const key of Object.keys(TOOL_NUDGES)) {
      assert.ok(toolNames.has(key), `Unknown tool in TOOL_NUDGES: ${key}`);
    }
  });

  test("every value is a non-empty string", () => {
    for (const [key, value] of Object.entries(TOOL_NUDGES)) {
      assert.ok(typeof value === "string" && value.length > 0, `Empty nudge for ${key}`);
    }
  });

  test("covers the critical workflow tools", () => {
    const required = ["session_start", "memory_read", "memory_add", "session_end"];
    for (const name of required) {
      assert.ok(name in TOOL_NUDGES, `Missing nudge for critical tool: ${name}`);
    }
  });

  test("no nudge references AGENTS.md", () => {
    for (const value of Object.values(TOOL_NUDGES)) {
      assert.ok(!value.includes("AGENTS.md"));
    }
  });

  test("model-facing copy avoids legacy lemma_-prefixed tool names", () => {
    const copy = [
      INSTRUCTIONS_TEMPLATE,
      ...Object.values(TOOL_NUDGES),
      ...TOOLS.map(t => t.description),
    ].join("\n");
    assert.ok(copy.includes("memory_read"));
    assert.ok(copy.includes("memory_add"));
    assert.ok(copy.includes("guide_practice"));
    assert.ok(!/\blemma_(memory|guide|session|suggestion|conflict|proactive|project|semantic)_/.test(copy));
  });
});
