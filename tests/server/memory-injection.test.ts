import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as core_config from "../../src/memory/config.js";
import { buildInstructions, buildInjectedTools, BASE_SYSTEM_PROMPT } from "../../src/server/system-prompt.js";
import { TOOLS } from "../../src/server/tools.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-injection-test-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  core_config.resetConfig();
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  core_config.resetConfig();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("buildInstructions", () => {
  test("returns non-empty string with no memory", () => {
    const result = buildInstructions(null);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
    assert.ok(!result.includes("AGENTS.md"));
    assert.ok(result.includes("memory_add"));
  });

  test("includes project name when provided", () => {
    const frags = [core.createFragment("test fact", "ai", "Test", "myproject")];
    core.saveMemory(frags);

    const result = buildInstructions("myproject");
    assert.ok(result.includes("myproject"));
  });

  test("includes fragment summary for project fragments", () => {
    const frags = [core.createFragment("important project knowledge", "ai", "Proj Knowledge", "testproj")];
    core.saveMemory(frags);

    const result = buildInstructions("testproj");
    assert.ok(result.includes("Proj Knowledge"));
  });

  test("includes global fragment summary", () => {
    const frags = [core.createFragment("global preference", "ai", "Global Prefs", null)];
    core.saveMemory(frags);

    const result = buildInstructions(null);
    assert.ok(result.includes("Global Prefs"));
  });

  test("includes guide count when guides exist", () => {
    const allGuides = guides.loadGuides();
    const g = guides.createGuide("test-guide", "dev-tool", "A test guide");
    allGuides.push(g);
    guides.saveGuides(allGuides);

    const result = buildInstructions(null);
    assert.ok(result.includes("guide"));
  });

  test("shows no memories message when empty", () => {
    const result = buildInstructions(null);
    assert.ok(result.includes("no saved memories") || result.includes("No memories"));
  });

  test("respects token budget", () => {
    const frags = Array.from({ length: 50 }, (_, i) =>
      core.createFragment("x".repeat(500), "ai", `Fragment ${i}`, "testproj")
    );
    core.saveMemory(frags);

    core_config.resetConfig();
    const result = buildInstructions("testproj");
    const cfg = core_config.loadConfig();
    const tokens = core_config.estimateTokens(result);
    assert.ok(tokens <= cfg.token_budget.instructions, `Expected <= ${cfg.token_budget.instructions} tokens, got ${tokens}`);
  });

  test("static template survives even under a tiny budget", () => {
    fs.writeFileSync(path.join(TMPDIR, "config.json"), JSON.stringify({ token_budget: { instructions: 50 } }));
    core_config.setConfigDir(TMPDIR);
    core_config.resetConfig();
    const result = buildInstructions(null);
    assert.ok(result.includes("Persistent Memory"), "Static template must survive budget pressure");
    core_config.setConfigDir(path.join(os.homedir(), ".lemma"));
    core_config.resetConfig();
  });

  test("includes tool references when memory exists", () => {
    const frags = [core.createFragment("test fact", "ai", "Test", null)];
    core.saveMemory(frags);

    const result = buildInstructions(null);
    assert.ok(result.includes("memory_read"));
  });

  test("shows no memories message when empty", () => {
    const result = buildInstructions(null);
    assert.ok(result.includes("no saved memories") || result.includes("No memories"));
  });

  test("contains behavioral rules, not an AGENTS.md pointer", () => {
    const result = buildInstructions(null);
    assert.ok(!result.includes("AGENTS.md"));
    assert.ok(result.includes("memory_read"));
    assert.ok(result.includes("memory_add"));
    assert.ok(result.includes("ENGLISH"));
  });
});

