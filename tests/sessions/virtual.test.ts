import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { VirtualSession } from "../../src/types.js";

import {
  setSessionLogDir,
  recordToolCall,
  finalizeVirtualSession,
  getCurrentVirtualSession,
  getRecentSessions,
  setVirtualSessionConfig,
} from "../../src/sessions/virtual.js";

interface FinalizedVirtualSession {
  id: string;
  started_at: string;
  tool_calls: { tool: string; timestamp: string; args_summary: string | null; result_summary: string | null }[];
  project: string | null;
  guides_used: string[];
  memories_accessed: string[];
  memories_created: string[];
  ended_at: string;
  duration_tool_calls: number;
  technologies: string[];
}

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-virtual-test-"));
  setSessionLogDir(TMPDIR);
});

afterEach(() => {
  finalizeVirtualSession();
  setSessionLogDir(path.join(os.homedir(), ".lemma", "sessions"));
  setVirtualSessionConfig({ timeout_minutes: 30 });
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Virtual Sessions", () => {
  describe("recordToolCall", () => {
    test("creates new virtual session on first call", () => {
      const session: VirtualSession = recordToolCall("memory_read", { query: "test" }, null);
      assert.ok(session);
      assert.ok(session.id.startsWith("vs_"));
      assert.ok(session.started_at);
      assert.equal(session.tool_calls.length, 1);
    });

    test("appends to existing session on subsequent calls", () => {
      recordToolCall("memory_read", { query: "first" }, null);
      const session: VirtualSession = recordToolCall("memory_read", { query: "second" }, null);
      assert.equal(session.tool_calls.length, 2);
    });

    test("extracts project from memory_add args", () => {
      const session: VirtualSession = recordToolCall("memory_add", {
        fragment: "test",
        project: "MyProject",
      }, null);
      assert.equal(session.project, "MyProject");
    });

    test("tracks technologies from guide_practice contexts", () => {
      const session: VirtualSession = recordToolCall("guide_practice", {
        guide: "react",
        contexts: ["Hooks", "State"],
      }, null);
      assert.ok(session.technologies_seen.has("hooks"));
      assert.ok(session.technologies_seen.has("state"));
    });

    test("tracks guides used from guide_practice", () => {
      const session: VirtualSession = recordToolCall("guide_practice", {
        guide: "React",
        contexts: [],
      }, null);
      assert.ok(session.guides_used.has("react"));
    });

    test("tracks memories accessed from memory_read", () => {
      const session: VirtualSession = recordToolCall("memory_read", { id: "m123abc" }, null);
      assert.ok(session.memories_accessed.includes("m123abc"));
    });

    test("tracks memories created from memory_add titles", () => {
      const session: VirtualSession = recordToolCall("memory_add", {
        fragment: "content",
        title: "New Memory",
      }, { content: [{ text: "Added [mabc123def] New Memory" }] });
      assert.ok(session.memories_created.includes("mabc123def"));
    });
  });

  describe("finalizeVirtualSession", () => {
    test("returns null when no session exists", () => {
      assert.equal(finalizeVirtualSession(), null);
    });

    test("saves session to disk as JSON", () => {
      recordToolCall("memory_read", { query: "test" }, null);
      const session: FinalizedVirtualSession = finalizeVirtualSession()!;

      const files: string[] = fs.readdirSync(TMPDIR).filter((f: string) => f.endsWith(".json"));
      assert.equal(files.length, 1);
      assert.equal(files[0], `${session.id}.json`);

      const loaded: FinalizedVirtualSession = JSON.parse(fs.readFileSync(path.join(TMPDIR, files[0]), "utf-8"));
      assert.equal(loaded.id, session.id);
    });

    test("converts Set fields to arrays for serialization", () => {
      recordToolCall("guide_practice", {
        guide: "react",
        contexts: ["hooks"],
      }, null);
      const session: FinalizedVirtualSession = finalizeVirtualSession()!;

      assert.ok(Array.isArray(session.technologies));
      assert.ok(Array.isArray(session.guides_used));
      assert.ok(session.technologies.includes("hooks"));
      assert.ok(session.guides_used.includes("react"));
    });

    test("clears current session after finalizing", () => {
      recordToolCall("memory_read", { query: "test" }, null);
      finalizeVirtualSession();
      assert.equal(getCurrentVirtualSession(), null);
    });

    test("returns null for empty session with no tool calls", () => {
      assert.equal(getCurrentVirtualSession(), null);
      assert.equal(finalizeVirtualSession(), null);
    });

    test("includes duration_tool_calls count", () => {
      recordToolCall("memory_read", { query: "a" }, null);
      recordToolCall("memory_read", { query: "b" }, null);
      recordToolCall("memory_read", { query: "c" }, null);
      const session: FinalizedVirtualSession = finalizeVirtualSession()!;
      assert.equal(session.duration_tool_calls, 3);
    });
  });

  describe("getRecentSessions", () => {
    test("reads saved session files from disk", () => {
      recordToolCall("memory_read", { query: "test" }, null);
      finalizeVirtualSession();

      const recent: FinalizedVirtualSession[] = getRecentSessions();
      assert.equal(recent.length, 1);
    });

    test("respects count limit", async () => {
      const limitDir: string = path.join(TMPDIR, "limit-test");
      fs.mkdirSync(limitDir, { recursive: true });
      setSessionLogDir(limitDir);

      for (let i = 0; i < 5; i++) {
        recordToolCall("memory_read", { query: `q${i}` }, null);
        finalizeVirtualSession();
        await new Promise((r: (value: unknown) => void) => setTimeout(r, 5));
      }

      const recent: FinalizedVirtualSession[] = getRecentSessions(3);
      assert.equal(recent.length, 3);
    });

    test("returns empty when no sessions directory", () => {
      setSessionLogDir(path.join(TMPDIR, "nonexistent"));
      const recent: FinalizedVirtualSession[] = getRecentSessions();
      assert.deepEqual(recent, []);
    });
  });

  describe("setVirtualSessionConfig", () => {
    test("overrides config", () => {
      setVirtualSessionConfig({ timeout_minutes: 5 });
      recordToolCall("memory_read", { query: "test" }, null);
      const session: VirtualSession = getCurrentVirtualSession()!;
      assert.ok(session);
    });
  });

  describe("getCurrentVirtualSession", () => {
    test("returns null before any tool call", () => {
      assert.equal(getCurrentVirtualSession(), null);
    });

    test("returns session after tool call", () => {
      recordToolCall("memory_read", { query: "test" }, null);
      const session: VirtualSession = getCurrentVirtualSession()!;
      assert.ok(session);
      assert.ok(session.id.startsWith("vs_"));
      assert.equal(session.tool_calls.length, 1);
    });
  });
});
