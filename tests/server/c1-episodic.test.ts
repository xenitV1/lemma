import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/core.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import * as store from "../../src/db/memory-store.js";
import { getDb, closeDb } from "../../src/db/index.js";
import { autoStartSession, autoEndSession, resetSessionState, setNotifyChange } from "../../src/server/handlers.js";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-c1-"));
  closeDb();
  core.setMemoryDir(TEST_DIR);
  guides.setGuidesDir(TEST_DIR);
  sessions.setSessionsDir?.(TEST_DIR);
  resetSessionState();
  setNotifyChange(() => {});
});
afterEach(() => {
  closeDb();
  resetSessionState();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("C1 — virtual sessions persist to SQL (episodic tier)", () => {
  it("writes technologies, memory links, guide links, digest + outcome into SQL", () => {
    const db = getDb();
    const a = store.addMemory(db, "read fragment about hooks", "ai", "Hooks", null, undefined, "fact");
    const b = store.addMemory(db, "created fragment about ssr", "ai", "SSR", null, undefined, "fact");
    const g = guides.createGuide("react", "web-frontend", "React guide");
    guides.saveGuides([g]);

    autoStartSession("proj");
    autoEndSession({
      duration_tool_calls: 5,
      technologies: ["typescript", "react"],
      memories_created: [b.legacy_id],
      memories_accessed: [a.legacy_id],
      guides_used: ["react"],
      project: "proj",
    });

    // The session row is persisted + completed with the crystallized digest.
    const all = sessions.loadSessions();
    const completed = all.find(s => s.status === "completed");
    assert.ok(completed, "a completed session row exists");
    assert.equal(completed!.task_outcome, "partial");
    assert.ok(completed!.technology.includes("react"), "technologies persisted");
    assert.ok(completed!.lessons.some(l => /Episode/.test(l)), "crystallized digest stored");

    // Junction tables are populated (this is what feeds analytics + C4).
    const memLinks = db.prepareCached(
      "SELECT interaction_type, COUNT(*) AS c FROM session_memory_links WHERE session_id = ? GROUP BY interaction_type",
    ).all(completed!.session_id) as { interaction_type: string; c: number }[];
    const byType = Object.fromEntries(memLinks.map(r => [r.interaction_type, r.c]));
    assert.equal(byType.read, 1, "read link persisted");
    assert.equal(byType.created, 1, "created link persisted");

    const guideLinks = db.prepareCached(
      "SELECT COUNT(*) AS c FROM session_guide_usage WHERE session_id = ?",
    ).get(completed!.session_id) as { c: number };
    assert.equal(guideLinks.c, 1, "guide usage link persisted");
  });

  it("feeds C4 self-consistency: linked memories now carry session outcomes", () => {
    const db = getDb();
    const m = store.addMemory(db, "pattern used across sessions", "ai", "P", null, undefined, "pattern");

    // Three episodes all reading the same fragment, all succeeding-ish.
    for (let i = 0; i < 3; i++) {
      autoStartSession("proj");
      autoEndSession({ duration_tool_calls: 2, technologies: ["ts"], memories_created: [], memories_accessed: [m.legacy_id], guides_used: [], project: "proj" });
    }
    const rows = db.prepareCached(
      `SELECT COUNT(*) AS c FROM session_memory_links sml JOIN sessions s ON s.id = sml.session_id
       WHERE sml.memory_id = ? AND s.outcome IS NOT NULL`,
    ).get(m.id) as { c: number };
    assert.equal(rows.c, 3, "all three episodes linked with outcomes → C4 has data");
  });
});
