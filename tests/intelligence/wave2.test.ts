import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveConflict, scanForConflicts } from "../../src/intelligence/conflict.js";
import { TOOL_NUDGES } from "../../src/server/prompt-content.js";
import type { MemoryFragment } from "../../src/types.js";

function frag(overrides: Partial<MemoryFragment> = {}): MemoryFragment {
  return {
    id: "m" + Math.random().toString(36).slice(2, 10),
    title: "t",
    description: "",
    fragment: "content",
    project: null,
    confidence: 0.6,
    source: "ai",
    created: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    accessed: 0,
    tags: [],
    associatedWith: [],
    relations: [],
    negativeHits: 0,
    quality_score: null,
    refinement_count: 0,
    parent_id: null,
    child_ids: [],
    session_id: null,
    task_type: null,
    outcome: null,
    positive_feedback: 0,
    negative_feedback: 0,
    last_refined: null,
    type: "fact",
    related_guides: [],
    ...overrides,
  };
}

describe("B4 — resolveConflict win-heuristic", () => {
  test("higher confidence + recency wins", () => {
    const strong = frag({ id: "mStrong", confidence: 0.95, created: new Date().toISOString() });
    const weak = frag({ id: "mWeak", confidence: 0.3, created: "2020-01-01T00:00:00.000Z" });
    const res = resolveConflict(strong, weak);
    assert.equal(res.winner_id, "mStrong");
    assert.equal(res.loser_id, "mWeak");
    assert.ok(res.winner_score >= res.loser_score);
    assert.match(res.rationale, /recency/);
  });

  test("support relations tip the balance", () => {
    const supported = frag({
      id: "mSupported",
      confidence: 0.6,
      relations: [
        { id: "x", type: "supports", created: "2026-01-01" },
        { id: "y", type: "supports", created: "2026-01-01" },
        { id: "z", type: "supports", created: "2026-01-01" },
      ],
    });
    const bare = frag({ id: "mBare", confidence: 0.6 });
    assert.equal(resolveConflict(supported, bare).winner_id, "mSupported");
  });
});

describe("C3 — two-tier scanForConflicts still finds conflicts", () => {
  test("opposing sentiment on shared topic is detected", () => {
    const a = frag({ id: "mA", title: "tabs", fragment: "Always use tabs for indentation in this codebase." });
    const b = frag({ id: "mB", title: "tabs2", fragment: "Never use tabs for indentation in this codebase." });
    const noise = frag({ id: "mC", fragment: "The deploy pipeline runs on Friday afternoons." });
    const conflicts = scanForConflicts([a, b, noise]);
    assert.ok(conflicts.length >= 1, "should detect the tabs contradiction");
    const pair = conflicts.find(
      c => (c.memory_a_id === "mA" && c.memory_b_id === "mB") || (c.memory_a_id === "mB" && c.memory_b_id === "mA"),
    );
    assert.ok(pair, "the tabs pair must be flagged");
  });

  test("fragments sharing no topic terms produce no conflict", () => {
    const a = frag({ fragment: "Postgres connection pooling uses pgbouncer." });
    const b = frag({ fragment: "The mascot logo is a friendly otter." });
    assert.equal(scanForConflicts([a, b]).length, 0);
  });
});

describe("D2/D3 — tool nudges", () => {
  test("memory_add nudge carries the quality gate + habituation", () => {
    assert.match(TOOL_NUDGES.memory_add, /Save new knowledge IMMEDIATELY/); // preserved trigger
    assert.match(TOOL_NUDGES.memory_add, /durable/i);
    assert.match(TOOL_NUDGES.memory_add, /once you'?ve saved/i);
  });

  test("gap-filling nudges exist and mention non-destructive consolidation", () => {
    assert.ok(TOOL_NUDGES.memory_forget && /consolidate/.test(TOOL_NUDGES.memory_forget));
    assert.ok(TOOL_NUDGES.memory_merge && /consolidate/.test(TOOL_NUDGES.memory_merge));
    assert.ok(TOOL_NUDGES.memory_relate);
    assert.ok(TOOL_NUDGES.conflict_scan);
    assert.ok(TOOL_NUDGES.proactive_analysis);
    assert.ok(TOOL_NUDGES.semantic_search);
  });
});
