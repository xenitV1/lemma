import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

// Get directory of current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test isolation - create temp directory
let tempDir;

// Import the memory module functions dynamically with path override
async function importWithOverride(memoryFilePath) {
  // Create a temporary module that overrides the MEMORY_FILE
  const tempModulePath = path.join(tempDir, `memory-core-${Date.now()}.mjs`);
  const originalCode = await fs.readFile(
    path.join(__dirname, "memory-core.js"),
    "utf-8"
  );

  // Override MEMORY_FILE constant - use forward slashes for JS string
  const normalizedPath = memoryFilePath.replace(/\\/g, "/");
  const modifiedCode = originalCode.replace(
    /const MEMORY_FILE = path\.join\(MEMORY_DIR, "memory\.jsonl"\);/,
    `const MEMORY_FILE = "${normalizedPath}";`
  );

  await fs.writeFile(tempModulePath, modifiedCode);

  // Use file:// URL for Windows compatibility
  return import(pathToFileURL(tempModulePath).href);
}

// Test result tracking
let passed = 0;
let failed = 0;

function runTest(name, testFn) {
  return testFn()
    .then(() => {
      passed++;
      console.log(`✓ ${name}`);
    })
    .catch((error) => {
      failed++;
      console.log(`✗ ${name}`);
      console.log(`  Error: ${error.message}`);
    });
}

// Test 1: loadMemory - empty file
async function test_loadMemory_emptyFile() {
  const memoryFile = path.join(tempDir, "empty.jsonl");
  await fs.writeFile(memoryFile, "");

  const core = await importWithOverride(memoryFile);
  const fragments = core.loadMemory();
  assert.deepStrictEqual(fragments, [], "Empty file should return empty array");
}

// Test 2: loadMemory - with fragments
async function test_loadMemory_withFragments() {
  const memoryFile = path.join(tempDir, "fragments.jsonl");

  const fragment1 = {
    id: "m123abc",
    title: "Test Title 1",
    fragment: "Test content 1",
    confidence: 0.9,
    source: "ai",
    created: "2026-03-01",
    accessed: 0,
  };

  const fragment2 = {
    id: "m789xyz",
    title: "Test Title 2",
    fragment: "Test content 2",
    confidence: 0.8,
    source: "user",
    created: "2026-03-02",
    accessed: 5,
  };

  const jsonl = JSON.stringify(fragment1) + "\n" + JSON.stringify(fragment2) + "\n";
  await fs.writeFile(memoryFile, jsonl);

  const core = await importWithOverride(memoryFile);
  const fragments = core.loadMemory();

  assert.strictEqual(fragments.length, 2, "Should load 2 fragments");
  assert.strictEqual(fragments[0].fragment, "Test content 1");
  assert.strictEqual(fragments[0].title, "Test Title 1");
  assert.strictEqual(fragments[1].fragment, "Test content 2");
  assert.strictEqual(fragments[1].title, "Test Title 2");
}

// Test 3: saveMemory - creates directory
async function test_saveMemory_createsDirectory() {
  const newDir = path.join(tempDir, "new", "nested", "dir");
  const memoryFile = path.join(newDir, "memory.jsonl");

  const core = await importWithOverride(memoryFile);

  const fragment = core.createFragment("Test", "ai");
  core.saveMemory([fragment]);

  const stats = await fs.stat(newDir);
  assert(stats.isDirectory(), "Directory should be created");

  const content = await fs.readFile(memoryFile, "utf-8");
  assert(content.includes("Test"), "File should contain fragment");
}

