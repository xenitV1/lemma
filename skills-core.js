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
 * @param {string} description - Detailed description or manual for the skill
 * @param {string[]} contexts - Initial contexts (optional)
 * @param {string[]} learnings - Initial learnings (optional)
 * @returns {object} Skill object
 */
export function createSkill(skill, category, description = "", contexts = [], learnings = []) {
  return {
    id: generateSkillId(),
    skill: skill.toLowerCase().trim(),
    category: category.toLowerCase().trim(),
    description: description.trim(),
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
 * @param {string} description - Description (only used if creating new or updating empty)
 * @param {string[]} newContexts - Additional contexts to add
 * @param {string[]} newLearnings - Additional learnings to add
 * @returns {object} The updated or created skill
 */
export function practiceSkill(skills, skillName, category, description = "", newContexts = [], newLearnings = []) {
  let skill = findSkill(skills, skillName);

  if (!skill) {
    // Create new skill
    skill = createSkill(skillName, category, description, newContexts, newLearnings);
    skills.push(skill);
    return skill;
  }

  // Update existing skill
  skill.usage_count += 1;
  skill.last_used = getToday();

  // Update description if it was empty and new one is provided
  if (!skill.description && description) {
    skill.description = description.trim();
  }

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
 * Skill database for task-based suggestions
 * Maps task keywords to relevant skills
 */
const TASK_SKILL_MAP = {
  // Frontend
  "frontend": [
    { skill: "html", category: "frontend", keywords: ["web", "sayfa", "ui", "arayüz"] },
    { skill: "css", category: "frontend", keywords: ["stil", "style", "tasarım", "design"] },
    { skill: "javascript", category: "language", keywords: ["js", "web", "frontend"] },
    { skill: "react", category: "frontend", keywords: ["component", "jsx", "hook", "state"] },
    { skill: "vue", category: "frontend", keywords: ["vue", "component", "template"] },
    { skill: "angular", category: "frontend", keywords: ["angular", "component", "service"] },
    { skill: "tailwind", category: "frontend", keywords: ["tailwind", "css", "utility"] },
    { skill: "typescript", category: "language", keywords: ["ts", "tip", "type", "interface"] },
  ],
  // Backend
  "backend": [
    { skill: "nodejs", category: "backend", keywords: ["node", "server", "api", "express"] },
    { skill: "express", category: "backend", keywords: ["express", "router", "middleware"] },
    { skill: "python", category: "language", keywords: ["py", "django", "flask", "fastapi"] },
    { skill: "fastapi", category: "backend", keywords: ["fastapi", "async", "python"] },
    { skill: "django", category: "backend", keywords: ["django", "orm", "python"] },
    { skill: "rest", category: "backend", keywords: ["api", "rest", "endpoint", "http"] },
    { skill: "graphql", category: "backend", keywords: ["graphql", "query", "mutation", "schema"] },
  ],
  // Database
  "database": [
    { skill: "postgresql", category: "database", keywords: ["postgres", "sql", "relational"] },
    { skill: "mongodb", category: "database", keywords: ["mongo", "nosql", "document"] },
    { skill: "redis", category: "database", keywords: ["redis", "cache", "key-value"] },
    { skill: "prisma", category: "database", keywords: ["prisma", "orm", "schema"] },
    { skill: "sqlite", category: "database", keywords: ["sqlite", "local", "embedded"] },
  ],
  // Tools
  "tool": [
    { skill: "git", category: "tool", keywords: ["git", "commit", "branch", "merge"] },
    { skill: "docker", category: "tool", keywords: ["docker", "container", "image"] },
    { skill: "webpack", category: "tool", keywords: ["webpack", "bundle", "build"] },
    { skill: "vite", category: "tool", keywords: ["vite", "build", "dev", "hmr"] },
    { skill: "jest", category: "tool", keywords: ["jest", "test", "unit", "spec"] },
    { skill: "eslint", category: "tool", keywords: ["eslint", "lint", "format"] },
  ],
  // DevOps
  "devops": [
    { skill: "ci-cd", category: "tool", keywords: ["ci", "cd", "pipeline", "github actions"] },
    { skill: "kubernetes", category: "tool", keywords: ["k8s", "kubernetes", "pod", "deployment"] },
    { skill: "aws", category: "tool", keywords: ["aws", "s3", "lambda", "ec2"] },
  ],
};

/**
 * Suggest skills based on task description
 * @param {string} taskDescription - Task/query description
 * @param {Array<object>} existingSkills - Current tracked skills
 * @returns {object} { suggested: [], missing: [], relevant: [] }
 */
export function suggestSkills(taskDescription, existingSkills = []) {
  const desc = taskDescription.toLowerCase();
  const suggestions = [];
  const seen = new Set();

  // Get all skill definitions
  const allSkillDefs = Object.values(TASK_SKILL_MAP).flat();

  // Check each skill definition against task description
  for (const skillDef of allSkillDefs) {
    if (seen.has(skillDef.skill)) continue;

    // Check if skill name or keywords match
    const matches =
      desc.includes(skillDef.skill) ||
      skillDef.keywords.some(kw => desc.includes(kw));

    if (matches) {
      seen.add(skillDef.skill);
      const existing = existingSkills.find(s => s.skill === skillDef.skill);
      suggestions.push({
        ...skillDef,
        tracked: !!existing,
        usage_count: existing?.usage_count || 0,
        last_used: existing?.last_used || null,
        learnings: existing?.learnings || [],
        contexts: existing?.contexts || [],
      });
    }
  }

  // Also check tracked skills that might not be in TASK_SKILL_MAP
  // Match by skill name and contexts
  for (const existing of existingSkills) {
    if (seen.has(existing.skill)) continue;

    // Check if skill name matches
    if (desc.includes(existing.skill)) {
      seen.add(existing.skill);
      suggestions.push({
        skill: existing.skill,
        category: existing.category,
        keywords: existing.contexts, // use contexts as keywords
        tracked: true,
        usage_count: existing.usage_count,
        last_used: existing.last_used,
        learnings: existing.learnings,
        contexts: existing.contexts,
      });
      continue;
    }

    // Check if any context matches
    if (existing.contexts.some(ctx => desc.includes(ctx))) {
      seen.add(existing.skill);
      suggestions.push({
        skill: existing.skill,
        category: existing.category,
        keywords: existing.contexts,
        tracked: true,
        usage_count: existing.usage_count,
        last_used: existing.last_used,
        learnings: existing.learnings,
        contexts: existing.contexts,
      });
    }
  }

  // Separate into categories
  const tracked = suggestions.filter(s => s.tracked);
  const missing = suggestions.filter(s => !s.tracked);

  return {
    relevant: tracked,
    missing: missing,
    suggested: suggestions,
    summary: `Found ${suggestions.length} relevant skills (${tracked.length} tracked, ${missing.length} new)`,
  };
}

/**
 * Format skill suggestions for LLM
 * @param {object} result - Result from suggestSkills
 * @returns {string} Formatted string
 */
export function formatSuggestions(result) {
  let output = `=== SKILL SUGGESTIONS ===\n`;
  output += `${result.summary}\n\n`;

  if (result.relevant.length > 0) {
    output += `TRACKED (you have experience):\n`;
    for (const s of result.relevant) {
      output += `  ✓ [${s.category}] ${s.skill} (${s.usage_count}x, last: ${s.last_used || 'n/a'})\n`;
      // Show learnings if any
      if (s.learnings && s.learnings.length > 0) {
        for (const l of s.learnings.slice(0, 3)) {
          output += `      💡 ${l}\n`;
        }
        if (s.learnings.length > 3) {
          output += `      ... and ${s.learnings.length - 3} more learnings\n`;
        }
      }
    }
    output += `\n`;
  }

  if (result.missing.length > 0) {
    output += `SUGGESTED (not tracked yet):\n`;
    for (const s of result.missing) {
      output += `  + [${s.category}] ${s.skill}\n`;
      // Show keywords as hints
      if (s.keywords && s.keywords.length > 0) {
        output += `      keywords: ${s.keywords.slice(0, 5).join(", ")}\n`;
      }
    }
    output += `\n`;
  }

  if (result.suggested.length === 0) {
    output += `No relevant skills found for this task.\n`;
    output += `Try describing the task with more specific terms.\n`;
  }

  output += `========================`;
  return output;
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

  if (skill.description) {
    detail += `\n=== DESCRIPTION / PROTOCOLS ===\n${skill.description}\n===============================\n`;
  }

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
