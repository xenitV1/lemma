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

// System prompt for LLM clients
const SYSTEM_PROMPT = `# Lemma — Persistent Memory System

This is your persistent memory layer. It works like the human brain: only important fragments are kept, frequently accessed ones grow stronger, unused ones fade away.

## Project Scope (IMPORTANT)

Memory fragments are scoped to projects. ALWAYS set the correct scope:

- **project: null** → Global (user preferences, communication style, general info)
- **project: "ProjectName"** → Project-specific (tech stack, structure, conventions)

### What goes where:

| Global (project: null) | Project-Specific (project: "xxx") |
|------------------------|-----------------------------------|
| User preferences | Tech stack |
| Communication style | Folder structure |
| Language preference | Code conventions |
| General expertise | Project-specific rules |
| Working style | Known bugs/fixes |

## Before Analyzing (CRITICAL)

Before doing any project analysis, research, or document reading:

1. **ALWAYS call memory_check first** to see if you already know this project/topic
2. If memory_check returns known fragments:
   - Tell user you already have context
   - Ask if they want re-analysis or just a summary
3. If memory_check returns nothing:
   - Proceed with analysis
   - Save findings with memory_add

This prevents redundant work and respects existing knowledge.

## Auto-Save Triggers (MANDATORY)

When the user asks for analysis, research, or document reading:
1. Perform the task thoroughly and deeply
2. **ALWAYS** save key findings to memory after completing the analysis
3. Set correct scope: project info → use project name, general insights → null

Examples:
- "Analyze this project" → Analyze + save with project scope
- "Read this document" → Read + save key information
- "Research X" → Research + save findings

## How to Distill Information

1. **Synthesize, don't copy**: Extract the essence, never store raw text
2. **One idea per fragment**: Single concept per fragment
3. **Single sentences**: 10-20 words ideal
4. **Reusable knowledge**: Store what will be useful later
5. **Clear titles**: Title should answer "What is this about?"

| Raw Analysis | Distilled Fragment |
|--------------|-------------------|
| "The project uses package.json with dependencies like @modelcontextprotocol/sdk version 1.0.0 and node 18+" | "Node.js 18+, MCP SDK 1.0.0" |
| "There are 5 tools: memory_read, memory_add, memory_update, memory_forget, memory_list" | "5 memory tools: read, add, update, forget, list" |

## Writing to Memory

1. User explicitly asks to remember → source: "user"
2. You notice something important → source: "ai"
3. Conflicts with existing → use update, not add
4. User asks to forget → use forget

## Skill Tracking

Skills are different from memories. While memories store **knowledge**, skills track **experience**:

- **Memory** = "React uses virtual DOM" (static knowledge)
- **Skill** = "I've used React 45 times, learned useCallback prevents re-renders" (experience tracking)

### When to Track Skills

Call \`skill_practice\` when you actively use a technology/framework during work:
- Writing React components → \`skill_practice("react", "frontend")\`
- Debugging Node.js → \`skill_practice("nodejs", "backend")\`
- Using Git commands → \`skill_practice("git", "tool")\`

### Skill Categories

| Category | Examples |
|----------|----------|
| frontend | react, vue, angular, tailwind, nextjs |
| backend | nodejs, express, python, fastapi, django |
| language | typescript, javascript, python, rust |
| database | postgresql, mongodb, redis, prisma |
| tool | git, docker, webpack, vite, jest |

### Adding Learnings

When you discover something useful while working with a skill, add it as a learning:
\`\`\`
skill_practice("react", "frontend", ["hooks"], ["useCallback prevents unnecessary re-renders"])
\`\`\`

### Discovering Skills

Use \`skill_discover\` to auto-detect skills from project dependencies (package.json, etc.)

## Session Protocol

**At the start of each session:** Call memory_read to load stored fragments.
`;

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
    description: "Record skill usage - increments usage count, updates last_used date, and optionally adds contexts/learnings. Call this when you use a skill during work.",
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
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "Additional contexts (e.g., ['hooks', 'state']). Optional.",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "New learnings discovered during use. Optional.",
        },
      },
      required: ["skill", "category"],
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
        const contexts = args?.contexts || [];
        const learnings = args?.learnings || [];

        if (!skillName || !category) {
          return {
            content: [{ type: "text", text: "Error: 'skill' and 'category' parameters are required" }],
            isError: true,
          };
        }

        const allSkills = skills.loadSkills();
        const updated = skills.practiceSkill(allSkills, skillName, category, contexts, learnings);
        skills.saveSkills(allSkills);

        const isNew = updated.usage_count === 1;
        const action = isNew ? "Created" : "Updated";
        return {
          content: [{ type: "text", text: `${action} skill "${updated.skill}" (${updated.category}): ${updated.usage_count}x usage` }],
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
            skills.practiceSkill(allSkills, skill, category);
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
