import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-update-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("updateGuide", () => {
  function seedGuide(): Guide {
    const g: Guide = guides.createGuide("react", "web-frontend", "React library guide");
    return g;
  }

  test("updates guide name (normalized to lowercase)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { guide: "ReactJS" });
    assert.equal(updated!.guide, "reactjs");
  });

  test("updates category (normalized to lowercase)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { category: "WEB-FRONTEND" });
    assert.equal(updated!.category, "web-frontend");
  });

  test("updates description", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { description: "New description" });
    assert.equal(updated!.description, "New description");
  });

  test("adds anti_patterns (appends to existing)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_anti_patterns: ["prop drilling", "nested ternaries"] });
    assert.deepEqual(updated!.anti_patterns, ["prop drilling", "nested ternaries"]);
  });

  test("adds pitfalls (appends to existing)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_pitfalls: ["stale closures"] });
    assert.deepEqual(updated!.known_pitfalls, ["stale closures"]);
  });

  test("sets superseded_by field", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { superseded_by: "nextjs" });
    assert.equal(updated!.superseded_by, "nextjs");
  });

  test("marks guide as deprecated", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { deprecated: true });
    assert.equal(updated!.deprecated, true);
  });

  test("returns null for non-existent guide", () => {
    const gs: Guide[] = [seedGuide()];
    const result: Guide | null = guides.updateGuide(gs, "nonexistent", { description: "x" });
    assert.equal(result, null);
  });

  test("multiple updates accumulate (anti_patterns don't overwrite)", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_anti_patterns: ["first"] });
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_anti_patterns: ["second"] });
    assert.deepEqual(updated!.anti_patterns, ["first", "second"]);
  });

  test("multiple updates accumulate (pitfalls don't overwrite)", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_pitfalls: ["pitfall-a"] });
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_pitfalls: ["pitfall-b"] });
    assert.deepEqual(updated!.known_pitfalls, ["pitfall-a", "pitfall-b"]);
  });

  test("deprecated=false does not change already deprecated guide", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { deprecated: true });
    const updated: Guide | null = guides.updateGuide(gs, "react", { deprecated: false });
    assert.equal(updated!.deprecated, true);
  });

  test("finds guide case-insensitively for update", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "REACT", { description: "found case-insensitive" });
    assert.ok(updated);
    assert.equal(updated!.description, "found case-insensitive");
  });
});

describe("updateGuide — dependency graph (regression: previously dead depends_on/enables)", () => {
  function seedGuide(): Guide {
    return guides.createGuide("react", "web-frontend", "React library guide");
  }

  test("adds depends_on, normalized to lowercase and de-duplicated", () => {
    const gs: Guide[] = [seedGuide()];
    const updated = guides.updateGuide(gs, "react", { add_depends_on: ["JavaScript", "javascript", "  Hooks  "] });
    assert.deepEqual(updated!.depends_on, ["javascript", "hooks"]);
  });

  test("adds enables and drops self-references", () => {
    const gs: Guide[] = [seedGuide()];
    const updated = guides.updateGuide(gs, "react", { add_enables: ["nextjs", "react", "remix"] });
    assert.deepEqual(updated!.enables, ["nextjs", "remix"]);
  });

  test("accumulates across calls without duplicating", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_depends_on: ["javascript"] });
    const updated = guides.updateGuide(gs, "react", { add_depends_on: ["javascript", "jsx"] });
    assert.deepEqual(updated!.depends_on, ["javascript", "jsx"]);
  });

  test("graph edges persist to the DB and reload (the feature is actually wired)", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_depends_on: ["javascript"], add_enables: ["nextjs"] });
    const reloaded = guides.getGuideFromDb("react");
    assert.ok(reloaded, "guide must exist in DB");
    assert.deepEqual(reloaded!.depends_on, ["javascript"]);
    assert.deepEqual(reloaded!.enables, ["nextjs"]);
    // And they render in the detail view.
    const detail = guides.formatGuideDetail(reloaded!);
    assert.ok(detail.includes("Depends on: javascript"));
    assert.ok(detail.includes("Enables: nextjs"));
  });
});
