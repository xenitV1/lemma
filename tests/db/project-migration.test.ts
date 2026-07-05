import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import { SCHEMA_V3 } from "../../src/db/schema.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-mig-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function projectsIn(table: "memories" | "sessions"): string[] {
  const rows = db
    .prepareCached(`SELECT COALESCE(project, '<NULL>') AS p FROM ${table} ORDER BY id`)
    .all() as { p: string }[];
  return rows.map(r => r.p);
}

describe("SCHEMA_V3 — project key normalization", () => {
  test("fresh database reaches schema_version 4", () => {
    const row = db.prepareCached("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(row.v, 4);
  });

  test("re-running migrations is a no-op (already at v4)", () => {
    const before = db.prepareCached("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    runMigrations(db);
    const after = db.prepareCached("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(after.v, before.v);
    assert.equal(after.v, 4);
  });

  test("SCHEMA_V3 cleans historical dirty project keys (memories)", () => {
    const insert = db.prepareCached("INSERT INTO memories (legacy_id, title, fragment, type, project) VALUES (?, ?, ?, 'fact', ?)");
    insert.run("m1", "t1", "body", "Ailyro");
    insert.run("m2", "t2", "body", "ailyro");
    insert.run("m3", "t3", "body", "/home/mehmet-x/Projeler/scroll/mobil");
    insert.run("m4", "t4", "body", "global");
    insert.run("m5", "t5", "body", "GLOBAL");
    insert.run("m6", "t6", "body", "My Project");
    insert.run("m7", "t7", "body", null);

    // apply the v3 normalization SQL directly (idempotent, gated normally by v<3)
    db.db.exec(SCHEMA_V3);

    const cleaned = projectsIn("memories");
    assert.deepEqual(cleaned, ["ailyro", "ailyro", "mobil", "<NULL>", "<NULL>", "my project", "<NULL>"]);
  });

  test("SCHEMA_V3 is idempotent on memories", () => {
    const insert = db.prepareCached("INSERT INTO memories (legacy_id, title, fragment, type, project) VALUES (?, ?, ?, 'fact', ?)");
    insert.run("m1", "t1", "body", "Ailyro");
    insert.run("m2", "t2", "body", "/x/y/Proj");
    insert.run("m3", "t3", "body", "global");

    db.db.exec(SCHEMA_V3);
    const firstRun = projectsIn("memories");

    db.db.exec(SCHEMA_V3);
    db.db.exec(SCHEMA_V3);
    const afterReRuns = projectsIn("memories");

    assert.deepEqual(afterReRuns, firstRun);
    assert.deepEqual(firstRun, ["ailyro", "proj", "<NULL>"]);
  });

  test("SCHEMA_V3 cleans sessions too", () => {
    const insert = db.prepareCached("INSERT INTO sessions (id, project) VALUES (?, ?)");
    insert.run("s1", "Ailyro");
    insert.run("s2", "/home/x/cos");
    insert.run("s3", "global");
    insert.run("s4", null);

    db.db.exec(SCHEMA_V3);

    const cleaned = projectsIn("sessions");
    assert.deepEqual(cleaned, ["ailyro", "cos", "<NULL>", "<NULL>"]);
  });
});
