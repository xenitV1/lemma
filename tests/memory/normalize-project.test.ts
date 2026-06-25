import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "path";

import { normalizeProjectKey, resolveProjectScope, detectProject } from "../../src/memory/index.js";

describe("normalizeProjectKey", () => {
  test("lowercases mixed-case names", () => {
    assert.equal(normalizeProjectKey("Lemma"), "lemma");
    assert.equal(normalizeProjectKey("Ailyro"), "ailyro");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(normalizeProjectKey("  SpacedProj  "), "spacedproj");
  });

  test("collapses a posix path to its basename", () => {
    assert.equal(normalizeProjectKey("/home/mehmet-x/Projeler/scroll/mobil"), "mobil");
    assert.equal(normalizeProjectKey("./repo/src"), "src");
    assert.equal(normalizeProjectKey("a/b"), "b");
  });

  test("collapses a windows path (backslashes) to its basename", () => {
    assert.equal(normalizeProjectKey("C:\\Users\\foo\\Projeler\\Bar"), "bar");
    assert.equal(normalizeProjectKey("repo\\sub"), "sub");
  });

  test("strips trailing slashes before taking the basename", () => {
    assert.equal(normalizeProjectKey("a/b/"), "b");
    assert.equal(normalizeProjectKey("mobil/"), "mobil");
  });

  test("returns null for non-string / empty / whitespace", () => {
    assert.equal(normalizeProjectKey(undefined), null);
    assert.equal(normalizeProjectKey(null), null);
    assert.equal(normalizeProjectKey(123), null);
    assert.equal(normalizeProjectKey(""), null);
    assert.equal(normalizeProjectKey("   "), null);
  });

  test("preserves internal spaces", () => {
    assert.equal(normalizeProjectKey("My Project"), "my project");
  });
});

describe("resolveProjectScope", () => {
  const detected = detectProject();
  const expectedDetected = path.basename(process.cwd()).trim().toLowerCase();

  test("detects from cwd when omitted (undefined)", () => {
    assert.equal(resolveProjectScope(undefined), expectedDetected || null);
    assert.equal(detected, expectedDetected || null);
  });

  test("explicit null means global scope (NOT auto-detect)", () => {
    assert.equal(resolveProjectScope(null), null);
  });

  test("normalizes an explicit project string", () => {
    assert.equal(resolveProjectScope("Lemma"), "lemma");
    assert.equal(resolveProjectScope("/home/x/Projeler/COS"), "cos");
    assert.equal(resolveProjectScope("C:\\dev\\Ailyro"), "ailyro");
  });

  test("maps the literal 'global' (any case) to null scope", () => {
    assert.equal(resolveProjectScope("global"), null);
    assert.equal(resolveProjectScope("Global"), null);
    assert.equal(resolveProjectScope("GLOBAL"), null);
  });

  test("falls back to detected project when value normalizes to empty", () => {
    assert.equal(resolveProjectScope("   "), expectedDetected || null);
    assert.equal(resolveProjectScope(" / "), expectedDetected || null);
  });
});
