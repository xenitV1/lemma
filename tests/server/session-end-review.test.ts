import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleSessionStart, handleSessionEnd, handleMemoryAdd, handleMemoryRead, handleGuidePractice, resetSessionState } from "../../src/server/handlers.js";
import { recordToolCall } from "../../src/sessions/virtual.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-sesrev-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
  setNotifyChange(() => {});
});

afterEach(() => {
  resetSessionState();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedFragment(text: string, project: string | null = null): MemoryFragment {
  const frags = [core.createFragment(text, "ai", null, project)];
  core.saveMemory(frags);
  return frags[0];
}

function getText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe("session_end review hook", () => {
  test("session end without activity returns basic response without SESSION REVIEW", async () => {
    await handleSessionStart({ task_type: "implementation" });
    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(!result.isError);
    assert.ok(!text.includes("SESSION REVIEW"));
  });

  test("session end after adding memory shows Memories created in SESSION REVIEW", async () => {
    await handleSessionStart({ task_type: "implementation" });
    const addResult = await handleMemoryAdd({
      fragment: "Test fragment about caching strategies",
      title: "Caching strategies",
    });
    recordToolCall("memory_add", {
      fragment: "Test fragment about caching strategies",
      title: "Caching strategies",
    }, addResult);

    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(text.includes("SESSION REVIEW"));
    assert.ok(text.includes("Memories created"));
  });

  test("session end after reading memory shows Memories read in SESSION REVIEW", async () => {
    const frag = seedFragment("Important knowledge about database indexing");
    await handleSessionStart({ task_type: "research" });
    const readResult = await handleMemoryRead({ id: frag.id });
    recordToolCall("memory_read", { id: frag.id }, readResult);

    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(text.includes("SESSION REVIEW"));
    assert.ok(text.includes("Memories read"));
  });

  test("session end after both reading and adding shows both sections", async () => {
    const frag = seedFragment("Knowledge about REST API design patterns");
    await handleSessionStart({ task_type: "implementation" });
    const readResult = await handleMemoryRead({ id: frag.id });
    recordToolCall("memory_read", { id: frag.id }, readResult);

    const addResult = await handleMemoryAdd({
      fragment: "New insight about GraphQL vs REST tradeoffs",
      title: "GraphQL vs REST",
    });
    recordToolCall("memory_add", {
      fragment: "New insight about GraphQL vs REST tradeoffs",
      title: "GraphQL vs REST",
    }, addResult);

    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(text.includes("Memories read"));
    assert.ok(text.includes("Memories created"));
  });

  test("includes Auto-linked when both read and created memories exist", async () => {
    const frag = seedFragment("Important note about TypeScript generics and type inference");
    await handleSessionStart({ task_type: "debugging" });
    const readResult = await handleMemoryRead({ id: frag.id });
    recordToolCall("memory_read", { id: frag.id }, readResult);

    const addResult = await handleMemoryAdd({
      fragment: "Discovered that TypeScript conditional types help with type narrowing",
      title: "Conditional types narrowing",
    });
    recordToolCall("memory_add", {
      fragment: "Discovered that TypeScript conditional types help with type narrowing",
      title: "Conditional types narrowing",
    }, addResult);

    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(text.includes("Auto-linked"));
  });

  test("SUGGESTED ACTIONS includes guide_distill suggestion when memories created", async () => {
    await handleSessionStart({ task_type: "implementation" });
    const addResult = await handleMemoryAdd({
      fragment: "A reusable pattern for configuring middleware chains",
      title: "Middleware chain pattern",
    });
    recordToolCall("memory_add", {
      fragment: "A reusable pattern for configuring middleware chains",
      title: "Middleware chain pattern",
    }, addResult);

    const result = await handleSessionEnd({ outcome: "success" });
    const text = getText(result);
    assert.ok(text.includes("guide_distill"));
  });
});