// Test 4: decayConfidence - reduces correctly
async function test_decayConfidence_reducesCorrectly() {
  const core = await importWithOverride(path.join(tempDir, "decay1.jsonl"));

  const now = new Date();
  // Simulate memory accessed today
  const recentTime = now.toISOString();

  const fragment1 = {
    id: "m000001",
    title: "Test 1",
    fragment: "Test content 1",
    confidence: 1.0,
    source: "ai",
    created: recentTime,
    lastAccessed: recentTime,
    accessed: 0,
  };

  const fragment2 = {
    id: "m000002",
    title: "Test 2",
    fragment: "Test content 2",
    confidence: 1.0,
    source: "ai",
    created: recentTime,
    lastAccessed: recentTime,
    accessed: 5,
  };

  const result = core.decayConfidence([fragment1, fragment2]);

  // Base decay with 0 accessed = 0.05 modifier
  // Time decay with 0 days = 1.0 multiplier
  // Decay step: 0.05 * 1.0 = 0.05
  // New confidence: 1.0 - 0.05 = 0.95
  assert(Math.abs(result[0].confidence - 0.95) < 0.001, "Never accessed fragment should lose 0.05");

  // Base decay with 5 accessed = 0.05 - 0.025 = 0.025 modifier
  // Time decay with 0 days = 1.0 multiplier
  // Decay step: 0.025 * 1.0 = 0.025
  // New confidence: 1.0 - 0.025 = 0.975
  assert(Math.abs(result[1].confidence - 0.975) < 0.001, "5x accessed fragment should lose 0.025");
}

// Test 5: decayConfidence - removes low fragments
async function test_decayConfidence_removesLowFragments() {
  const core = await importWithOverride(path.join(tempDir, "decay2.jsonl"));

  const fragment1 = {
    id: "m000003",
    title: "Keep me",
    fragment: "Keep me content",
    confidence: 0.5,
    source: "ai",
    created: "2026-03-01",
    accessed: 0,
  };

  const fragment2 = {
    id: "m000004",
    title: "Remove me",
    fragment: "Remove me content",
    confidence: 0.1,
    source: "ai",
    created: "2026-03-01",
    accessed: 0,
  };

  const result = core.decayConfidence([fragment1, fragment2]);

  // fragment2 decays to 0.05 and is removed (confidence < 0.1)
  assert.strictEqual(result.length, 1, "Low confidence fragment should be removed");
  assert.strictEqual(result[0].id, "m000003", "High confidence fragment should remain");
}

// Test 6: formatMemoryForLLM - correct format
async function test_formatMemoryForLLM_correctFormat() {
  const core = await importWithOverride(path.join(tempDir, "format.jsonl"));

  const fragments = [
    {
      id: "m123abc",
      title: "Important fact",
      fragment: "This is the detailed content of important fact",
      confidence: 1.0,
      source: "ai",
      created: "2026-03-01",
      accessed: 0,
    },
    {
      id: "m789xyz",
      title: "Another fact",
      fragment: "This is another detailed fact content",
      confidence: 0.4,
      source: "user",
      created: "2026-03-01",
      accessed: 5,
    },
  ];

  const formatted = core.formatMemoryForLLM(fragments);

  assert(formatted.includes("=== LEMMA MEMORY FRAGMENTS ==="), "Should include header");
  assert(formatted.includes("█████"), "Should include full confidence bar for 1.0");
  assert(formatted.includes("██░░░"), "Should include 0.4 confidence bar");
  assert(formatted.includes("Important fact"), "Should include title");
  assert(formatted.includes("detailed content"), "Should include fragment content");
  assert(formatted.includes("m123abc"), "Should include fragment ID");
  assert(formatted.includes("🤖"), "Should include AI icon");
  assert(formatted.includes("👤"), "Should include user icon");
}

// Test 7: generateId - correct format
async function test_generateId_correctFormat() {
  const core = await importWithOverride(path.join(tempDir, "id.jsonl"));

  const id = core.generateId();

  assert(id.startsWith("m"), "ID should start with 'm'");
  assert.strictEqual(id.length, 7, "ID should be 7 characters long");

  const hexPart = id.slice(1);
  assert(/^[0-9a-f]{6}$/.test(hexPart), "Last 6 chars should be hexadecimal");
}

