import { describe, test, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// TRAFFIC_DIR is computed at traffic-log module top-level via os.homedir().
// Once the module is imported, that path is FIXED for the process. So we must
// set HOME BEFORE importing traffic-log. We do it synchronously at the top of
// this file, then use a top-level `await import` so the module evaluates with
// HOME already pointing at a temp dir.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-traffic-"));
const SAVED_HOME = process.env.HOME;
process.env.HOME = TMPDIR;

const { logIncoming } = await import("../../src/server/traffic-log.js");

after(() => {
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function todaySuffix(): string {
  return new Date().toISOString().split("T")[0];
}

function readTodayLog(): string {
  const file = path.join(TMPDIR, ".lemma", "traffic", `traffic-${todaySuffix()}.jsonl`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

describe("traffic-log secret redaction", () => {
  test("tools/call: sk-... key in arguments is redacted, raw key absent", () => {
    logIncoming({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "memory_add", arguments: { fragment: "my key is sk-proj-abcdefghijklmnopqrstuvwx" } },
      id: 1,
    });
    const line = readTodayLog();
    assert.ok(line.length > 0, "expected a traffic log line to be written");
    assert.ok(/REDACTED:OpenAI/.test(line), `expected OpenAI redaction marker, got: ${line}`);
    assert.ok(!line.includes("sk-proj-abcdefghijklmnopqrstuvwx"), `raw key leaked: ${line}`);
  });

  test("tools/call: large body with secret near the end is both redacted and truncated", () => {
    const longFragment = "x".repeat(6000) + " sk-proj-abcdefghijklmnopqrstuvwx";
    logIncoming({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "memory_add", arguments: { fragment: longFragment } },
      id: 2,
    });
    const line = readTodayLog();
    assert.ok(/REDACTED:OpenAI/.test(line), `expected OpenAI redaction marker, got: ${line}`);
    assert.ok(!line.includes("sk-proj-abcdefghijklmnopqrstuvwx"), `raw key leaked near truncation: ${line}`);
    // Truncation must still apply: the redacted body cannot be the full 6000+ chars.
    assert.ok(line.includes("[truncated"), `expected truncation marker: ${line.slice(-200)}`);
  });

  test("resources/read: mongodb connection string uri is redacted, password absent", () => {
    logIncoming({
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "mongodb://admin:hunter2@host:27017/db" },
      id: 3,
    });
    const line = readTodayLog();
    assert.ok(/REDACTED:MongoDB/.test(line), `expected MongoDB redaction marker, got: ${line}`);
    assert.ok(!line.includes("hunter2"), `password leaked in uri: ${line}`);
  });
});
