import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calculateQualityScore,
  qualityScoreReasons,
  isLowQuality,
  QUALITY_SUGGESTION_THRESHOLD,
} from "../../src/intelligence/scoring.js";
import type { MemoryFragment } from "../../src/types.js";

function makeFragment(overrides: Partial<MemoryFragment> = {}): MemoryFragment {
  return {
    id: "m1",
    title: "Test fragment",
    description: "",
    fragment: "some content",
    project: null,
    confidence: 0.8,
    source: "ai",
    created: "2026-04-15",
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

describe("calculateQualityScore", () => {
  test("returns a value in [0,1]", () => {
    const score = calculateQualityScore(makeFragment());
    assert.ok(score >= 0 && score <= 1, `score ${score} out of range`);
  });

  test("a pristine, corroborated, reused fragment scores high", () => {
    const strong = makeFragment({
      confidence: 1.0,
      positive_feedback: 5,
      negative_feedback: 0,
      accessed: 12,
      refinement_count: 3,
      lastAccessed: new Date().toISOString(),
    });
    assert.ok(calculateQualityScore(strong) > 0.85, "strong fragment should score > 0.85");
  });

  test("a rejected, negatively-hit fragment scores low", () => {
    const weak = makeFragment({
      confidence: 0.3,
      positive_feedback: 0,
      negative_feedback: 4,
      negativeHits: 5,
      accessed: 4,
    });
    assert.ok(calculateQualityScore(weak) < QUALITY_SUGGESTION_THRESHOLD, "weak fragment should be below threshold");
  });

  test("no feedback is neutral, not punitive", () => {
    const silent = makeFragment({ confidence: 0.8 });
    const negative = makeFragment({ confidence: 0.8, negative_feedback: 3 });
    assert.ok(
      calculateQualityScore(silent) > calculateQualityScore(negative),
      "silence should score higher than negative feedback",
    );
  });

  test("staleness lowers the score", () => {
    const fresh = makeFragment({ lastAccessed: new Date().toISOString() });
    const stale = makeFragment({ lastAccessed: "2020-01-01T00:00:00.000Z" });
    assert.ok(calculateQualityScore(fresh) > calculateQualityScore(stale), "fresh should beat stale");
  });

  test("handles a malformed lastAccessed without NaN", () => {
    const score = calculateQualityScore(makeFragment({ lastAccessed: "not-a-date" }));
    assert.ok(!Number.isNaN(score) && score >= 0 && score <= 1);
  });
});

describe("qualityScoreReasons", () => {
  test("a brand-new fragment has no reasons (never punished for silence)", () => {
    assert.deepEqual(qualityScoreReasons(makeFragment()), []);
  });

  test("cites negative feedback with exact counts", () => {
    const reasons = qualityScoreReasons(makeFragment({ positive_feedback: 1, negative_feedback: 3 }));
    assert.ok(reasons.some(r => r.includes("3 negative") && r.includes("1 positive")));
  });

  test("cites negative recall hits", () => {
    const reasons = qualityScoreReasons(makeFragment({ negativeHits: 2 }));
    assert.ok(reasons.some(r => r.includes("2 negative recall hits")));
  });

  test("cites reused-but-unconvincing fragments", () => {
    const reasons = qualityScoreReasons(makeFragment({ accessed: 4, confidence: 0.3 }));
    assert.ok(reasons.some(r => r.includes("accessed 4×")));
  });
});

describe("isLowQuality", () => {
  test("false for a healthy fragment", () => {
    assert.equal(isLowQuality(makeFragment({ confidence: 0.9, positive_feedback: 3 })), false);
  });

  test("false for a fresh low-confidence fragment with no track record", () => {
    // Low score alone must NOT flag it — no reasons yet.
    assert.equal(isLowQuality(makeFragment({ confidence: 0.3 })), false);
  });

  test("true for an established, weak fragment", () => {
    const weak = makeFragment({
      confidence: 0.3,
      negative_feedback: 4,
      positive_feedback: 0,
      negativeHits: 3,
      accessed: 4,
    });
    assert.equal(isLowQuality(weak), true);
  });
});