// Test 8: createFragment - valid object
async function test_createFragment_validObject() {
  const core = await importWithOverride(path.join(tempDir, "create.jsonl"));

  const fragment = core.createFragment("Test content", "user", "Test Title", "myproject");

  assert(fragment.id, "Should have id");
  assert.strictEqual(fragment.title, "Test Title", "Should have correct title");
  assert.strictEqual(fragment.fragment, "Test content", "Should have correct fragment text");
  assert.strictEqual(fragment.project, "myproject", "Should have correct project");
  assert.strictEqual(fragment.source, "user", "Should have correct source");
  assert.strictEqual(fragment.confidence, 1.0, "Should start with confidence 1.0");
  assert.strictEqual(fragment.accessed, 0, "Should start with accessed 0");
  assert(fragment.created, "Should have created date");
  assert(fragment.lastAccessed, "Should have lastAccessed date");
  assert(fragment.id.startsWith("m"), "ID should start with 'm'");
}

// Test 9: createFragment - auto title generation
async function test_createFragment_autoTitle() {
  const core = await importWithOverride(path.join(tempDir, "autotitle.jsonl"));

  // Short fragment - title should be full text
  const shortFragment = core.createFragment("Short text", "ai", null, null);
  assert.strictEqual(shortFragment.title, "Short text", "Short text should be full title");
  assert.strictEqual(shortFragment.project, null, "Should have null project");

  // Long fragment - title should be truncated
  const longText = "This is a very long fragment that exceeds the forty character limit for auto title generation";
  const longFragment = core.createFragment(longText, "ai", null, "testproject");
  assert(longFragment.title.endsWith("..."), "Long title should end with ellipsis");
  assert.strictEqual(longFragment.title.length, 43, "Long title should be 40 chars + '...'");
  assert.strictEqual(longFragment.project, "testproject", "Should have project set");
}

// Test 10: filterByProject - correct filtering
async function test_filterByProject_correctFiltering() {
  const core = await importWithOverride(path.join(tempDir, "filter.jsonl"));
  const now = new Date().toISOString();

  const fragments = [
    { id: "m001", fragment: "Global 1", project: null, confidence: 1.0, created: now, lastAccessed: now },
    { id: "m002", fragment: "Global 2", project: undefined, confidence: 1.0, created: now, lastAccessed: now },
    { id: "m003", fragment: "Project A", project: "projectA", confidence: 1.0, created: now, lastAccessed: now },
    { id: "m004", fragment: "Project B", project: "projectB", confidence: 1.0, created: now, lastAccessed: now },
  ];

  // Filter for projectA - should get global + projectA
  const filteredA = core.filterByProject(fragments, "projectA");
  assert.strictEqual(filteredA.length, 3, "Should have 3 fragments for projectA");
  assert(filteredA.every(f => f.project === null || f.project === undefined || f.project === "projectA"));

  // Filter for projectB - should get global + projectB
  const filteredB = core.filterByProject(fragments, "projectB");
  assert.strictEqual(filteredB.length, 3, "Should have 3 fragments for projectB");

  // No project context - should get only global
  const filteredNone = core.filterByProject(fragments, null);
  assert.strictEqual(filteredNone.length, 2, "Should have 2 global fragments");
}

// Test 11: searchAndSortFragments - search and top-k truncating
async function test_searchAndSortFragments_searchAndSort() {
  const core = await importWithOverride(path.join(tempDir, "search.jsonl"));
  const now = new Date().toISOString();

  const fragments = [
    { id: "m001", title: "Apple", fragment: "The apple is red", confidence: 1.0, created: now, lastAccessed: now },
    { id: "m002", title: "Banana", fragment: "The banana is yellow", confidence: 1.0, created: now, lastAccessed: now },
    { id: "m003", title: "Apple 2", fragment: "A green apple", confidence: 0.8, created: now, lastAccessed: now },
    { id: "m004", title: "Orange", fragment: "Oranges are orange", confidence: 1.0, created: now, lastAccessed: now },
  ];

  // Empty search should return all via default TopK
  const allResults = core.searchAndSortFragments(fragments, null, 10);
  assert.strictEqual(allResults.length, 4, "Empty search should return all");

  // Search for apple should rank apples highest
  const appleResults = core.searchAndSortFragments(fragments, "apple", 10);
  assert.strictEqual(appleResults.length, 2, "Should find 2 apples");
  assert.strictEqual(appleResults[0].id, "m001", "Red apple has higher confidence so should be first");

  // Limit top K
  const top1Result = core.searchAndSortFragments(fragments, "apple", 1);
  assert.strictEqual(top1Result.length, 1, "Should truncate to top 1");
}

