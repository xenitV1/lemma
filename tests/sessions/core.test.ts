import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Session } from "../../src/types.js";
import { getDb } from "../../src/db/database.js";

import {
  setSessionsDir,
  createSession,
  loadSessions,
  saveSessions,
  findSession,
  findActiveSession,
  endSession,
  getRecentSessions,
  getSessionsByTechnology,
  calculateSuccessRate,
  formatSessionDetail,
} from "../../src/sessions/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-session-test-"));
  setSessionsDir(TMPDIR);
});

afterEach(() => {
  setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Sessions Core", () => {
  describe("createSession", () => {
    test("creates session with correct defaults", () => {
      const s: Session = createSession("debugging");
      assert.equal(s.status, "active");
      assert.equal(s.task_type, "debugging");
      assert.deepEqual(s.guides_used, []);
      assert.deepEqual(s.memories_read, []);
      assert.deepEqual(s.memories_created, []);
      assert.deepEqual(s.lessons, []);
      assert.equal(s.task_outcome, null);
      assert.equal(s.refinement_attempts, 0);
      assert.equal(s.self_critique_count, 0);
      assert.equal(s.initial_approach, null);
      assert.equal(s.final_approach, null);
      assert.equal(s.approach_changed, false);
    });

    test("stores task type and technologies", () => {
      const s: Session = createSession("implementation", ["react", "typescript"]);
      assert.equal(s.task_type, "implementation");
      assert.equal(s.technology, "react,typescript");
    });

    test("stores empty technology string when no technologies", () => {
      const s: Session = createSession("research");
      assert.equal(s.technology, "");
    });

    test("generates unique trace IDs", () => {
      const s1: Session = createSession("debugging");
      const s2: Session = createSession("debugging");
      assert.notEqual(s1.id, s2.id);
      assert.ok(s1.id.startsWith("s"));
    });

    test("generates unique session IDs", () => {
      const s1: Session = createSession("debugging");
      const s2: Session = createSession("debugging");
      assert.notEqual(s1.session_id, s2.session_id);
      assert.ok(s1.session_id.startsWith("s"));
    });

    test("sets timestamp as ISO string", () => {
      const s: Session = createSession("debugging");
      assert.ok(typeof s.timestamp === "string");
      assert.ok(!isNaN(Date.parse(s.timestamp)));
    });
  });

  describe("loadSessions", () => {
    test("returns empty array when no file exists", () => {
      assert.deepEqual(loadSessions(), []);
    });

    test("persists and reloads sessions", () => {
      const s: Session = createSession("debugging", ["node"]);
      saveSessions([s]);
      const loaded: Session[] = loadSessions();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].session_id, s.session_id);
      assert.equal(loaded[0].task_type, "debugging");
      assert.equal(loaded[0].technology, "node");
    });
  });

  describe("saveSessions", () => {
    test("refuses empty array (safety check)", () => {
      const s: Session = createSession("seed");
      saveSessions([s]);

      saveSessions([]);

      const loaded: Session[] = loadSessions();
      assert.equal(loaded.length, 1);
    });

    test("clears stale guide and memory links when session arrays become empty", () => {
      const s: Session = createSession("debugging");
      const db = getDb();
      db.prepareCached("INSERT INTO guides (guide, category, description) VALUES (?, ?, ?)").run("react", "web-frontend", "React guide");
      db.prepareCached("INSERT INTO memories (legacy_id, title, fragment, type) VALUES (?, ?, ?, ?)").run("m1", "Memory 1", "fragment", "fact");

      s.guides_used = ["react"];
      s.memories_read = ["m1"];
      saveSessions([s]);

      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_guide_usage WHERE session_id = ?").get(s.session_id) as any).count, 1);
      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_memory_links WHERE session_id = ?").get(s.session_id) as any).count, 1);

      s.guides_used = [];
      s.memories_read = [];
      saveSessions([s]);

      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_guide_usage WHERE session_id = ?").get(s.session_id) as any).count, 0);
      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_memory_links WHERE session_id = ?").get(s.session_id) as any).count, 0);
    });

    test("skips missing guide and memory links instead of violating foreign keys", () => {
      const s: Session = createSession("debugging");
      s.guides_used = ["missing-guide"];
      s.memories_read = ["missing-memory"];

      assert.doesNotThrow(() => saveSessions([s]));

      const db = getDb();
      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_guide_usage WHERE session_id = ?").get(s.session_id) as any).count, 0);
      assert.equal((db.prepareCached("SELECT COUNT(*) AS count FROM session_memory_links WHERE session_id = ?").get(s.session_id) as any).count, 0);
    });
  });

  describe("findSession", () => {
    test("finds session by session_id", () => {
      const s: Session = createSession("debugging");
      const found: Session = findSession([s], s.session_id)!;
      assert.equal(found.session_id, s.session_id);
    });

    test("returns null for non-existent session_id", () => {
      assert.equal(findSession([], "nope"), null);
    });
  });

  describe("findActiveSession", () => {
    test("finds active session", () => {
      const s: Session = createSession("debugging");
      const found: Session = findActiveSession([s])!;
      assert.equal(found.session_id, s.session_id);
    });

    test("returns null when all completed", () => {
      const s: Session = createSession("debugging");
      endSession(s, "success");
      assert.equal(findActiveSession([s]), null);
    });
  });

  describe("endSession", () => {
    test("sets status to completed", () => {
      const s: Session = createSession("debugging");
      endSession(s, "success");
      assert.equal(s.status, "completed");
    });

    test("stores outcome and lessons", () => {
      const s: Session = createSession("debugging");
      endSession(s, "failure", "tried different approach", ["need better logs"]);
      assert.equal(s.task_outcome, "failure");
      assert.equal(s.final_approach, "tried different approach");
      assert.deepEqual(s.lessons, ["need better logs"]);
    });

    test("sets completed_at timestamp", () => {
      const s: Session = createSession("debugging");
      endSession(s, "success");
      assert.ok(s.completed_at);
      assert.ok(!isNaN(Date.parse(s.completed_at!)));
    });
  });

  describe("getRecentSessions", () => {
    test("returns sorted by timestamp newest first", () => {
      const s1: Session = createSession("first");
      s1.timestamp = "2025-01-01T00:00:00Z";
      endSession(s1, "success");

      const s2: Session = createSession("second");
      s2.timestamp = "2025-06-01T00:00:00Z";
      endSession(s2, "success");

      const recent: Session[] = getRecentSessions([s1, s2]);
      assert.equal(recent[0].task_type, "second");
      assert.equal(recent[1].task_type, "first");
    });

    test("respects limit parameter", () => {
      const sessions: Session[] = [];
      for (let i = 0; i < 20; i++) {
        const s: Session = createSession(`task-${i}`);
        endSession(s, "success");
        sessions.push(s);
      }
      const recent: Session[] = getRecentSessions(sessions, 5);
      assert.equal(recent.length, 5);
    });

    test("only returns completed sessions", () => {
      const active: Session = createSession("active");
      const completed: Session = createSession("done");
      endSession(completed, "success");

      const recent: Session[] = getRecentSessions([active, completed]);
      assert.equal(recent.length, 1);
      assert.equal(recent[0].status, "completed");
    });
  });

  describe("getSessionsByTechnology", () => {
    test("filters by technology name case-insensitive", () => {
      const s1: Session = createSession("impl", ["React"]);
      const s2: Session = createSession("impl", ["Vue"]);
      const s3: Session = createSession("impl", ["REACT", "TypeScript"]);

      const result: Session[] = getSessionsByTechnology([s1, s2, s3], "react");
      assert.equal(result.length, 2);
    });

    test("returns empty for no matching technology", () => {
      const s: Session = createSession("impl", ["React"]);
      assert.equal(getSessionsByTechnology([s], "python").length, 0);
    });
  });

  describe("calculateSuccessRate", () => {
    test("returns correct ratio", () => {
      const s1: Session = createSession("a");
      endSession(s1, "success");
      const s2: Session = createSession("b");
      endSession(s2, "failure");
      const s3: Session = createSession("c");
      endSession(s3, "success");

      const rate: number = calculateSuccessRate([s1, s2, s3])!;
      assert.ok(Math.abs(rate - 2 / 3) < 0.001);
    });

    test("returns null for no completed sessions", () => {
      const s: Session = createSession("active");
      assert.equal(calculateSuccessRate([s]), null);
    });

    test("returns 1 for all successes", () => {
      const s1: Session = createSession("a");
      endSession(s1, "success");
      const s2: Session = createSession("b");
      endSession(s2, "success");

      assert.equal(calculateSuccessRate([s1, s2]), 1);
    });

    test("returns 0 for all failures", () => {
      const s1: Session = createSession("a");
      endSession(s1, "failure");
      const s2: Session = createSession("b");
      endSession(s2, "failure");

      assert.equal(calculateSuccessRate([s1, s2]), 0);
    });
  });

  describe("formatSessionDetail", () => {
    test("formats all fields", () => {
      const s: Session = createSession("implementation", ["react"]);
      endSession(s, "success", "used hooks", ["keep it simple"]);
      s.guides_used = ["react"];
      s.memories_read = ["m123", "m456"];
      s.memories_created = ["m789"];

      const output: string = formatSessionDetail(s);
      assert.ok(output.includes(s.session_id));
      assert.ok(output.includes(s.id));
      assert.ok(output.includes("completed"));
      assert.ok(output.includes("implementation"));
      assert.ok(output.includes("react"));
      assert.ok(output.includes("success"));
      assert.ok(output.includes("react"));
      assert.ok(output.includes("2"));
      assert.ok(output.includes("1"));
      assert.ok(output.includes("keep it simple"));
      assert.ok(output.includes("used hooks"));
    });

    test("returns not found for null", () => {
      assert.equal(formatSessionDetail(null), "Session not found.");
    });
  });
});
