import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations, migrateFromJsonl } from "../../src/db/migration.js";
import { MIGRATIONS } from "../../src/db/schema.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-migrate-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("migrateFromJsonl", () => {
  test("returns zeros when no JSONL files exist", () => {
    const result = migrateFromJsonl(db, TMPDIR);
    assert.equal(result.memories, 0);
    assert.equal(result.guides, 0);
    assert.equal(result.sessions, 0);
  });

  test("migrates memories from memory.jsonl", () => {
    const memories = [
      {
        id: "m_test_001",
        title: "Test Memory",
        fragment: "Test fragment content",
        description: "Test desc",
        project: "test-project",
        confidence: 0.8,
        source: "ai",
        created: "2026-04-15T10:00:00.000Z",
        lastAccessed: "2026-04-20T10:00:00.000Z",
        accessed: 5,
        tags: ["test"],
        associatedWith: [],
        relations: [],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 2,
        negative_feedback: 0,
        last_refined: null,
        type: "fact",
        related_guides: [],
        distill_candidate: false,
      },
      {
        id: "m_test_002",
        title: "Pattern Memory",
        fragment: "Pattern content",
        description: "Pattern desc",
        project: null,
        confidence: 0.9,
        source: "ai",
        created: "2026-04-10T10:00:00.000Z",
        lastAccessed: null,
        accessed: 0,
        tags: [],
        associatedWith: [],
        relations: [],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 0,
        negative_feedback: 0,
        last_refined: null,
        type: "pattern",
        related_guides: [],
        distill_candidate: true,
      },
    ];

    fs.writeFileSync(
      path.join(TMPDIR, "memory.jsonl"),
      memories.map(m => JSON.stringify(m)).join("\n")
    );

    const result = migrateFromJsonl(db, TMPDIR);
    assert.equal(result.memories, 2);

    const row1 = db.prepareCached("SELECT * FROM memories WHERE legacy_id = ?").get("m_test_001") as Record<string, unknown>;
    assert.ok(row1);
    assert.equal(row1.title, "Test Memory");
    assert.equal(row1.project, "test-project");
    assert.equal(row1.confidence, 0.8);
    assert.equal(row1.access_count, 5);
    assert.equal(row1.positive_feedback, 2);

    const row2 = db.prepareCached("SELECT * FROM memories WHERE legacy_id = ?").get("m_test_002") as Record<string, unknown>;
    assert.ok(row2);
    assert.equal(row2.type, "pattern");
    assert.equal(row2.distill_candidate, 1);
  });

  test("migrates guides from guides.jsonl", () => {
    const guides = [
      {
        id: "g_001",
        guide: "react",
        category: "web-frontend",
        description: "React patterns",
        usage_count: 10,
        last_used: "2026-04-20",
        contexts: ["hooks", "state"],
        learnings: ["use useCallback for perf"],
        success_count: 8,
        failure_count: 2,
        anti_patterns: ["prop drilling"],
        known_pitfalls: ["stale closures"],
        last_refined: null,
        depends_on: [],
        enables: [],
        superseded_by: null,
        deprecated: false,
        source_memories: ["m_test_001"],
        validated_by: [],
      },
    ];

    fs.writeFileSync(
      path.join(TMPDIR, "guides.jsonl"),
      guides.map(g => JSON.stringify(g)).join("\n")
    );

    const result = migrateFromJsonl(db, TMPDIR);
    assert.equal(result.guides, 1);

    const row = db.prepareCached("SELECT * FROM guides WHERE guide = ?").get("react") as Record<string, unknown>;
    assert.ok(row);
    assert.equal(row.category, "web-frontend");
    assert.equal(row.usage_count, 10);
    assert.equal(row.deprecated, 0);
  });

  test("migrates sessions from sessions.jsonl", () => {
    const sessions = [
      {
        id: "sess_001",
        session_id: "sess_001",
        timestamp: "2026-04-15T10:00:00.000Z",
        task_type: "implementation",
        technology: "typescript",
        guides_used: ["react"],
        memories_read: ["m_test_001"],
        memories_created: [],
        task_outcome: "success",
        refinement_attempts: 0,
        self_critique_count: 0,
        initial_approach: "direct",
        final_approach: "direct",
        approach_changed: false,
        lessons: ["test lesson"],
        status: "completed",
      },
    ];

    fs.writeFileSync(
      path.join(TMPDIR, "sessions.jsonl"),
      sessions.map(s => JSON.stringify(s)).join("\n")
    );

    const result = migrateFromJsonl(db, TMPDIR);
    assert.equal(result.sessions, 1);

    const row = db.prepareCached("SELECT * FROM sessions WHERE id = ?").get("sess_001") as Record<string, unknown>;
    assert.ok(row);
    assert.equal(row.task_type, "implementation");
    assert.equal(row.outcome, "success");
  });

  test("migrates relations between memories", () => {
    const memories = [
      {
        id: "m_rel_a",
        title: "Source",
        fragment: "Source content",
        description: "",
        project: null,
        confidence: 0.7,
        source: "ai",
        created: "2026-04-15T10:00:00.000Z",
        lastAccessed: null,
        accessed: 0,
        tags: [],
        associatedWith: [],
        relations: [{ id: "m_rel_b", type: "supports", targetId: "m_rel_b" }],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 0,
        negative_feedback: 0,
        last_refined: null,
        type: "fact",
        related_guides: [],
      },
      {
        id: "m_rel_b",
        title: "Target",
        fragment: "Target content",
        description: "",
        project: null,
        confidence: 0.8,
        source: "ai",
        created: "2026-04-15T10:00:00.000Z",
        lastAccessed: null,
        accessed: 0,
        tags: [],
        associatedWith: [],
        relations: [],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 0,
        negative_feedback: 0,
        last_refined: null,
        type: "fact",
        related_guides: [],
      },
    ];

    fs.writeFileSync(
      path.join(TMPDIR, "memory.jsonl"),
      memories.map(m => JSON.stringify(m)).join("\n")
    );

    const result = migrateFromJsonl(db, TMPDIR);
    assert.equal(result.memories, 2);

    const srcRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get("m_rel_a") as { id: number };
    const tgtRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get("m_rel_b") as { id: number };

    const relRows = db.prepareCached(
      "SELECT * FROM relations WHERE source_id = ? AND target_id = ?"
    ).all(srcRow.id, tgtRow.id) as Record<string, unknown>[];
    assert.ok(relRows.length >= 1);
    assert.equal(relRows[0].type, "supports");
  });

  test("renames JSONL files to .migrated.bak after successful migration", () => {
    const memories = [
      {
        id: "m_bak_test",
        title: "Backup Test",
        fragment: "Content",
        description: "",
        project: null,
        confidence: 0.5,
        source: "ai",
        created: "2026-04-15T10:00:00.000Z",
        lastAccessed: null,
        accessed: 0,
        tags: [],
        associatedWith: [],
        relations: [],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 0,
        negative_feedback: 0,
        last_refined: null,
        type: "fact",
        related_guides: [],
      },
    ];

    const filePath = path.join(TMPDIR, "memory.jsonl");
    fs.writeFileSync(filePath, JSON.stringify(memories[0]));

    assert.ok(fs.existsSync(filePath));

    migrateFromJsonl(db, TMPDIR);

    assert.ok(!fs.existsSync(filePath), "Original file should be renamed");
    assert.ok(fs.existsSync(filePath + ".migrated.bak"), "Backup file should exist");
  });

  test("does not re-migrate already migrated files", () => {
    const memories = [
      {
        id: "m_once",
        title: "Once",
        fragment: "Content",
        description: "",
        project: null,
        confidence: 0.5,
        source: "ai",
        created: "2026-04-15T10:00:00.000Z",
        lastAccessed: null,
        accessed: 0,
        tags: [],
        associatedWith: [],
        relations: [],
        negativeHits: 0,
        quality_score: null,
        refinement_count: 0,
        parent_id: null,
        session_id: null,
        task_type: null,
        positive_feedback: 0,
        negative_feedback: 0,
        last_refined: null,
        type: "fact",
        related_guides: [],
      },
    ];

    fs.writeFileSync(
      path.join(TMPDIR, "memory.jsonl"),
      JSON.stringify(memories[0])
    );

    const first = migrateFromJsonl(db, TMPDIR);
    assert.equal(first.memories, 1);

    const second = migrateFromJsonl(db, TMPDIR);
    assert.equal(second.memories, 0);
  });
});

