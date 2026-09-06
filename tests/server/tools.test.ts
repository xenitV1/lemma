import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { TOOLS } from "../../src/server/tools.js";

// The complete, canonical list of tool names. Any change to the tool set MUST
// update this list — the tests below lock the contract and prevent silent
// regressions (redundant prefix, dropped annotation, removed outputSchema).
const ALLOWED_NAMES = [
  "backup_create",
  "backup_preview",
  "backup_restore",
  "session_start",
  "session_end",
  "session_attempt",
  "suggestion_respond",
  "memory_read",
  "memory_add",
  "memory_update",
  "memory_forget",
  "memory_feedback",
  "memory_merge",
  "memory_relate",
  "memory_stats",
  "memory_audit",
  "memory_library",
  "guide_get",
  "guide_practice",
  "guide_create",
  "guide_distill",
  "guide_update",
  "guide_forget",
  "guide_merge",
  "session_stats",
  "conflict_scan",
  "proactive_analysis",
  "project_analytics",
  "semantic_search",
];

const READ_ONLY = new Set([
  "memory_stats",
  "memory_audit",
  "memory_library",
  "semantic_search",
  "conflict_scan",
  "proactive_analysis",
  "project_analytics",
  "guide_get",
  "session_stats",
]);

const DESTRUCTIVE = new Set([
  "backup_restore",
  "memory_forget",
  "memory_merge",
  "guide_forget",
  "guide_merge",
]);

const IDEMPOTENT = new Set([
  "session_start",
  "suggestion_respond",
  "memory_update",
  "memory_feedback",
  "memory_relate",
  "guide_update",
]);

describe("TOOLS registry", () => {
  test("exposes exactly the 29 short tool names", () => {
    const names = TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, [...ALLOWED_NAMES].sort());
  });

  test("has no duplicate names", () => {
    const names = TOOLS.map(t => t.name);
    assert.equal(new Set(names).size, names.length, "Duplicate tool names detected");
  });

  test("tool names do not carry the redundant lemma_ prefix", () => {
    for (const tool of TOOLS) {
      assert.ok(!tool.name.startsWith("lemma_"), `Tool has redundant lemma_ prefix: ${tool.name}`);
    }
  });

  test("every tool carries an outputSchema", () => {
    for (const tool of TOOLS) {
      assert.ok(tool.outputSchema, `Tool missing outputSchema: ${tool.name}`);
      assert.equal(tool.outputSchema!.type, "object", `outputSchema must be object: ${tool.name}`);
    }
  });

  test("every tool carries annotations with openWorldHint:false (local DB)", () => {
    for (const tool of TOOLS) {
      assert.ok(tool.annotations, `Tool missing annotations: ${tool.name}`);
      assert.equal(tool.annotations!.openWorldHint, false, `openWorldHint must be false: ${tool.name}`);
    }
  });

  test("read-only tools are annotated readOnlyHint:true", () => {
    for (const tool of TOOLS) {
      if (READ_ONLY.has(tool.name)) {
        assert.equal(tool.annotations!.readOnlyHint, true, `${tool.name} must be readOnlyHint:true`);
        assert.equal(tool.annotations!.idempotentHint, true, `${tool.name} must be idempotentHint:true`);
      }
    }
  });

  test("memory_read is not advertised as read-only because it tracks access/session state", () => {
    const tool = TOOLS.find(t => t.name === "memory_read");
    assert.ok(tool);
    assert.equal(tool.annotations!.readOnlyHint, false);
    assert.equal(tool.annotations!.idempotentHint, false);
  });

  test("destructive tools are annotated destructiveHint:true", () => {
    for (const tool of TOOLS) {
      if (DESTRUCTIVE.has(tool.name)) {
        assert.equal(tool.annotations!.destructiveHint, true, `${tool.name} must be destructiveHint:true`);
      }
    }
  });

  test("idempotent tools are annotated idempotentHint:true", () => {
    for (const tool of TOOLS) {
      if (IDEMPOTENT.has(tool.name)) {
        assert.equal(tool.annotations!.idempotentHint, true, `${tool.name} must be idempotentHint:true`);
      }
    }
  });
});
