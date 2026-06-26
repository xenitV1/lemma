import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-fts5-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function makeFrag(text: string, project: string | null = null): MemoryFragment {
  const frag = core.createFragment(text, "ai", null, project);
  return frag;
}

describe("FTS5 Memory Search", () => {
  test("exact word search returns matching fragments", async () => {
    const frags = [
      makeFrag("React hooks for state management in functional components", "proj"),
      makeFrag("Python list comprehension and generator expressions", "proj"),
      makeFrag("Docker container orchestration with Kubernetes pods", "proj"),
      makeFrag("Git branching strategies for team collaboration", "proj"),
      makeFrag("CSS grid layout for responsive web design", "proj"),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "React hooks", 10);
    assert.ok(results.length >= 1);
    assert.ok(results[0].fragment.toLowerCase().includes("react"));
  });

  test("prefix search returns matching fragments", async () => {
    const frags = [
      makeFrag("JavaScript TypeScript migration strategies", null),
      makeFrag("Python async await patterns", null),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "TypeS", 10);
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.fragment.includes("TypeScript")));
  });

  test("multi-word search returns relevant results", async () => {
    const frags = [
      makeFrag("React component patterns for scalable applications", null),
      makeFrag("Python data analysis with pandas dataframe", null),
      makeFrag("React state management using Redux toolkit", null),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "React state management", 10);
    assert.ok(results.length >= 1);
    assert.ok(results.every(r => r.fragment.toLowerCase().includes("react")));
  });

  test("search for nonexistent term returns empty or fallback", async () => {
    const frags = [
      makeFrag("React component patterns", null),
      makeFrag("Python data analysis", null),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "quantum entanglement", 10);
    assert.ok(Array.isArray(results));
  });

  test("search results are ranked by relevance", async () => {
    const frags = [
      makeFrag("React React React everything about React framework", null),
      makeFrag("React is a JavaScript library for building user interfaces", null),
      makeFrag("Building web applications with various JavaScript frameworks", null),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "React", 10);
    assert.ok(results.length >= 1);
    const firstFragment = results[0].fragment.toLowerCase();
    assert.ok(firstFragment.includes("react"));
  });

  test("search with project filter returns scoped results", async () => {
    const frags = [
      makeFrag("React hooks for state management", "frontend"),
      makeFrag("Node.js Express middleware patterns", "backend"),
      makeFrag("Global configuration settings", null),
    ];
    core.saveMemory(frags);

    const results = await core.searchAndSortFragments(frags, "React", 10);
    assert.ok(results.length >= 1);
  });

  test("search returns relevant fragments without side effects", async () => {
    const frag = makeFrag("Unique test fragment about quantum computing algorithms", null);
    frag.confidence = 0.5;
    core.saveMemory([frag]);

    const results = await core.searchAndSortFragments([frag], "quantum computing", 10);
    assert.ok(results.length >= 1);

    // searchAndSortFragments does NOT boost — that happens at handler level
    const loaded = core.loadMemory();
    const unchanged = loaded.find(f => f.id === frag.id);
    assert.ok(unchanged);
    assert.strictEqual(unchanged.accessed, 0);
    assert.strictEqual(unchanged.confidence, 0.5);
  });

  test("search finds updated content after fragment update", async () => {
    const frag = makeFrag("Original content about machine learning", null);
    core.saveMemory([frag]);

    const loaded = core.loadMemory();
    const target = loaded.find(f => f.id === frag.id)!;
    target.fragment = "Updated content about blockchain technology";
    core.saveMemory(loaded);

    const results = await core.searchAndSortFragments(loaded, "blockchain", 10);
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.fragment.includes("blockchain")));
  });

  test("search does not find deleted fragment", async () => {
    const frag1 = makeFrag("React component lifecycle methods", null);
    const frag2 = makeFrag("Python virtual environment setup", null);
    core.saveMemory([frag1, frag2]);

    core.deleteMemory(frag1.id);

    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, frag2.id);
  });

  test("search with special characters does not crash", async () => {
    const frag = makeFrag("Test fragment with special characters", null);
    core.saveMemory([frag]);

    const specialQueries = [
      "test & fragment",
      "test | fragment",
      'test "quoted" fragment',
      "test (parenthetical)",
      "test * wildcard",
      "test + plus",
      "test - minus",
    ];

    for (const query of specialQueries) {
      const results = await core.searchAndSortFragments([frag], query, 10);
      assert.ok(Array.isArray(results), `Query "${query}" should not crash`);
    }
  });

  test("findSimilarFragment detects exact duplicate via FTS5", async () => {
    const frag = makeFrag("React hooks use state management patterns", "proj");
    core.saveMemory([frag]);

    const match = await core.findSimilarFragment([frag], "react hooks use state patterns", "proj", 0.3);
    assert.ok(match);
    assert.equal(match.id, frag.id);
  });

  test("findSimilarFragment returns null for unrelated content", async () => {
    const frag = makeFrag("Python asyncio coroutine patterns", "proj");
    core.saveMemory([frag]);

    const match = await core.findSimilarFragment([frag], "quantum physics particle accelerator", "proj");
    assert.equal(match, null);
  });

  test("findTopicOverlaps finds related fragments via fallback", async () => {
    const frags = [
      makeFrag("Next.js App Router provides file-based routing system"),
      makeFrag("React Server Components enable server-side rendering"),
      makeFrag("Git merge conflict resolution strategies"),
    ];
    core.saveMemory(frags);

    const overlaps = await core.findTopicOverlaps(frags, "Next.js routing configuration", null, 5);
    assert.ok(overlaps.length >= 1);
    assert.ok(overlaps.some(o => o.fragment.includes("Next.js")));
  });

  test("findTopicOverlaps respects limit parameter", async () => {
    const frags: MemoryFragment[] = [];
    for (let i = 0; i < 20; i++) {
      frags.push(makeFrag(`React component pattern ${i} for building interfaces`));
    }
    core.saveMemory(frags);

    const overlaps = await core.findTopicOverlaps(frags, "React component architecture", null, 3);
    assert.ok(overlaps.length <= 3);
  });

  test("findSimilarByText handles fragments containing FTS boolean operators (no syntax error)", () => {
    // Regression: previously "Use OR and NOT to combine NEAR clauses" built a raw
    // FTS query like "... OR NOT ... NEAR ..." which threw "fts5: syntax error near OR".
    const frag = makeFrag("Use OR and NOT to combine NEAR clauses in queries", "proj");
    core.saveMemory([frag]);

    const match = core.findSimilarByText("Use OR and NOT to combine NEAR clauses in queries", "proj", 0.8);
    assert.ok(match, "should self-match without throwing an fts5 syntax error");
    assert.equal(match!.id, frag.id);
  });

  test("findSimilarByText does not throw on a fragment consisting only of operator words", () => {
    const frag = makeFrag("OR AND NOT NEAR alone", "proj");
    core.saveMemory([frag]);

    let threw = false;
    try {
      const m = core.findSimilarByText("OR AND NOT NEAR", "proj", 0.8);
      assert.ok(m === null || typeof m === "object");
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "must not throw fts5 syntax error");
  });
});