describe("runMigrations — V2 schema_version tracking", () => {
  test("applies V1 then V2 on a fresh DB and records schema_version 2", () => {
    const tmpDb = new LemmaDB(path.join(TMPDIR, "fresh-migrated.db"));
    runMigrations(tmpDb);
    const versions = tmpDb
      .prepareCached("SELECT version FROM schema_version ORDER BY version")
      .all() as { version: number }[];
    assert.deepEqual(versions.map(v => v.version), [1, 2, 3, 4, 5]);
    const tables = tmpDb
      .prepareCached("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_attempts','improvement_suggestions')")
      .all() as { name: string }[];
    assert.deepEqual(tables.map(t => t.name).sort(), ["improvement_suggestions", "session_attempts"]);
    tmpDb.close();
  });

  test("migrations are idempotent — re-running runMigrations is a no-op", () => {
    const tmpDb = new LemmaDB(path.join(TMPDIR, "idempotent.db"));
    runMigrations(tmpDb);
    runMigrations(tmpDb);
    const versions = tmpDb.prepareCached("SELECT version FROM schema_version").all() as { version: number }[];
    assert.equal(versions.length, 5);
    const attemptTables = tmpDb
      .prepareCached("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='session_attempts'")
      .get() as { c: number };
    assert.equal(attemptTables.c, 1);
    tmpDb.close();
  });

  test("V2 migration preserves all existing V1 data (back-compat)", () => {
    // 1. Build a V1-only DB and populate it with real data.
    const v1Db = new LemmaDB(path.join(TMPDIR, "v1-seed.db"));
    runMigrations(v1Db);

    v1Db.prepareCached(
      "INSERT INTO memories (legacy_id, title, fragment, type, project, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("m_keep_1", "Keep Me", "content to preserve", "fact", "proj", 0.77);
    v1Db.prepareCached(
      "INSERT INTO sessions (id, task_type, status, started_at) VALUES (?, ?, 'completed', ?)"
    ).run("sess_keep_1", "debugging", "2026-06-01T00:00:00.000Z");
    const beforeMem = v1Db.prepareCached("SELECT legacy_id, title, confidence FROM memories WHERE legacy_id='m_keep_1'").get();
    const beforeSess = v1Db.prepareCached("SELECT id, task_type, status FROM sessions WHERE id='sess_keep_1'").get();
    v1Db.close();

    // 2. Re-open the same DB file and run migrations again (simulates an existing user upgrading).
    const upgradedDb = new LemmaDB(path.join(TMPDIR, "v1-seed.db"));
    runMigrations(upgradedDb);

    // 3. Existing data is byte-for-byte unchanged.
    const afterMem = upgradedDb.prepareCached("SELECT legacy_id, title, confidence FROM memories WHERE legacy_id='m_keep_1'").get();
    const afterSess = upgradedDb.prepareCached("SELECT id, task_type, status FROM sessions WHERE id='sess_keep_1'").get();
    assert.deepEqual(afterMem, beforeMem);
    assert.deepEqual(afterSess, beforeSess);

    // 4. New tables exist and are empty (no phantom rows).
    const attemptCount = upgradedDb.prepareCached("SELECT count(*) as c FROM session_attempts").get() as { c: number };
    const suggestionCount = upgradedDb.prepareCached("SELECT count(*) as c FROM improvement_suggestions").get() as { c: number };
    assert.equal(attemptCount.c, 0);
    assert.equal(suggestionCount.c, 0);
    upgradedDb.close();
  });

  test("MIGRATIONS array is sorted ascending and includes V2", () => {
    const versions = MIGRATIONS.map(([v]) => v);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
    assert.ok(versions.includes(2));
  });
});
