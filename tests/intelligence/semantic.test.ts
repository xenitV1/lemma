import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildVectors,
  findSemanticSimilar,
  findSemanticSimilarPairs,
} from "../../src/intelligence/semantic.js";
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

describe("buildVectors", () => {
  test("returns vectors with non-zero norms for non-empty text", () => {
    const fragments = [
      makeFragment("m1", "React hooks provide state management in functional components"),
      makeFragment("m2", "Vue composition API offers reactive state management"),
    ];
    const vectors = buildVectors(fragments);
    assert.equal(vectors.length, 2);
    assert.ok(vectors[0].norm > 0);
    assert.ok(vectors[1].norm > 0);
  });

  test("returns empty for empty array", () => {
    const vectors = buildVectors([]);
    assert.equal(vectors.length, 0);
  });
});

describe("findSemanticSimilar", () => {
  test("finds semantically similar documents", () => {
    const fragments = [
      makeFragment("m1", "React hooks provide state management in functional components"),
      makeFragment("m2", "The weather is nice today"),
      makeFragment("m3", "Vue composition API offers reactive state management"),
      makeFragment("m4", "Database indexing improves query performance"),
    ];
    const vectors = buildVectors(fragments);
    const results = findSemanticSimilar("state management functional components", vectors, 3, 0.1);
    assert.ok(results.length > 0);
    const ids = results.map(r => r.memory_id);
    assert.ok(ids.includes("m1"), "Should find React hooks memory");
  });

  test("returns empty for no matches below threshold", () => {
    const fragments = [
      makeFragment("m1", "Quantum computing uses superposition and entanglement"),
      makeFragment("m2", "The recipe requires flour sugar and eggs"),
    ];
    const vectors = buildVectors(fragments);
    const results = findSemanticSimilar("database migration strategies", vectors, 5, 0.5);
    assert.equal(results.length, 0);
  });

  test("respects topK limit", () => {
    const fragments = Array.from({ length: 20 }, (_, i) =>
      makeFragment(`m${i}`, `JavaScript error handling pattern number ${i}`)
    );
    const vectors = buildVectors(fragments);
    const results = findSemanticSimilar("JavaScript error handling", vectors, 5);
    assert.ok(results.length <= 5);
  });

  test("scores are between 0 and 1", () => {
    const fragments = [
      makeFragment("m1", "Use TypeScript for type-safe code"),
      makeFragment("m2", "TypeScript provides compile-time type checking"),
    ];
    const vectors = buildVectors(fragments);
    const results = findSemanticSimilar("TypeScript type safety", vectors, 5);
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1);
    }
  });
});

describe("findSemanticSimilarPairs", () => {
  test("finds similar pairs in collection", () => {
    const fragments = [
      makeFragment("m1", "Use useCallback to memoize functions in React"),
      makeFragment("m2", "useCallback hook memoizes callback functions in React"),
      makeFragment("m3", "PostgreSQL supports window functions for analytics"),
    ];
    const vectors = buildVectors(fragments);
    const pairs = findSemanticSimilarPairs(vectors, 0.3);
    const m1m2 = pairs.find(p =>
      (p.id_a === "m1" && p.id_b === "m2") ||
      (p.id_a === "m2" && p.id_b === "m1")
    );
    assert.ok(m1m2, "Should find m1-m2 as similar pair");
    assert.ok(m1m2.score > 0);
  });

  test("returns empty for dissimilar collection", () => {
    const fragments = [
      makeFragment("m1", "Quantum mechanics describes subatomic particles"),
      makeFragment("m2", "Baking bread requires yeast and warm water"),
      makeFragment("m3", "The stock market closed higher today"),
    ];
    const vectors = buildVectors(fragments);
    const pairs = findSemanticSimilarPairs(vectors, 0.5);
    assert.equal(pairs.length, 0);
  });

  test("respects maxResults limit", () => {
    const fragments = Array.from({ length: 10 }, (_, i) =>
      makeFragment(`m${i}`, `React component pattern ${i} uses state management`)
    );
    const vectors = buildVectors(fragments);
    const pairs = findSemanticSimilarPairs(vectors, 0.2, 3);
    assert.ok(pairs.length <= 3);
  });
});

describe("query/corpus IDF consistency (regression: negative-weight bug)", () => {
  test("a document sharing the query's terms scores positively, not negative", () => {
    // 'config' appears in many docs (high df). The old code weighted the query
    // with n=1 while the corpus used n=N, flipping common-term weights negative
    // so term-sharing docs got NEGATIVE cosine similarity. They must be positive.
    const corpus = Array.from({ length: 6 }, (_, i) =>
      makeFragment(`c${i}`, `config option config value setting number ${i}`)
    );
    corpus.push(makeFragment("k", "kafka broker consumer producer partition offset"));
    const vectors = buildVectors(corpus);
    const results = findSemanticSimilar("config value", vectors, 10, -999);
    const sharing = results.filter(r => r.memory_id.startsWith("c"));
    assert.ok(sharing.length > 0, "docs sharing query terms should be returned");
    for (const r of sharing) {
      assert.ok(r.score > 0, `term-sharing doc ${r.memory_id} must score > 0, got ${r.score}`);
    }
  });
});
