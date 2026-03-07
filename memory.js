#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as core from "./memory-core.js";
import * as skills from "./skills-core.js";

// System prompt for LLM clients (optimized based on Anthropic prompt engineering best practices)
const SYSTEM_PROMPT = `<system_prompt>
<intro>
# Lemma — Persistent Memory System
Your persistent memory layer. Works like the human brain: important fragments are kept, frequently accessed ones grow stronger, unused ones fade away.
</intro>

<core_workflow>
## Core Workflow (FOLLOW THIS ORDER)
1. **Session start** → Call memory_read
2. **Before analysis** → Call memory_check (prevents redundant work)
3. **After analysis** → Call memory_add (save distilled findings)
</core_workflow>

<scope_rules>
## Scope Rules (CRITICAL)
| Scope | Use For | Example |
|-------|---------|---------|
| project: null | Global preferences | "User prefers dark mode" |
| project: "Name" | Project-specific | "Lemma uses Node.js 18+" |
</scope_rules>

<distillation_examples>
## Distillation Examples
<example>
Raw: "The project uses package.json with dependencies like @modelcontextprotocol/sdk version 1.0.0"
Distilled: "MCP SDK 1.0.0, Node.js 18+"
</example>
<example>
Raw: "There are 5 tools for memory: memory_read, memory_add, memory_update, memory_forget, memory_list"
Distilled: "5 memory tools: read, add, update, forget, list"
</example>
</distillation_examples>

<skill_tracking>
## Skill Tracking
**Memory vs Skill:**
- Memory = static knowledge ("React uses virtual DOM")
- Skill = experience tracking ("Used React 45x, learned useCallback prevents re-renders")

**When using a technology:**
\`\`\`
skill_practice({ skill: "react", category: "frontend", contexts: ["hooks"], learnings: [] })
\`\`\`

**Categories:** frontend | backend | language | database | tool

**For skill suggestions:** Use skill_suggest tool (NOT file search!)
</skill_tracking>

<session_protocol>
**Start of session:** Call memory_read to load fragments.
</session_protocol>
</system_prompt>`;

// Create MCP server instance
const server = new Server(
  {
    name: "lemma",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: "memory_read",
    description: "Read and return formatted memory fragments for LLM consumption. Applies confidence decay, limits to top-K, and reformats for optimum context.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to filter (optional, defaults to detected project)",
        },
        query: {
          type: "string",
          description: "Optional semantic search keyword. Supply only if you are looking for specific context.",
        },
      },
    },
  },
  {
    name: "memory_check",
    description: "MANDATORY: Call this BEFORE any analysis, research, or document reading. Checks if project/topic already exists in memory. Prevents redundant work.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to check (optional, defaults to detected project)",
        },
      },
    },
  },
  {
    name: "memory_add",
    description: "MANDATORY: Call this AFTER completing analysis/research to save findings. Synthesize information into short, reusable fragments.",
    inputSchema: {
      type: "object",
      properties: {
        fragment: {
          type: "string",
          description: "The memory fragment text to store",
        },
        title: {
          type: "string",
          description: "Short title for the memory (auto-generated if not provided)",
        },
        project: {
          type: "string",
          description: "Project scope (null = global, string = project-specific). Use current project name for project-specific info.",
          default: null,
        },
        source: {
          type: "string",
          description: "Source of the memory (default: 'ai')",
          default: "ai",
        },
      },
      required: ["fragment"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory fragment by ID. Can update title, fragment text, confidence, or all.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to update",
        },
        title: {
          type: "string",
          description: "New title text (optional)",
        },
        fragment: {
          type: "string",
          description: "New fragment text (optional)",
        },
        confidence: {
          type: "number",
          description: "New confidence value 0-1 (optional)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_forget",
    description: "Remove a memory fragment by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to remove",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_list",
    description: "List memory fragments in JSON format. By default shows only current project + global. Use all=true to see all projects.",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "If true, show all fragments from all projects. Default: false (current project only)",
        },
      },
    },
  },
  {
    name: "skill_get",
    description: "Get all tracked skills with usage statistics. Returns skills sorted by usage count (most used first).",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (frontend, backend, tool, language, database). Optional.",
        },
        skill: {
          type: "string",
          description: "Get detail for a specific skill name. Optional.",
        },
      },
    },
  },
  {
    name: "skill_practice",
    description: "MANDATORY: Record skill usage - increments usage count, updates last_used date, and adds contexts/learnings. Call this when you use a skill during work. Both contexts and learnings are REQUIRED.",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "Skill name (e.g., 'react', 'python', 'git')",
        },
        category: {
          type: "string",
          description: "Category: frontend, backend, tool, language, database",
        },
        description: {
          type: "string",
          description: "Detailed description, manual, or protocols for the skill. Optional.",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: Contexts where this skill was used (e.g., ['hooks', 'state']). Provide at least one context or empty array [].",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: New learnings discovered during use (e.g., ['useCallback prevents re-renders']). Provide at least one learning or empty array [].",
        },
      },
      required: ["skill", "category", "contexts", "learnings"],
    },
  },
  {
    name: "skill_create",
    description: "Definition mode: Create a new skill with a detailed manual, mission, and protocols. Use this to establish a reusable framework for a specific technology or methodology.",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "Skill name (e.g., 'X Viral Growth Engine', 'TDD Workflow')",
        },
        category: {
          type: "string",
          description: "Category: frontend, backend, tool, language, database",
        },
        description: {
          type: "string",
          description: "The full manual, protocols, mission, and templates for this skill.",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "Initial contexts (optional).",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "Initial learnings (optional).",
        },
      },
      required: ["skill", "category", "description"],
    },
  },
  {
    name: "skill_discover",
    description: "Auto-discover skills from current project by analyzing package.json, config files, and file extensions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "skill_suggest",
    description: "Suggest relevant skills based on a task description. Analyzes the task and returns matching skills - both tracked (with experience) and untracked (new suggestions). Use this when user asks 'hangi skiller gerekli', 'uygun skiller var mı', or starting a new task.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description to analyze for skill suggestions (e.g., 'react component with hooks', 'nodejs api development', 'python data analysis')",
        },
      },
      required: ["task"],
    },
  },
];

