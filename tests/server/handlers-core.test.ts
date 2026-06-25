import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";
import * as hooks from "../../src/server/hooks.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedMemory(): MemoryFragment {
  const frags = [core.createFragment("react hooks pattern", "ai", "React Hooks", "testproj")];
  core.saveMemory(frags);
  return frags[0];
}

describe("Handlers (Integration)", () => {
  describe("handleMemoryRead", () => {
    test("returns summary list", async () => {
      seedMemory();
      const result = await handlers.handleMemoryRead({ project: "testproj" });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Memory Fragments"));
    });

    test("returns detail by ID with boost", async () => {
      const frag = seedMemory();
      const result = await handlers.handleMemoryRead({ id: frag.id, context: "debugging" });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("CONTENT"));

      const loaded: MemoryFragment[] = core.loadMemory();
      const updated = loaded.find((f: MemoryFragment) => f.id === frag.id)!;
      assert.ok(updated.tags.includes("debugging"));
      assert.ok(updated.confidence >= 1.0);
      assert.ok(updated.accessed >= 1);
    });

    test("returns error for unknown ID", async () => {
      const result = await handlers.handleMemoryRead({ id: "nonexistent" });
      assert.equal(result.isError, true);
    });
  });

  describe("handleMemoryAdd", () => {
    test("adds a new fragment", async () => {
      seedMemory();
      const result = await handlers.handleMemoryAdd({
        fragment: "new knowledge",
        title: "New",
        project: "testproj",
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Added"));

      const loaded: MemoryFragment[] = core.loadMemory();
      assert.equal(loaded.length, 2);
    });

    test("rejects duplicate (similar) fragments", async () => {
      seedMemory();
      const result = await handlers.handleMemoryAdd({
        fragment: "react hooks pattern",
        project: "testproj",
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("similar"));
    });

    test("requires fragment parameter", async () => {
      const result = await handlers.handleMemoryAdd({});
      assert.equal(result.isError, true);
    });
  });

  describe("handleMemoryUpdate", () => {
    test("updates title", async () => {
      const frag = seedMemory();
      const result = await handlers.handleMemoryUpdate({
        id: frag.id,
        title: "Updated Title",
      });
      assert.ok(!result.isError);
      const loaded = core.loadMemory().find((f: MemoryFragment) => f.id === frag.id)!;
      assert.equal(loaded.title, "Updated Title");
    });

    test("returns error for unknown ID", async () => {
      const result = await handlers.handleMemoryUpdate({ id: "nope" });
      assert.equal(result.isError, true);
    });
  });

  describe("handleMemoryForget", () => {
    test("removes a fragment", async () => {
      const frag = seedMemory();
      const result = await handlers.handleMemoryForget({ id: frag.id });
      assert.ok(!result.isError);
      assert.equal(core.loadMemory().length, 0);
    });

    test("returns error for unknown ID", async () => {
      const result = await handlers.handleMemoryForget({ id: "nope" });
      assert.equal(result.isError, true);
    });
  });

  describe("handleMemoryFeedback", () => {
    test("positive feedback boosts confidence", async () => {
      const frag: MemoryFragment = { ...seedMemory(), confidence: 0.5 };
      core.saveMemory([frag]);

      const result = await handlers.handleMemoryFeedback({
        id: frag.id,
        useful: true,
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Positive"));

      const loaded = core.loadMemory().find((f: MemoryFragment) => f.id === frag.id)!;
      assert.ok(Math.abs(loaded.confidence - 0.515) < 0.001);
    });

    test("negative feedback reduces confidence", async () => {
      const frag: MemoryFragment = { ...seedMemory(), confidence: 0.8 };
      core.saveMemory([frag]);

      const result = await handlers.handleMemoryFeedback({
        id: frag.id,
        useful: false,
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Negative"));

      const loaded = core.loadMemory().find((f: MemoryFragment) => f.id === frag.id)!;
      assert.ok(Math.abs(loaded.confidence - 0.78) < 0.001);
      assert.equal(loaded.negativeHits, 1);
    });

    test("returns error for unknown ID", async () => {
      const result = await handlers.handleMemoryFeedback({ id: "nope", useful: true });
      assert.equal(result.isError, true);
    });

    test("returns error when useful is missing", async () => {
      const frag = seedMemory();
      const result = await handlers.handleMemoryFeedback({ id: frag.id });
      assert.equal(result.isError, true);
    });
  });

  describe("handleMemoryMerge", () => {
    test("merges two fragments", async () => {
      const f1 = core.createFragment("aaa", "ai", "A", "testproj");
      const f2 = core.createFragment("bbb", "ai", "B", "testproj");
      core.saveMemory([f1, f2]);

      const result = await handlers.handleMemoryMerge({
        ids: [f1.id, f2.id],
        title: "Merged",
        fragment: "aaa and bbb combined",
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Merged 2"));

      const loaded: MemoryFragment[] = core.loadMemory();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].title, "Merged");
      assert.equal(loaded[0].fragment, "aaa and bbb combined");
    });
  });

  describe("handleGuidePractice", () => {
    test("records guide usage", async () => {
      const result = await handlers.handleGuidePractice({
        guide: "react",
        category: "web-frontend",
        contexts: ["hooks"],
        learnings: ["useCallback prevents re-renders"],
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Created"));

      const loaded = guides.loadGuides();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].usage_count, 1);
    });

    test("returns error without required params", async () => {
      const result = await handlers.handleGuidePractice({});
      assert.equal(result.isError, true);
    });
  });

  describe("handleGuideCreate", () => {
    test("creates a guide with manual", async () => {
      const result = await handlers.handleGuideCreate({
        guide: "tdd",
        category: "dev-tool",
        description: "Test Driven Development workflow",
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("Created"));

      const loaded = guides.loadGuides();
      assert.equal(loaded[0].description, "Test Driven Development workflow");
    });
  });

  describe("handleGuideDistill", () => {
    test("distills memory into guide", async () => {
      const frag = seedMemory();

      const result = await handlers.handleGuideDistill({
        memory_id: frag.id,
        guide: "react",
        category: "web-frontend",
      });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("distilled"));

      const loaded = guides.loadGuides();
      assert.equal(loaded.length, 1);
      assert.ok(loaded[0].learnings.includes("react hooks pattern"));
    });
  });

  describe("handleGuideForget", () => {
    test("removes a guide", async () => {
      const gs = [guides.createGuide("react", "web-frontend", "desc")];
      guides.saveGuides(gs);

      const result = await handlers.handleGuideForget({ guide: "react" });
      assert.ok(!result.isError);
      assert.equal(guides.loadGuides().length, 0);
    });
  });

  describe("handleCallTool", () => {
    test("dispatches memory_read", async () => {
      seedMemory();
      const result = await handlers.handleCallTool({
        params: { name: "memory_read", arguments: { project: "testproj" } }
      });
      assert.ok(!result.isError);
    });

    test("returns error for unknown tool", async () => {
      const result = await handlers.handleCallTool({
        params: { name: "nonexistent_tool", arguments: {} }
      });
      assert.equal(result.isError, true);
    });
  });
});

describe("Hook System", () => {
  beforeEach(() => {
    hooks.clearHooks();
  });

  describe("registerHook", () => {
    test("registers a hook callback", () => {
      const unregister = hooks.registerHook(hooks.HookTypes.ON_START, async () => {});
      assert.equal(hooks.getHookCount(hooks.HookTypes.ON_START), 1);
      unregister();
    });

    test("returns unregister function", () => {
      const unregister = hooks.registerHook(hooks.HookTypes.ON_START, async () => {});
      unregister();
      assert.equal(hooks.getHookCount(hooks.HookTypes.ON_START), 0);
    });

    test("throws for unknown hook type", () => {
      assert.throws(() => {
        hooks.registerHook("unknown_type", async () => {});
      });
    });
  });

  describe("triggerHook", () => {
    test("calls all registered callbacks", async () => {
      let callCount = 0;
      hooks.registerHook(hooks.HookTypes.ON_START, async () => { callCount++; });
      hooks.registerHook(hooks.HookTypes.ON_START, async () => { callCount++; });

      await hooks.triggerHook(hooks.HookTypes.ON_START, { project: "test" });
      assert.equal(callCount, 2);
    });

    test("passes context to callbacks", async () => {
      let receivedProject: string | null = null;
      hooks.registerHook(hooks.HookTypes.ON_START, async (ctx) => {
        receivedProject = (ctx as { project: string }).project;
      });

      await hooks.triggerHook(hooks.HookTypes.ON_START, { project: "MyProject" });
      assert.equal(receivedProject, "MyProject");
    });

    test("returns results from all callbacks", async () => {
      hooks.registerHook(hooks.HookTypes.ON_START, async () => "result1");
      hooks.registerHook(hooks.HookTypes.ON_START, async () => "result2");

      const results = await hooks.triggerHook(hooks.HookTypes.ON_START, {});
      assert.deepEqual(results, ["result1", "result2"]);
    });

    test("handles callback errors gracefully", async () => {
      hooks.registerHook(hooks.HookTypes.ON_START, async () => { throw new Error("fail"); });
      hooks.registerHook(hooks.HookTypes.ON_START, async () => "success");

      const results = await hooks.triggerHook(hooks.HookTypes.ON_START, {});
      assert.equal((results[0] as { error: string }).error, "fail");
      assert.equal(results[1], "success");
    });
  });

  describe("clearHooks", () => {
    test("removes all hooks", () => {
      hooks.registerHook(hooks.HookTypes.ON_START, async () => {});
      hooks.registerHook(hooks.HookTypes.ON_PROJECT_CHANGE, async () => {});
      hooks.clearHooks();
      assert.equal(hooks.getHookCount(hooks.HookTypes.ON_START), 0);
      assert.equal(hooks.getHookCount(hooks.HookTypes.ON_PROJECT_CHANGE), 0);
    });
  });
});

describe("Prompt Modifiers", () => {
  test("registerPromptModifier adds modifier", () => {
    hooks.clearPromptModifiers();
    const unregister = hooks.registerPromptModifier(async (p: string) => p);
    assert.equal(hooks.getPromptModifierCount(), 1);
    unregister();
  });

  test("applyPromptModifiers modifies prompt", async () => {
    hooks.clearPromptModifiers();
    hooks.registerPromptModifier(async (prompt: string, _ctx) => {
      return prompt + "\n\n<!-- Custom Footer -->";
    });

    const modified = await hooks.applyPromptModifiers("Base", { project: "Test" });
    assert.ok(modified.includes("Custom Footer"));
    hooks.clearPromptModifiers();
  });

  test("multiple modifiers are applied in order", async () => {
    hooks.clearPromptModifiers();
    hooks.registerPromptModifier(async (p: string) => p + " [A]");
    hooks.registerPromptModifier(async (p: string) => p + " [B]");

    const result = await hooks.applyPromptModifiers("Start", {});
    assert.equal(result, "Start [A] [B]");
    hooks.clearPromptModifiers();
  });
});