describe("buildInjectedTools", () => {
  test("returns array of tools with same count as original", async () => {
    const result = await buildInjectedTools(null);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 26, `Expected 26 tools, got ${result.length}`);
    const names = result.map(t => t.name);
    assert.ok(names.includes("memory_read"));
    assert.ok(names.includes("memory_add"));
  });

  test("does not mutate original TOOLS", async () => {
    const result1 = await buildInjectedTools(null);
    const result2 = await buildInjectedTools(null);
    assert.notStrictEqual(result1, result2);
    assert.notStrictEqual(result1[0], result2[0]);
  });

  test("injects memory content into memory_read description", async () => {
    const frags = [core.createFragment("injected test content", "ai", "Inject Test", "testproj")];
    core.saveMemory(frags);

    const result = await buildInjectedTools("testproj");
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("injected test content") || memRead.description.includes("Inject Test"));
  });

  test("injection contains memory markers", async () => {
    const result = await buildInjectedTools(null);
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("PERSISTENT MEMORY"));
  });

  test("non-memory_read tools do not receive memory content", async () => {
    const result = await buildInjectedTools(null);
    const memAdd = result.find(t => t.name === "memory_add");
    assert.ok(memAdd);
    assert.ok(!memAdd.description.includes("PERSISTENT MEMORY"));
  });

  test("shows no memories message when memory is empty", async () => {
    const result = await buildInjectedTools(null);
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("No memories yet"));
  });

  test("includes global fragments in injection", async () => {
    const frags = [core.createFragment("global knowledge item", "ai", "Global Item", null)];
    core.saveMemory(frags);

    const result = await buildInjectedTools("testproj");
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("Global Item") || memRead.description.includes("global knowledge"));
  });

  test("includes guide summary in injection", async () => {
    const allGuides = guides.loadGuides();
    const g = guides.createGuide("react-patterns", "web-frontend", "React patterns guide");
    g.usage_count = 5;
    g.success_count = 4;
    g.failure_count = 1;
    g.learnings = ["useCallback for perf"];
    allGuides.push(g);
    guides.saveGuides(allGuides);

    const result = await buildInjectedTools(null);
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("react-patterns") || memRead.description.includes("ACTIVE GUIDES"));
  });

  test("respects full content token budget", async () => {
    const frags = Array.from({ length: 30 }, (_, i) =>
      core.createFragment("y".repeat(1000), "ai", `Big Fragment ${i}`, "testproj")
    );
    core.saveMemory(frags);

    const result = await buildInjectedTools("testproj");
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    const injectionStart = memRead.description.indexOf("PERSISTENT MEMORY");
    const injectionText = memRead.description.substring(injectionStart);
    const tokens = core_config.estimateTokens(injectionText);
    assert.ok(tokens < 10000, `Injection tokens too high: ${tokens}`);
  });

  test("skips deprecated guides", async () => {
    const allGuides = guides.loadGuides();
    const g1 = guides.createGuide("active-guide", "dev-tool", "Active guide");
    g1.usage_count = 3;
    const g2 = guides.createGuide("deprecated-guide", "dev-tool", "Deprecated guide");
    g2.deprecated = true;
    g2.usage_count = 10;
    allGuides.push(g1, g2);
    guides.saveGuides(allGuides);

    const result = await buildInjectedTools(null);
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("active-guide"));
    assert.ok(!memRead.description.includes("deprecated-guide"));
  });

  test("tool names remain correct", async () => {
    const result = await buildInjectedTools(null);
    const names = result.map(t => t.name);
    assert.ok(names.includes("memory_read"));
    assert.ok(names.includes("memory_add"));
    assert.ok(names.includes("memory_update"));
    assert.ok(names.includes("memory_forget"));
    assert.ok(names.includes("memory_feedback"));
    assert.ok(names.includes("memory_merge"));
    assert.ok(names.includes("memory_relate"));
    assert.ok(names.includes("memory_stats"));
    assert.ok(names.includes("memory_audit"));
    assert.ok(names.includes("guide_get"));
    assert.ok(names.includes("guide_practice"));
    assert.ok(names.includes("guide_create"));
    assert.ok(names.includes("guide_distill"));
    assert.ok(names.includes("guide_update"));
    assert.ok(names.includes("guide_forget"));
    assert.ok(names.includes("guide_merge"));
    assert.ok(names.includes("session_start"));
    assert.ok(names.includes("session_end"));
    assert.ok(names.includes("session_stats"));
  });

  test("nudges are appended to relevant tools", async () => {
    const result = await buildInjectedTools(null);
    const memAdd = result.find(t => t.name === "memory_add");
    assert.ok(memAdd);
    assert.ok(memAdd.description.includes("Save new knowledge IMMEDIATELY"), "memory_add should carry its nudge");
    const sessStart = result.find(t => t.name === "session_start");
    assert.ok(sessStart);
    assert.ok(sessStart.description.includes("FIRST when starting a task"), "session_start should carry its nudge");
  });

  test("session_attempt carries its dead-end nudge", async () => {
    const result = await buildInjectedTools(null);
    const attempt = result.find(t => t.name === "session_attempt");
    assert.ok(attempt, "session_attempt tool must exist");
    assert.ok(
      attempt.description.includes("dead ends are the MOST valuable memory"),
      "session_attempt should carry its dead-end nudge",
    );
  });

  test("memory_read keeps both nudge and memory content", async () => {
    const frags = [core.createFragment("content xyz marker", "ai", "Xyz Marker", "p")];
    core.saveMemory(frags);
    const result = await buildInjectedTools("p");
    const memRead = result.find(t => t.name === "memory_read");
    assert.ok(memRead);
    assert.ok(memRead.description.includes("ALWAYS read before acting"), "memory_read should carry its nudge");
    assert.ok(memRead.description.includes("PERSISTENT MEMORY"), "memory_read should still carry memory content");
  });

  test("non-nudged tools keep their static description unchanged", async () => {
    const result = await buildInjectedTools(null);
    const audit = result.find(t => t.name === "memory_audit");
    assert.ok(audit);
    const staticAudit = TOOLS.find(t => t.name === "memory_audit");
    assert.ok(staticAudit);
    assert.strictEqual(audit.description, staticAudit.description);
  });
});

describe("BASE_SYSTEM_PROMPT", () => {
  test("is self-contained — no AGENTS.md reference", () => {
    assert.ok(!BASE_SYSTEM_PROMPT.includes("AGENTS.md"));
  });

  test("tells the LLM how to use memory", () => {
    assert.ok(BASE_SYSTEM_PROMPT.includes("memory_read"));
    assert.ok(BASE_SYSTEM_PROMPT.includes("memory_add"));
  });
});
