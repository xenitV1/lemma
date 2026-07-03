import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { installSkill, getSkillPath, SKILL_FILE } from "../../src/server/install-skill.js";
import { buildSkillContent, parseSkillVersion } from "../../src/server/skill-content.js";
import { VERSION } from "../../src/version.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-skill-test-"));
});

afterEach(() => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("installSkill", () => {
  test("writes SKILL.md into the skills dir when absent", () => {
    const skillDir = path.join(TMPDIR, "skills", "lemma");
    const res = installSkill({ skillDir });

    assert.strictEqual(res.installed, true);
    assert.strictEqual(res.skipped, false);
    assert.match(res.reason ?? "", /installed/);

    const file = path.join(skillDir, "SKILL.md");
    assert.ok(fs.existsSync(file));

    const content = fs.readFileSync(file, "utf-8");
    assert.ok(content.startsWith("---\n"), "frontmatter should lead the file");
    assert.match(content, /name: lemma/);
    assert.strictEqual(parseSkillVersion(content), VERSION);
  });

  test("is idempotent: skips when the same version is already installed", () => {
    const skillDir = path.join(TMPDIR, "skills", "lemma");
    const first = installSkill({ skillDir });
    assert.strictEqual(first.installed, true);

    const mtimeBefore = fs.statSync(path.join(skillDir, "SKILL.md")).mtimeMs;
    const second = installSkill({ skillDir });

    assert.strictEqual(second.installed, false);
    assert.strictEqual(second.skipped, true);
    assert.match(second.reason ?? "", /up to date/);

    // File must not have been rewritten.
    const mtimeAfter = fs.statSync(path.join(skillDir, "SKILL.md")).mtimeMs;
    assert.strictEqual(mtimeAfter, mtimeBefore);
  });

  test("overwrites when an older version stamp is present", () => {
    const skillDir = path.join(TMPDIR, "skills", "lemma");
    fs.mkdirSync(skillDir, { recursive: true });
    const file = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(file, `---\nname: lemma\n---\n\n<!-- lemma:skill:v=0.0.1 -->\nold body\n`, "utf-8");

    const res = installSkill({ skillDir });
    assert.strictEqual(res.installed, true);

    const content = fs.readFileSync(file, "utf-8");
    assert.strictEqual(parseSkillVersion(content), VERSION);
    assert.ok(!content.includes("v=0.0.1"));
    assert.ok(!content.includes("old body"));
  });

  test("creates nested skill dir if missing", () => {
    const skillDir = path.join(TMPDIR, "deeply", "nested", "skills", "lemma");
    const res = installSkill({ skillDir });
    assert.strictEqual(res.installed, true);
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
  });

  test("never throws on error — returns skipped with an error reason", () => {
    // Point skillDir inside a plain file so mkdir/write fails.
    const blocker = path.join(TMPDIR, "blocker");
    fs.writeFileSync(blocker, "x");
    const res = installSkill({ skillDir: path.join(blocker, "skills", "lemma") });

    assert.strictEqual(res.installed, false);
    assert.strictEqual(res.skipped, true);
    assert.match(res.reason ?? "", /error/);
  });

  test("default path resolves under ~/.agents/skills/lemma", () => {
    assert.strictEqual(getSkillPath(), SKILL_FILE);
    assert.match(SKILL_FILE, new RegExp(`${path.join(".agents", "skills", "lemma", "SKILL.md").replace(/\\/g, "\\\\")}$`));
  });
});

describe("skill content", () => {
  test("frontmatter carries a broad name + description", () => {
    const c = buildSkillContent();
    assert.match(c, /name: lemma/);
    assert.match(c, /^description: .+/m);
    // The description is the ONLY always-visible surface on skill-format clients
    // (e.g. Codex): it must both convey what Lemma is AND be an imperative that
    // forces the first memory_read (the skill body is not preloaded there).
    assert.match(c, /Persistent cross-session memory/);
    assert.match(c, /MCP/);
    assert.match(c, /FIRST call memory_read/);
    assert.match(c, /memory_add/);
  });

  test("fully reflects the MCP — lists the tool inventory", () => {
    const c = buildSkillContent();
    const mustMention = [
      "memory_read", "memory_add", "memory_update", "memory_forget", "memory_merge",
      "memory_relate", "memory_feedback", "memory_library", "memory_stats", "memory_audit",
      "semantic_search",
      "guide_get", "guide_distill", "guide_practice",
      "session_start", "session_end", "session_attempt",
      "conflict_scan", "proactive_analysis", "project_analytics",
    ];
    for (const t of mustMention) {
      assert.ok(c.includes(t), `skill content should mention tool: ${t}`);
    }
  });

  test("carries the version stamp matching VERSION", () => {
    const c = buildSkillContent();
    assert.strictEqual(parseSkillVersion(c), VERSION);
  });
});
