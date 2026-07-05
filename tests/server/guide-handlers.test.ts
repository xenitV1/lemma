import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";
import { closeDb } from "../../src/db/index.js";
import type { Guide } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-"));
  closeDb();
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  closeDb();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedGuide(name: string, category: string, description?: string, usageCount?: number): Guide {
  const allGuides = guides.loadGuides();
  const g = guides.createGuide(name, category, description || "desc");
  if (usageCount) g.usage_count = usageCount;
  allGuides.push(g);
  guides.saveGuides(allGuides);
  return g;
}

describe("handleGuideUpdate", () => {
  test("updates guide name", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      new_name: "react-hooks",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("react-hooks"));

    const loaded = guides.loadGuides();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].guide, "react-hooks");
  });

  test("adds anti_patterns", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      add_anti_patterns: ["prop drilling", "god components"],
    });
    assert.ok(!result.isError);

    const loaded = guides.loadGuides();
    assert.deepEqual(loaded[0].anti_patterns, ["prop drilling", "god components"]);
  });

  test("adds pitfalls", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      add_pitfalls: ["stale closures", "infinite re-renders"],
    });
    assert.ok(!result.isError);

    const loaded = guides.loadGuides();
    assert.deepEqual(loaded[0].known_pitfalls, ["stale closures", "infinite re-renders"]);
  });

  test("marks guide as deprecated", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      deprecated: true,
    });
    assert.ok(!result.isError);

    const loaded = guides.loadGuides();
    assert.equal(loaded[0].deprecated, true);
  });

  test("sets superseded_by", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      superseded_by: "react-19",
    });
    assert.ok(!result.isError);

    const loaded = guides.loadGuides();
    assert.equal(loaded[0].superseded_by, "react-19");
  });

  test("populates the dependency graph (depends_on / enables) end-to-end", async () => {
    seedGuide("react", "web-frontend", "React guide");

    const result = await handlers.handleGuideUpdate({
      guide: "react",
      add_depends_on: ["JavaScript", "react"], // mixed case + self-ref
      add_enables: ["nextjs"],
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Depends on: javascript"));
    assert.ok(result.content[0].text.includes("Enables: nextjs"));

    const loaded = guides.loadGuides();
    assert.deepEqual(loaded[0].depends_on, ["javascript"], "normalized + self-ref dropped");
    assert.deepEqual(loaded[0].enables, ["nextjs"]);
  });

  test("returns error for non-existent guide", async () => {
    const result = await handlers.handleGuideUpdate({
      guide: "nonexistent",
      description: "new desc",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });
});

describe("handleGuideMerge", () => {
  test("merges two guides into one", async () => {
    seedGuide("react-hooks", "web-frontend", "Hooks guide");
    seedGuide("react-state", "web-frontend", "State guide");

    const result = await handlers.handleGuideMerge({
      guides: ["react-hooks", "react-state"],
      guide: "react-complete",
      category: "web-frontend",
      description: "Complete React guide",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Merged 2"));

    const loaded = guides.loadGuides();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].guide, "react-complete");
  });

  test("sums usage counts", async () => {
    seedGuide("react-hooks", "web-frontend", "Hooks", 5);
    seedGuide("react-state", "web-frontend", "State", 3);

    const result = await handlers.handleGuideMerge({
      guides: ["react-hooks", "react-state"],
      guide: "react-complete",
      category: "web-frontend",
    });
    assert.ok(!result.isError);

    const loaded = guides.loadGuides();
    assert.equal(loaded[0].usage_count, 8);
  });

  test("removes original guides after merge", async () => {
    seedGuide("a", "dev-tool", "Guide A");
    seedGuide("b", "dev-tool", "Guide B");
    seedGuide("c", "dev-tool", "Unrelated");

    await handlers.handleGuideMerge({
      guides: ["a", "b"],
      guide: "merged-ab",
      category: "dev-tool",
    });

    const loaded = guides.loadGuides();
    assert.equal(loaded.length, 2);
    const names = loaded.map((g: Guide) => g.guide);
    assert.ok(!names.includes("a"));
    assert.ok(!names.includes("b"));
    assert.ok(names.includes("c"));
    assert.ok(names.includes("merged-ab"));
  });

  test("returns error when guides not found", async () => {
    const result = await handlers.handleGuideMerge({
      guides: ["nonexistent1", "nonexistent2"],
      guide: "merged",
      category: "dev-tool",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });
});

describe("handleGuideGet", () => {
  test("returns list sorted by usage", async () => {
    seedGuide("low", "dev-tool", "Low usage", 2);
    seedGuide("high", "dev-tool", "High usage", 10);
    seedGuide("mid", "dev-tool", "Mid usage", 5);

    const result = await handlers.handleGuideGet({});
    assert.ok(!result.isError);
    const text = result.content[0].text;
    const highPos = text.indexOf("high");
    const midPos = text.indexOf("mid");
    const lowPos = text.indexOf("low");
    assert.ok(highPos < midPos, "high usage guide should appear before mid");
    assert.ok(midPos < lowPos, "mid usage guide should appear before low");
  });

  test("returns detail for specific guide name", async () => {
    seedGuide("react", "web-frontend", "React guide with details");

    const result = await handlers.handleGuideGet({ guide: "react" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("react"));
    assert.deepEqual(Object.keys(result.structuredContent as Record<string, unknown>).sort(), ["count", "guide", "guides"].sort());
    assert.equal((result.structuredContent as any).count, 1);
    assert.equal((result.structuredContent as any).guides.length, 1);
    assert.equal((result.structuredContent as any).guide.guide, "react");
  });

  test("returns suggestions when task parameter given", async () => {
    seedGuide("react-hooks", "web-frontend", "React hooks guide", 5);

    const result = await handlers.handleGuideGet({ task: "react component with hooks" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.length > 0);
    assert.deepEqual(Object.keys(result.structuredContent as Record<string, unknown>).sort(), ["count", "guide", "guides"].sort());
    assert.equal((result.structuredContent as any).guide, null);
  });

  test("returns empty state when no guides", async () => {
    const result = await handlers.handleGuideGet({});
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("no guides tracked"));
  });
});