// Register list tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Register list resources handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "lemma://system-prompt",
        name: "Lemma System Prompt",
        description: "System prompt for LLM clients using Lemma memory",
        mimeType: "text/markdown",
      },
      {
        uri: "lemma://memory",
        name: "Memory Fragments",
        description: "Current memory fragments (raw JSON)",
        mimeType: "application/json",
      },
      {
        uri: "lemma://skills",
        name: "Skills Database",
        description: "Tracked skills with usage statistics (raw JSON)",
        mimeType: "application/json",
      },
    ],
  };
});

// Register read resource handler
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "lemma://system-prompt") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: SYSTEM_PROMPT,
        },
      ],
    };
  }

  if (uri === "lemma://memory") {
    const memory = core.loadMemory();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(memory, null, 2),
        },
      ],
    };
  }

  if (uri === "lemma://skills") {
    const allSkills = skills.loadSkills();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(allSkills, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Register call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "memory_read": {
        const currentProject = args?.project || core.detectProject();
        const query = args?.query || null;

        let memory = core.loadMemory();
        memory = core.decayConfidence(memory);
        memory = core.filterByProject(memory, currentProject);

        // Execute Search and Top-K Truncation
        memory = core.searchAndSortFragments(memory, query, 30);

        const formatted = core.formatMemoryForLLM(memory, currentProject);
        core.saveMemory(core.loadMemory()); // Save decayed full memory
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "memory_check": {
        const project = args?.project || core.detectProject();
        const memory = core.loadMemory();
        const filtered = core.filterByProject(memory, project);

        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: `No memory found for: ${project}\nProceed with analysis and save findings.` }],
          };
        }

        const summary = filtered.map(f => `[${f.id}] ${f.title}`).join("\n");
        return {
          content: [{ type: "text", text: `Found ${filtered.length} fragments for "${project}":\n${summary}\n\nYou already have context. Ask user if they want re-analysis or summary.` }],
        };
      }

      case "memory_add": {
        const fragment = args?.fragment;
        const title = args?.title || null;
        // null = global, undefined = auto-detect, string = project-specific
        const project = args?.project === undefined ? null : args.project;
        const source = args?.source || "ai";

        if (!fragment || typeof fragment !== "string") {
          return {
            content: [{ type: "text", text: "Error: 'fragment' parameter is required and must be a string" }],
            isError: true,
          };
        }

        const memory = core.loadMemory();

        // --- Duplication Prevention Feature ---
        const similarMatch = core.findSimilarFragment(memory, fragment, project);
        if (similarMatch && source === "ai") {
          return {
            content: [{
              type: "text",
              text: `Error: A highly similar memory already exists. Please use the 'memory_update' tool on ID [${similarMatch.id}] instead of adding a new one.\nExisting Memory Title: "${similarMatch.title}"\nExisting Content: "${similarMatch.fragment}"`
            }],
            isError: true,
          };
        }

        const newFragment = core.createFragment(fragment, source, title, project);
        memory.push(newFragment);
        core.saveMemory(memory);

        const scopeInfo = newFragment.project ? ` (project: ${newFragment.project})` : " (global)";
        return {
          content: [{ type: "text", text: `Added fragment [${newFragment.id}]${scopeInfo}: "${newFragment.title}"` }],
        };
      }

      case "memory_update": {
        const id = args?.id;
        const title = args?.title;
        const fragment = args?.fragment;
        const confidence = args?.confidence;

        if (!id || typeof id !== "string") {
          return {
            content: [{ type: "text", text: "Error: 'id' parameter is required and must be a string" }],
            isError: true,
          };
        }

        const memory = core.loadMemory();
        const targetIndex = memory.findIndex((f) => f.id === id);

        if (targetIndex === -1) {
          return {
            content: [{ type: "text", text: `Error: Fragment with ID '${id}' not found` }],
            isError: true,
          };
        }

        if (title !== undefined) {
          if (typeof title !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'title' must be a string" }],
              isError: true,
            };
          }
          memory[targetIndex].title = title;
        }

        if (fragment !== undefined) {
          if (typeof fragment !== "string") {
            return {
              content: [{ type: "text", text: "Error: 'fragment' must be a string" }],
              isError: true,
            };
          }
          memory[targetIndex].fragment = fragment;
          memory[targetIndex].accessed++;
        }

        if (confidence !== undefined) {
          if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
            return {
              content: [{ type: "text", text: "Error: 'confidence' must be a number between 0 and 1" }],
              isError: true,
            };
          }
          memory[targetIndex].confidence = confidence;
        }

        core.saveMemory(memory);

        return {
          content: [{ type: "text", text: `Updated fragment [${id}]: "${memory[targetIndex].title}"` }],
        };
      }

      case "memory_forget": {
        const id = args?.id;

        if (!id || typeof id !== "string") {
          return {
            content: [{ type: "text", text: "Error: 'id' parameter is required and must be a string" }],
            isError: true,
          };
        }

        const memory = core.loadMemory();
        const initialLength = memory.length;
        const filtered = memory.filter((f) => f.id !== id);

        if (filtered.length === initialLength) {
          return {
            content: [{ type: "text", text: `Error: Fragment with ID '${id}' not found` }],
            isError: true,
          };
        }

        core.saveMemory(filtered);

        return {
          content: [{ type: "text", text: `Forgot fragment with ID: ${id}` }],
        };
      }

      case "memory_list": {
        const all = args?.all === true;
        const currentProject = core.detectProject();
        let memory = core.loadMemory();

        if (!all) {
          memory = core.filterByProject(memory, currentProject);
        }

        const formatted = JSON.stringify(memory, null, 2);
        const scopeInfo = all ? "(all projects)" : `(project: ${currentProject || "global"})`;
        return {
          content: [{ type: "text", text: `=== MEMORY FRAGMENTS ${scopeInfo} ===\n${formatted}` }],
        };
      }

      case "skill_get": {
        const category = args?.category || null;
        const skillName = args?.skill || null;
        const allSkills = skills.loadSkills();

        // Get specific skill detail
        if (skillName) {
          const skill = skills.findSkill(allSkills, skillName);
          return {
            content: [{ type: "text", text: skills.formatSkillDetail(skill) }],
          };
        }

        // Filter by category or get all
        const filtered = category
          ? skills.getSkillsByCategory(allSkills, category)
          : allSkills;

        const formatted = skills.formatSkillsForLLM(filtered);
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "skill_practice": {
        const skillName = args?.skill;
        const category = args?.category;
        const description = args?.description || "";
        const contexts = args?.contexts || [];
        const learnings = args?.learnings || [];

        if (!skillName || !category) {
          return {
            content: [{ type: "text", text: "Error: 'skill' and 'category' parameters are required" }],
            isError: true,
          };
        }

        const allSkills = skills.loadSkills();
        const updated = skills.practiceSkill(allSkills, skillName, category, description, contexts, learnings);
        skills.saveSkills(allSkills);

        const isNew = updated.usage_count === 1;
        const action = isNew ? "Created" : "Updated";
        return {
          content: [{ type: "text", text: `${action} skill "${updated.skill}" (${updated.category}): ${updated.usage_count}x usage` }],
        };
      }

      case "skill_create": {
        const skillName = args?.skill;
        const category = args?.category;
        const description = args?.description;
        const contexts = args?.contexts || [];
        const learnings = args?.learnings || [];

        if (!skillName || !category || !description) {
          return {
            content: [{ type: "text", text: "Error: 'skill', 'category', and 'description' parameters are required" }],
            isError: true,
          };
        }

        const allSkills = skills.loadSkills();
        const existing = skills.findSkill(allSkills, skillName);

        if (existing) {
          existing.description = description;
          skills.saveSkills(allSkills);
          return {
            content: [{ type: "text", text: `Updated manual for existing skill "${existing.skill}" (${existing.category})` }],
          };
        }

        const newSkill = skills.createSkill(skillName, category, description, contexts, learnings);
        allSkills.push(newSkill);
        skills.saveSkills(allSkills);

        return {
          content: [{ type: "text", text: `Created new manager skill "${newSkill.skill}" (${newSkill.category}) with a detailed manual.` }],
        };
      }

      case "skill_discover": {
        const fs = await import("fs");
        const path = await import("path");
        const cwd = process.cwd();
        const discovered = [];

        // Check package.json for dependencies
        const pkgPath = path.join(cwd, "package.json");
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            // Map common packages to skills
            const packageToSkill = {
              "react": { skill: "react", category: "frontend" },
              "vue": { skill: "vue", category: "frontend" },
              "angular": { skill: "angular", category: "frontend" },
              "svelte": { skill: "svelte", category: "frontend" },
              "next": { skill: "nextjs", category: "frontend" },
              "express": { skill: "express", category: "backend" },
              "fastify": { skill: "fastify", category: "backend" },
              "nestjs": { skill: "nestjs", category: "backend" },
              "koa": { skill: "koa", category: "backend" },
              "typescript": { skill: "typescript", category: "language" },
              "python": { skill: "python", category: "language" },
              "mongoose": { skill: "mongodb", category: "database" },
              "prisma": { skill: "prisma", category: "database" },
              "sequelize": { skill: "sequelize", category: "database" },
              "tailwindcss": { skill: "tailwind", category: "frontend" },
              "jest": { skill: "jest", category: "tool" },
              "vitest": { skill: "vitest", category: "tool" },
              "eslint": { skill: "eslint", category: "tool" },
              "webpack": { skill: "webpack", category: "tool" },
              "vite": { skill: "vite", category: "tool" },
              "docker": { skill: "docker", category: "tool" },
            };

            for (const [pkgName] of Object.entries(deps)) {
              const mapping = packageToSkill[pkgName];
              if (mapping) {
                discovered.push(mapping);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Register discovered skills
        const allSkills = skills.loadSkills();
        const registered = [];
        for (const { skill, category } of discovered) {
          const existing = skills.findSkill(allSkills, skill);
          if (!existing) {
            skills.practiceSkill(allSkills, skill, category, "");
            registered.push(`${skill} (${category})`);
          }
        }

        if (registered.length > 0) {
          skills.saveSkills(allSkills);
          return {
            content: [{ type: "text", text: `Discovered and registered ${registered.length} new skills:\n${registered.join("\n")}` }],
          };
        }

        return {
          content: [{ type: "text", text: "No new skills discovered. All project dependencies are already tracked." }],
        };
      }

      case "skill_suggest": {
        const task = args?.task;

        if (!task) {
          return {
            content: [{ type: "text", text: "Error: 'task' parameter is required" }],
            isError: true,
          };
        }

        const allSkills = skills.loadSkills();
        const result = skills.suggestSkills(task, allSkills);
        const formatted = skills.formatSuggestions(result);

        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool '${name}'` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now listening on stdin/stdout
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
