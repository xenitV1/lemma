import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/core.js";
import { setConfigDir, resetConfig } from "../../src/memory/config.js";
import { handleMemoryAdd, handleMemoryRead, setNotifyChange } from "../../src/server/handlers.js";
import { closeDb } from "../../src/db/index.js";

let TEST_DIR: string;
let CODE_FILE: string;

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-b6h-"));
  closeDb();
  core.setMemoryDir(TEST_DIR);
  setConfigDir(TEST_DIR);
  fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify({ verification: { stale_check: true } }), "utf8");
  resetConfig();
  CODE_FILE = path.join(TEST_DIR, "retry.ts");
  fs.writeFileSync(CODE_FILE, "export function retry() {\n  await sleep(2 ** i * 1000);\n}\n", "utf8");
  setNotifyChange(() => {});
});
afterEach(() => {
  closeDb();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  setConfigDir(path.join(os.homedir(), ".lemma"));
  resetConfig();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("B6 — memory_add evidence + config-gated stale check on memory_read", () => {
  it("flags a fragment stale once its cited snippet drifts (opt-in)", async () => {
    const add = await handleMemoryAdd({
      fragment: "## Retry\nUses exponential backoff for transient failures.",
      evidence: { file: CODE_FILE, symbol: "retry", snippet: "await sleep(2 ** i * 1000);" },
    });
    assert.ok(!add.isError);
    const id = add.content[0].text.match(/\[([^\]]+)\]/)![1];

    // Snippet still present → not stale.
    const fresh = await handleMemoryRead({ id });
    assert.ok(!/STALE/i.test(fresh.content[0].text), "not stale while snippet present");
    assert.equal((fresh.structuredContent as any).stale_evidence, undefined);

    // Drift the file so the snippet is gone.
    fs.writeFileSync(CODE_FILE, "export function retry() {\n  await sleep(500);\n}\n", "utf8");

    const stale = await handleMemoryRead({ id });
    assert.ok(/STALE/i.test(stale.content[0].text), "flagged stale after drift");
    const flags = (stale.structuredContent as any).stale_evidence;
    assert.ok(Array.isArray(flags) && flags.length === 1 && flags[0].stale === true);
  });

  it("does not touch the filesystem when stale_check is off (default)", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify({ verification: { stale_check: false } }), "utf8");
    resetConfig();

    const add = await handleMemoryAdd({
      fragment: "## Retry2\nBackoff details.",
      evidence: { file: path.join(TEST_DIR, "does-not-exist.ts"), snippet: "whatever" },
    });
    const id = add.content[0].text.match(/\[([^\]]+)\]/)![1];
    const res = await handleMemoryRead({ id });
    assert.ok(!/STALE/i.test(res.content[0].text), "no stale check performed when disabled");
  });
});