// Test 12: findSimilarFragment - similarity matching
async function test_findSimilarFragment_matching() {
  const core = await importWithOverride(path.join(tempDir, "similarity.jsonl"));
  const now = new Date().toISOString();

  const fragments = [
    { id: "m001", title: "Config", fragment: "User uses dark mode theme", project: null, confidence: 1.0, created: now, lastAccessed: now },
  ];

  // Exact match
  const exact = core.findSimilarFragment(fragments, "User uses dark mode theme", null);
  assert.strictEqual(exact.id, "m001", "Exact text should match");

  // Close match
  const close = core.findSimilarFragment(fragments, "User prefers a dark mode theme", null);
  assert.strictEqual(close.id, "m001", "Close text should match");

  // Unrelated
  const unrelated = core.findSimilarFragment(fragments, "User likes pizza", null);
  assert.strictEqual(unrelated, null, "Unrelated text should not match");
}

// ============================================
// SKILLS TESTS
// ============================================

// Import skills module with path override
async function importSkillsWithOverride(skillsFilePath) {
  const tempModulePath = path.join(tempDir, `skills-core-${Date.now()}.mjs`);
  const originalCode = await fs.readFile(
    path.join(__dirname, "skills-core.js"),
    "utf-8"
  );

  const normalizedPath = skillsFilePath.replace(/\\/g, "/");
  const modifiedCode = originalCode.replace(
    /const SKILLS_FILE = path\.join\(MEMORY_DIR, "skills\.jsonl"\);/,
    `const SKILLS_FILE = "${normalizedPath}";`
  );

  await fs.writeFile(tempModulePath, modifiedCode);
  return import(pathToFileURL(tempModulePath).href);
}

// Test: createSkill creates valid object
async function test_skills_createSkill() {
  const skills = await importSkillsWithOverride(path.join(tempDir, "skills-create.jsonl"));
  const skill = skills.createSkill("React", "Frontend", ["hooks", "jsx"], ["useCallback önemli"]);
  
  assert.ok(skill.id.startsWith("s"), "ID should start with 's'");
  assert.strictEqual(skill.skill, "react", "Skill name should be lowercase");
  assert.strictEqual(skill.category, "frontend", "Category should be lowercase");
  assert.strictEqual(skill.usage_count, 1, "Initial usage count should be 1");
  assert.strictEqual(skill.contexts.length, 2, "Should have 2 contexts");
  assert.strictEqual(skill.learnings.length, 1, "Should have 1 learning");
}

// Test: practiceSkill increments usage
async function test_skills_practiceSkill() {
  const skills = await importSkillsWithOverride(path.join(tempDir, "skills-practice.jsonl"));
  const allSkills = [];
  
  // First practice creates skill
  const skill1 = skills.practiceSkill(allSkills, "React", "frontend");
  assert.strictEqual(skill1.usage_count, 1, "First practice should set usage to 1");
  
  // Second practice increments
  const skill2 = skills.practiceSkill(allSkills, "React", "frontend");
  assert.strictEqual(skill2.usage_count, 2, "Second practice should increment to 2");
  assert.strictEqual(allSkills.length, 1, "Should still be 1 skill");
}

// Test: practiceSkill merges contexts and learnings
async function test_skills_mergeContextsLearnings() {
  const skills = await importSkillsWithOverride(path.join(tempDir, "skills-merge.jsonl"));
  const allSkills = [];
  
  // Create with initial contexts/learnings
  skills.practiceSkill(allSkills, "React", "frontend", ["hooks"], ["learning1"]);
  
  // Add more contexts/learnings
  const updated = skills.practiceSkill(allSkills, "React", "frontend", ["jsx", "hooks"], ["learning2"]);
  
  assert.strictEqual(updated.contexts.length, 2, "Should have 2 unique contexts");
  assert.strictEqual(updated.learnings.length, 2, "Should have 2 unique learnings");
  assert.ok(updated.contexts.includes("hooks"), "Should have hooks context");
  assert.ok(updated.contexts.includes("jsx"), "Should have jsx context");
}

