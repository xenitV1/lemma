import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger, setLogDir, enableLogger, disableLogger } from "../src/logger.js";

test("diagnostic logs redact secrets before truncation, including nested arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-log-privacy-"));
  const secret = "ghp_" + "A".repeat(36);
  setLogDir(dir);
  enableLogger();
  try {
    logger.toolCall("memory_update", { fragment: "x".repeat(70) + secret });
    logger.request("tools/call", { nested: { secret } });
    logger.warn("failed with " + secret);
    logger.request("tools/call", { fragment: 'password="synthetic-password"' });
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("ghp_"));
    assert.ok(!text.includes("synthetic-password"));
    assert.match(text, /REDACTED/);
  } finally {
    disableLogger();
    setLogDir(path.join(os.homedir(), ".lemma", "logs"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
