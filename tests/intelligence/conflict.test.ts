import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectConflict, scanForConflicts, formatConflictResults } from "../../src/intelligence/conflict.js";
import type { MemoryFragment } from "../../src/types.js";

function makeFragment(id: string, text: string, title?: string): MemoryFragment {
  return {
    id,
    title: title || text.slice(0, 30),
    description: "",
    fragment: text,
    project: null,
    confidence: 0.8,
    source: "ai",
    created: "2026-04-15",
    lastAccessed: "",
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
  };
}

describe("detectConflict", () => {
  test("returns empty for unrelated memories", () => {
    const existing = makeFragment("m1", "React components use JSX syntax for templating");
    const newFrag = makeFragment("m2", "PostgreSQL supports JSONB columns for storing documents");
    const result = detectConflict(newFrag, [existing]);
    assert.equal(result.length, 0);
  });

  test("detects negation conflict on same topic", () => {
    const existing = makeFragment("m1", "Always use try-catch for error handling in async code");
    const newFrag = makeFragment("m2", "Never use try-catch for error handling in async code");
    const result = detectConflict(newFrag, [existing]);
    assert.ok(result.length > 0, "Should detect conflict");
    assert.ok(result[0].overlap_score >= 0.4);
    assert.equal(result[0].memory_a_id, "m2");
    assert.equal(result[0].memory_b_id, "m1");
  });

  test("detects good vs bad on same topic", () => {
    const existing = makeFragment("m1", "Using global state is a good pattern for shared config");
    const newFrag = makeFragment("m2", "Using global state is a bad pattern for shared config");
    const result = detectConflict(newFrag, [existing]);
    assert.ok(result.length > 0);
  });

  test("detects deprecated vs recommended", () => {
    const existing = makeFragment("m1", "The recommended approach is to use async/await for error handling");
    const newFrag = makeFragment("m2", "Avoid using async/await for error handling, use promises instead");
    const result = detectConflict(newFrag, [existing]);
    assert.ok(result.length > 0);
  });

  test("returns topN conflicts sorted by score", () => {
    const existing = [
      makeFragment("m1", "Always use REST APIs for server communication"),
      makeFragment("m2", "Never use REST APIs for server communication"),
      makeFragment("m3", "Always use GraphQL for server communication"),
    ];
    const newFrag = makeFragment("m4", "Never use GraphQL for server communication");
    const result = detectConflict(newFrag, existing, 2);
    assert.ok(result.length <= 2);
    if (result.length > 1) {
      assert.ok(result[0].overlap_score >= result[1].overlap_score);
    }
  });

  test("skips self comparison", () => {
    const frag = makeFragment("m1", "Always use tests");
    const result = detectConflict(frag, [frag]);
    assert.equal(result.length, 0);
  });

  test("does not misclassify advisory/warning fragments as contradicting a fact", () => {
    // Regression: advisory words (avoid/pitfall/mistake/...) were previously
    // treated as negation, so a `warning` on the same topic as a `fact` was
    // wrongly flagged as `contradicts`.
    const fact = makeFragment(
      "f1",
      "Using eval in JavaScript executes arbitrary code from a string",
      "eval executes code"
    );
    const warning = makeFragment(
      "w1",
      "Avoid using eval in JavaScript — it is a security pitfall that runs arbitrary code",
      "avoid eval pitfall"
    );
    warning.type = "warning";
    const result = detectConflict(warning, [fact]);
    assert.equal(result.length, 0, "advisory/warning must not contradict a fact on the same topic");
  });
});

describe("scanForConflicts", () => {
  test("returns empty for non-contradicting memories", () => {
    const fragments = [
      makeFragment("m1", "React uses virtual DOM"),
      makeFragment("m2", "Vue uses template syntax"),
      makeFragment("m3", "Angular uses TypeScript decorators"),
    ];
    const result = scanForConflicts(fragments);
    assert.equal(result.length, 0);
  });

  test("finds contradicting pairs in full scan", () => {
    const fragments = [
      makeFragment("m1", "Always use try-catch for error handling in Node.js"),
      makeFragment("m2", "Never use try-catch for error handling in Node.js"),
      makeFragment("m3", "Use composition over inheritance in OOP design"),
    ];
    const result = scanForConflicts(fragments);
    assert.ok(result.length > 0);
    const pair = result.find(c =>
      (c.memory_a_id === "m1" && c.memory_b_id === "m2") ||
      (c.memory_a_id === "m2" && c.memory_b_id === "m1")
    );
    assert.ok(pair, "Should find the m1-m2 conflict");
  });

  test("returns results sorted by overlap score", () => {
    const fragments = [
      makeFragment("m1", "Always use MongoDB for storing JSON data"),
      makeFragment("m2", "Never use MongoDB for storing JSON data"),
      makeFragment("m3", "Always prefer PostgreSQL for relational data"),
      makeFragment("m4", "Avoid PostgreSQL for relational data"),
    ];
    const result = scanForConflicts(fragments);
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i - 1].overlap_score >= result[i].overlap_score);
    }
  });
});

describe("formatConflictResults", () => {
  test("returns no conflicts message for empty array", () => {
    const result = formatConflictResults([]);
    assert.ok(result.includes("No conflicts detected"));
  });

  test("formats conflict pairs with details", () => {
    const conflicts = [{
      memory_a_id: "m1",
      memory_a_title: "Test A",
      memory_b_id: "m2",
      memory_b_title: "Test B",
      reason: "Opposing sentiment",
      overlap_score: 0.85,
    }];
    const result = formatConflictResults(conflicts);
    assert.ok(result.includes("m1"));
    assert.ok(result.includes("m2"));
    assert.ok(result.includes("0.85"));
    assert.ok(result.includes("contradicts"));
  });
});

describe("scoring parity: incremental and batch paths agree (regression)", () => {
  test("detectConflict and scanForConflicts report the same severity for a pair", () => {
    // Negation-parity differs, high topic overlap, NO antonym signal word — so the
    // (formerly divergent) negation formula alone decides the score. The two paths
    // must now agree; before unification they returned 0.80 vs 0.75.
    const a = makeFragment("a", "we use redis caching for session storage");
    const b = makeFragment("b", "we do not use redis caching for session storage");
    const inc = detectConflict(b, [a]);
    const bat = scanForConflicts([a, b]);
    assert.equal(inc.length, 1, "incremental path must flag the pair");
    assert.equal(bat.length, 1, "batch path must flag the pair");
    assert.equal(inc[0].overlap_score, bat[0].overlap_score,
      "both paths must report identical conflict severity");
  });
});
