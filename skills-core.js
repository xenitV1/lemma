// Lemma Skills Core Module
// Provides skill tracking with usage statistics and learnings for AI context

import os from "os";
import path from "path";
import fs from "fs";

const MEMORY_DIR = path.join(os.homedir(), ".lemma");
const SKILLS_FILE = path.join(MEMORY_DIR, "skills.jsonl");

/**
 * Generate a unique skill ID
 * @returns {string} ID in format "s" + 6 hex characters
 */
export function generateSkillId() {
  const hexChars = Math.random().toString(16).substring(2, 8);
  return `s${hexChars}`;
}

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string}
 */
function getToday() {
  return new Date().toISOString().split("T")[0];
}

/**
 * Create a new skill object
 * @param {string} skill - Skill name (e.g., "react", "python")
 * @param {string} category - Category (frontend, backend, tool, language, database)
 * @param {string[]} contexts - Initial contexts (optional)
 * @param {string[]} learnings - Initial learnings (optional)
 * @returns {object} Skill object
 */
export function createSkill(skill, category, contexts = [], learnings = []) {
  return {
    id: generateSkillId(),
    skill: skill.toLowerCase().trim(),
    category: category.toLowerCase().trim(),
    usage_count: 1,
    last_used: getToday(),
    contexts: contexts.map(c => c.toLowerCase().trim()).filter(Boolean),
    learnings: learnings.map(l => l.trim()).filter(Boolean)
  };
}

/**
 * Load all skills from disk
 * @returns {Array<object>} Array of skill objects, empty if file doesn't exist
 */
export function loadSkills() {
  try {
    if (!fs.existsSync(SKILLS_FILE)) {
      return [];
    }
    const content = fs.readFileSync(SKILLS_FILE, "utf-8");
    if (!content.trim()) {
      return [];
    }
    return content
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
  } catch (error) {
    console.error("Error loading skills:", error.message);
    return [];
  }
}

/**
 * Save skills to disk as JSONL
 * @param {Array<object>} skills - Array of skill objects to save
 */
export function saveSkills(skills) {
  try {
    const dir = path.dirname(SKILLS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const jsonl = skills.map(s => JSON.stringify(s)).join("\n");
    fs.writeFileSync(SKILLS_FILE, jsonl, "utf-8");
  } catch (error) {
    console.error("Error saving skills:", error.message);
    throw error;
  }
}

/**
 * Find a skill by name (case-insensitive)
 * @param {Array<object>} skills - Array of skill objects
 * @param {string} skillName - Skill name to find
 * @returns {object|null} Skill object or null if not found
 */
export function findSkill(skills, skillName) {
  const normalized = skillName.toLowerCase().trim();
  return skills.find(s => s.skill === normalized) || null;
}

/**
 * Practice (use) a skill - increment usage, update contexts/learnings
 * @param {Array<object>} skills - Array of skill objects (will be mutated)
 * @param {string} skillName - Skill name
 * @param {string} category - Category (only used if creating new)
 * @param {string[]} newContexts - Additional contexts to add
 * @param {string[]} newLearnings - Additional learnings to add
 * @returns {object} The updated or created skill
 */
export function practiceSkill(skills, skillName, category, newContexts = [], newLearnings = []) {
  let skill = findSkill(skills, skillName);
  
  if (!skill) {
    // Create new skill
    skill = createSkill(skillName, category, newContexts, newLearnings);
    skills.push(skill);
    return skill;
  }
  
  // Update existing skill
  skill.usage_count += 1;
  skill.last_used = getToday();
  
  // Merge new contexts (deduplicated, case-insensitive)
  const existingContexts = new Set(skill.contexts.map(c => c.toLowerCase()));
  for (const ctx of newContexts) {
    const normalized = ctx.toLowerCase().trim();
    if (normalized && !existingContexts.has(normalized)) {
      skill.contexts.push(normalized);
      existingContexts.add(normalized);
    }
  }
  
  // Merge new learnings (deduplicated by exact match)
  const existingLearnings = new Set(skill.learnings);
  for (const learning of newLearnings) {
    const trimmed = learning.trim();
    if (trimmed && !existingLearnings.has(trimmed)) {
      skill.learnings.push(trimmed);
      existingLearnings.add(trimmed);
    }
  }
  
  return skill;
}

/**
 * Get skills sorted by usage (most used first)
 * @param {Array<object>} skills - Array of skill objects
 * @param {number} limit - Max number to return
 * @returns {Array<object>} Sorted skills
 */
export function getTopSkills(skills, limit = 20) {
  return [...skills]
    .sort((a, b) => b.usage_count - a.usage_count)
    .slice(0, limit);
}

/**
 * Get skills filtered by category
 * @param {Array<object>} skills - Array of skill objects
 * @param {string} category - Category to filter by
 * @returns {Array<object>} Filtered skills
 */
export function getSkillsByCategory(skills, category) {
  const normalized = category.toLowerCase().trim();
  return skills.filter(s => s.category === normalized);
}

/**
 * Format skills for LLM consumption
 * @param {Array<object>} skills - Array of skill objects
 * @returns {string} Formatted string
 */
export function formatSkillsForLLM(skills) {
  if (skills.length === 0) {
    return `=== LEMMA SKILLS ===\n(no skills tracked yet)\n====================`;
  }

  const sorted = getTopSkills(skills, 30);
  
  const lines = sorted.map(skill => {
    const contextsStr = skill.contexts.length > 0 
      ? ` [${skill.contexts.slice(0, 5).join(", ")}${skill.contexts.length > 5 ? "..." : ""}]`
      : "";
    const learningsCount = skill.learnings.length > 0 
      ? ` (${skill.learnings.length} learnings)`
      : "";
    return `[${skill.category}] ${skill.skill}: ${skill.usage_count}x (last: ${skill.last_used})${contextsStr}${learningsCount}`;
  });

  return `=== LEMMA SKILLS ===\n${lines.join("\n")}\n====================`;
}

/**
 * Format a single skill detail for LLM
 * @param {object} skill - Skill object
 * @returns {string} Formatted detail string
 */
export function formatSkillDetail(skill) {
  if (!skill) {
    return "Skill not found.";
  }

  let detail = `=== SKILL: ${skill.skill} ===\n`;
  detail += `Category: ${skill.category}\n`;
  detail += `Usage Count: ${skill.usage_count}\n`;
  detail += `Last Used: ${skill.last_used}\n`;
  
  if (skill.contexts.length > 0) {
    detail += `Contexts: ${skill.contexts.join(", ")}\n`;
  }
  
  if (skill.learnings.length > 0) {
    detail += `Learnings:\n`;
    for (const l of skill.learnings) {
      detail += `  - ${l}\n`;
    }
  }
  
  detail += `====================`;
  return detail;
}
