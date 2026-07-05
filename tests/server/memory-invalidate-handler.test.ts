import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/core.js";
import { handleMemoryAdd, handleMemoryRead, handleMemoryForget, setNotifyChange } from "../../src/server/handlers.js";
import { closeDb } from "../../src/db/index.js";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-invalidate-"));
  closeDb();
  core.setMemoryDir(TEST_DIR);
  setNotifyChange(() => {});
});
afterEach(() => {
  closeDb();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("memory_forget invalidate=true (B2 handler path)", () => {
  it("hides the fragment from recall but keeps it recoverable", async () => {
    const add = await handleMemoryAdd({ fragment: "graphql subscription backpressure handling" });
    const id = add.content[0].text.match(/\[([^\]]+)\]/)![1];

    // Present in browse before.
    const before = await handleMemoryRead({});
    assert.ok(before.content[0].text.includes(id));

    const forget = await handleMemoryForget({ id, invalidate: true });
    assert.ok(!forget.isError);
    assert.ok(/invalidated/i.test(forget.content[0].text));

    // Gone from recall (browse + query).
    const afterBrowse = await handleMemoryRead({});
    assert.ok(!afterBrowse.content[0].text.includes(id), "hidden from browse");
    const afterQuery = await handleMemoryRead({ query: "graphql subscription" });
    assert.ok(!afterQuery.content[0].text.includes(id), "hidden from search");

    // Still in the DB, and restorable.
    assert.equal(core.restoreFragment(id), true);
    const restored = await handleMemoryRead({});
    assert.ok(restored.content[0].text.includes(id), "back after restore");
  });
});
