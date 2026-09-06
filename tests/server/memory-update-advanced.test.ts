import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";
import { updateMemory } from "../../src/db/memory-store.js";
import { getDb } from "../../src/db/database.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-update-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("handleMemoryUpdate — fragment text", () => {
  test("updates fragment text and increments accessed counter", async () => {
    const f = core.createFragment("old text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, fragment: "new text" });
    assert.ok(!result.isError);

    const loaded = core.loadMemory().find((x: MemoryFragment) => x.id === f.id)!;
    assert.equal(loaded.fragment, "new text");
    assert.equal(loaded.accessed, 1);
  });

  test("rejects non-string fragment value", async () => {
    const f = core.createFragment("text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, fragment: 123 as any });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("fragment"));
  });
});

describe("handleMemoryUpdate — confidence", () => {
  test("updates confidence to valid value between 0 and 1", async () => {
    const f = core.createFragment("text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, confidence: 0.5 });
    assert.ok(!result.isError);
    assert.equal(core.loadMemory().find((x: MemoryFragment) => x.id === f.id)!.confidence, 0.5);
  });

  test("rejects confidence > 1.0", async () => {
    const f = core.createFragment("text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, confidence: 1.5 });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("confidence"));
  });

  test("rejects confidence < 0", async () => {
    const f = core.createFragment("text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, confidence: -0.1 });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("confidence"));
  });
});

describe("handleMemoryUpdate — type validation", () => {
  test("rejects non-string title value", async () => {
    const f = core.createFragment("text", "ai", "Title", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryUpdate({ id: f.id, title: 42 as any });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("title"));
  });

  test("returns error for unknown fragment ID when updating fragment text", async () => {
    const result = await handlers.handleMemoryUpdate({ id: "m_nonexistent", fragment: "text" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });
});


test("updates redact secrets in content and title before persistence", async () => {
  const f = core.createFragment("safe content", "ai", "Safe title", null);
  core.saveMemory([f]);
  const secret = "sk-" + "A".repeat(32);
  const result = await handlers.handleMemoryUpdate({ id: f.id, fragment: secret, title: secret });
  assert.ok(!result.isError);
  const saved = core.getFragmentById(f.id)!;
  assert.ok(!saved.fragment.includes(secret));
  assert.ok(!saved.title.includes(secret));
  assert.match(saved.fragment, /REDACTED/);
});


test("shared update path used by visualizer redacts all descriptive fields", () => {
  const f = core.createFragment("safe content", "ai", "Safe title", null);
  core.saveMemory([f]);
  const secret = "ghp_" + "B".repeat(36);
  assert.ok(updateMemory(getDb(), f.id, { title: secret, fragment: secret, description: secret }));
  const saved = core.getFragmentById(f.id)!;
  for (const value of [saved.title, saved.fragment, saved.description]) {
    assert.ok(!value.includes(secret));
    assert.match(value, /REDACTED/);
  }
});