// Test: findSkill finds by name case insensitive
async function test_skills_findSkill() {
  const skills = await importSkillsWithOverride(path.join(tempDir, "skills-find.jsonl"));
  const allSkills = [];
  skills.practiceSkill(allSkills, "React", "frontend");
  
  const found1 = skills.findSkill(allSkills, "react");
  assert.ok(found1, "Should find with lowercase");
  
  const found2 = skills.findSkill(allSkills, "REACT");
  assert.ok(found2, "Should find with uppercase");
  
  const found3 = skills.findSkill(allSkills, "Vue");
  assert.strictEqual(found3, null, "Should not find non-existent skill");
}

// Test: getTopSkills sorts by usage
async function test_skills_getTopSkills() {
  const skills = await importSkillsWithOverride(path.join(tempDir, "skills-top.jsonl"));
  const allSkills = [];
  
  skills.practiceSkill(allSkills, "React", "frontend");
  skills.practiceSkill(allSkills, "Vue", "frontend");
  skills.practiceSkill(allSkills, "Vue", "frontend");
  skills.practiceSkill(allSkills, "Angular", "frontend");
  skills.practiceSkill(allSkills, "Angular", "frontend");
  skills.practiceSkill(allSkills, "Angular", "frontend");
  
  const top = skills.getTopSkills(allSkills, 10);
  assert.strictEqual(top[0].skill, "angular", "Angular should be first (3 uses)");
  assert.strictEqual(top[1].skill, "vue", "Vue should be second (2 uses)");
  assert.strictEqual(top[2].skill, "react", "React should be third (1 use)");
}

// Setup and teardown
async function setup() {
  tempDir = path.join(os.tmpdir(), `lemma-test-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
}

async function teardown() {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
}

// Main test runner
async function runTests() {
  console.log("Setting up test environment...");
  await setup();

  console.log("\nRunning Lemma Memory System Tests\n");

  await runTest("loadMemory - empty file", test_loadMemory_emptyFile);
  await runTest("loadMemory - with fragments", test_loadMemory_withFragments);
  await runTest("saveMemory - creates directory", test_saveMemory_createsDirectory);
  await runTest("decayConfidence - reduces correctly", test_decayConfidence_reducesCorrectly);
  await runTest("decayConfidence - removes low fragments", test_decayConfidence_removesLowFragments);
  await runTest("formatMemoryForLLM - correct format", test_formatMemoryForLLM_correctFormat);
  await runTest("generateId - correct format", test_generateId_correctFormat);
  await runTest("createFragment - valid object", test_createFragment_validObject);
  await runTest("createFragment - auto title generation", test_createFragment_autoTitle);
  await runTest("filterByProject - correct filtering", test_filterByProject_correctFiltering);
  await runTest("searchAndSortFragments - search and sort", test_searchAndSortFragments_searchAndSort);
  await runTest("findSimilarFragment - matching", test_findSimilarFragment_matching);

  // Skills tests
  await runTest("skills - createSkill creates valid object", test_skills_createSkill);
  await runTest("skills - practiceSkill increments usage", test_skills_practiceSkill);
  await runTest("skills - practiceSkill merges contexts and learnings", test_skills_mergeContextsLearnings);
  await runTest("skills - findSkill finds by name case insensitive", test_skills_findSkill);
  await runTest("skills - getTopSkills sorts by usage", test_skills_getTopSkills);

  console.log("\n" + "=".repeat(50));
  console.log(`Tests passed: ${passed}`);
  console.log(`Tests failed: ${failed}`);
  console.log("=".repeat(50));

  await teardown();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error("Test runner error:", error);
  process.exit(1);
});
