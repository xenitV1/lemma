import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import * as handlers from "../../src/server/handlers.js";
import { resetSessionState } from "../../src/server/handlers.js";
import type { Session } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
});

afterEach(() => {
  resetSessionState();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("handleSessionStart", () => {
  test("creates a new session with task_type", async () => {
    const result = await handlers.handleSessionStart({
      task_type: "implementation",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Session started"));
    assert.ok(result.content[0].text.includes("implementation"));

    const loaded: Session[] = sessions.loadSessions();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].task_type, "implementation");
    assert.equal(loaded[0].status, "active");
  });

  test("stores technologies", async () => {
    const result = await handlers.handleSessionStart({
      task_type: "debugging",
      technologies: ["react", "typescript"],
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("react"));
    assert.ok(result.content[0].text.includes("typescript"));

    const loaded: Session[] = sessions.loadSessions();
    assert.equal(loaded[0].technology, "react,typescript");
  });

  test("stores initial_approach", async () => {
    const result = await handlers.handleSessionStart({
      task_type: "refactoring",
      initial_approach: "Extract utility functions first",
    });
    assert.ok(!result.isError);

    const loaded: Session[] = sessions.loadSessions();
    assert.equal(loaded[0].initial_approach, "Extract utility functions first");
  });

  test("requires task_type parameter", async () => {
    const result = await handlers.handleSessionStart({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("task_type"));
  });
});

describe("handleSessionEnd", () => {
  test("completes active session with outcome", async () => {
    await handlers.handleSessionStart({ task_type: "testing" });

    const result = await handlers.handleSessionEnd({
      outcome: "success",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("ended: success"));

    const loaded: Session[] = sessions.loadSessions();
    assert.equal(loaded[0].status, "completed");
    assert.equal(loaded[0].task_outcome, "success");
  });

  test("stores final_approach", async () => {
    await handlers.handleSessionStart({ task_type: "debugging" });

    await handlers.handleSessionEnd({
      outcome: "partial",
      final_approach: "Used binary search to isolate the bug",
    });

    const loaded: Session[] = sessions.loadSessions();
    assert.equal(loaded[0].final_approach, "Used binary search to isolate the bug");
  });

  test("stores lessons array", async () => {
    await handlers.handleSessionStart({ task_type: "research" });

    const result = await handlers.handleSessionEnd({
      outcome: "success",
      lessons: ["Always check memory first", "Use guide_get for patterns"],
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("2 recorded"));

    const loaded: Session[] = sessions.loadSessions();
    assert.deepEqual(loaded[0].lessons, ["Always check memory first", "Use guide_get for patterns"]);
  });

  test("returns error when no active session", async () => {
    const result = await handlers.handleSessionEnd({
      outcome: "failure",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("No active session"));
  });
});

describe("handleSessionAttempt", () => {
  test("uses persisted active session after process-local state is reset", async () => {
    await handlers.handleSessionStart({ task_type: "debugging" });
    const [created] = sessions.loadSessions();
    resetSessionState();

    const result = await handlers.handleSessionAttempt({
      approach: "restart-safe attempt",
      outcome: "rejected",
      critique: "process-local state was empty",
    });

    assert.ok(!result.isError);
    const attempts = sessions.loadAttemptsForSession(created.session_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].approach, "restart-safe attempt");
  });
});

describe("handleSessionStats", () => {
  test("returns virtual session statistics", async () => {
    const result = await handlers.handleSessionStats({});
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Session Stats"));
  });
});
