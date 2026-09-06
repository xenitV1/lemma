import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchAndSortFragments, createFragment } from "../../src/memory/core.js";

function makeFragment(overrides: { created?: string; confidence?: number; fragment?: string }): any {
  const frag = createFragment(overrides.fragment || "Test fragment", "ai");
  return { ...frag, ...overrides };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("Injection ranking (confidence x recency)", () => {
  it("prioritizes recent high-confidence over old high-confidence", async () => {
    const fragments = [
      makeFragment({ confidence: 0.95, created: daysAgo(199), fragment: "Old git workflow knowledge" }),
      makeFragment({ confidence: 0.85, created: daysAgo(3), fragment: "Recent React patterns" }),
    ];

    const results = await searchAndSortFragments(fragments, null, 10);
    assert.ok(results.length >= 2);
    assert.ok(results[0].fragment.includes("Recent"), `Expected recent first, got: ${results[0].fragment}`);
  });

  it("still surfaces very high confidence even if older", async () => {
    const fragments = [
      makeFragment({ confidence: 0.35, created: daysAgo(0), fragment: "Low confidence recent" }),
      makeFragment({ confidence: 0.95, created: daysAgo(48), fragment: "High confidence semi-recent" }),
    ];

    const results = await searchAndSortFragments(fragments, null, 10);
    assert.ok(results.length >= 2);
    assert.ok(results[0].fragment.includes("High confidence"), `Expected high confidence first, got: ${results[0].fragment}`);
  });

  it("ranks by query relevance first, then by injection score", async () => {
    const fragments = [
      makeFragment({ confidence: 0.9, created: daysAgo(107), fragment: "Git rebase workflow tutorial" }),
      makeFragment({ confidence: 0.7, created: daysAgo(0), fragment: "React hooks state management" }),
      makeFragment({ confidence: 0.8, created: daysAgo(1), fragment: "React component lifecycle" }),
    ];

    const results = await searchAndSortFragments(fragments, "React hooks", 10);
    assert.ok(results.length >= 1);
    assert.ok(results[0].fragment.includes("React"), "Query-relevant results should come first");
  });

  it("returns all fragments when no query", async () => {
    const fragments = [
      makeFragment({ confidence: 0.5, created: daysAgo(0), fragment: "Fragment A" }),
      makeFragment({ confidence: 0.8, created: daysAgo(107), fragment: "Fragment B" }),
      makeFragment({ confidence: 0.3, created: daysAgo(1), fragment: "Fragment C" }),
    ];

    const results = await searchAndSortFragments(fragments, null, 10);
    assert.equal(results.length, 3);
  });

  it("respects topK limit", async () => {
    const fragments = [];
    for (let i = 0; i < 20; i++) {
      fragments.push(makeFragment({ confidence: 0.5, created: "2026-04-18", fragment: `Fragment ${i}` }));
    }

    const results = await searchAndSortFragments(fragments, null, 5);
    assert.equal(results.length, 5);
  });
});
