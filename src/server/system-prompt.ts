import type { MemoryFragment, PromptContext } from "../types.js";
import type { ToolDefinition } from "./tools.js";
import * as core from "../memory/index.js";
import * as guides from "../guides/index.js";
import { applyPromptModifiers } from "./hooks.js";
import * as core_config from "../memory/config.js";
import { redactSecrets } from "../memory/privacy.js";
import { TOOLS } from "./tools.js";
import { INSTRUCTIONS_TEMPLATE, TOOL_NUDGES } from "./prompt-content.js";
import { logger } from "../logger.js";

const BASE_SYSTEM_PROMPT = `<system_prompt>
<identity>
You are an AI assistant with persistent memory powered by Lemma.
Call memory_read to recall what you already know. Call memory_add to save new
knowledge — unsaved knowledge is lost permanently.
</identity>
</system_prompt>`;

function formatProjectContext(fragments: MemoryFragment[], projectName: string): string {
  if (!fragments || fragments.length === 0) {
    return "";
  }

  const lines = fragments.map(frag => {
    const barCount = Math.round(frag.confidence / 0.2);
    const confidenceBar = "█".repeat(barCount) + "░".repeat(5 - barCount);
    const sourceIcon = frag.source === "ai" ? "🤖" : "👤";

    const summary = frag.description || frag.title;

    return `[${frag.id}] ${confidenceBar} (${sourceIcon}) ${frag.title}\n    ${summary}`;
  });

  return `<project_context>
## Project Context: ${projectName}

You have ${fragments.length} saved memory fragment(s) for this project.
Use \`memory_read\` to load full details or \`memory_read id="<id>"\` for specific fragment.

${lines.join("\n")}
</project_context>`;
}

function formatGlobalContext(fragments: MemoryFragment[]): string {
  if (!fragments || fragments.length === 0) {
    return "";
  }

  const lines = fragments.map(frag => {
    return `- **${frag.title}**: ${frag.description || frag.fragment.slice(0, 100)}`;
  });

  return `<global_knowledge>
## Global Knowledge

Cross-project learnings and preferences that apply everywhere:

${lines.join("\n")}
</global_knowledge>`;
}

function processFragments(fragments: MemoryFragment[], limit: number): MemoryFragment[] {
  if (!fragments || fragments.length === 0) return [];

  const result = [...fragments]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  logger.flow("system_prompt", "process_fragments", { input: fragments.length, output: result.length });
  return result;
}

export async function getDynamicSystemPrompt(projectName: string | null): Promise<string> {
  logger.flow("system_prompt", "build_start", { project: projectName });
  let prompt = BASE_SYSTEM_PROMPT;
  let memory: any[] = [];

  try {
    memory = core.loadMemory();
  } catch (error) {
    logger.error("Failed to load memory for system prompt", (error as Error).message);
    return prompt;
  }

  const context: PromptContext = {
    project: projectName,
    fragments: [],
    globalFragments: [],
  };

  const allFragments = projectName
    ? (core.filterByProject(memory, projectName) as MemoryFragment[])
    : (core.filterByProject(memory, null) as MemoryFragment[]);

  const globalFragmentsRaw = allFragments.filter(f => f.project === null || f.project === undefined);
  const projectFragmentsRaw = projectName
    ? allFragments.filter(f => f.project !== null && f.project !== undefined)
    : [];

  logger.flow("system_prompt", "memory_loaded", {
    totalFragments: allFragments.length,
    globalCount: globalFragmentsRaw.length,
    projectCount: projectFragmentsRaw.length,
  });

  if (globalFragmentsRaw.length > 0) {
    const sortedGlobal = processFragments(globalFragmentsRaw, 10);
    context.globalFragments = sortedGlobal;
    logger.flow("system_prompt", "global_context", { count: sortedGlobal.length });

    const globalContext = formatGlobalContext(sortedGlobal);
    prompt = prompt.replace(
      "</system_prompt>",
      `\n${globalContext}\n</system_prompt>`
    );
  }

  if (projectName) {
    if (projectFragmentsRaw.length > 0) {
      const sortedProject = processFragments(projectFragmentsRaw, 20);
      context.fragments = sortedProject;
      logger.flow("system_prompt", "project_context", { project: projectName, count: sortedProject.length });

      const projectContext = formatProjectContext(sortedProject, projectName);
      prompt = prompt.replace(
        "</system_prompt>",
        `\n${projectContext}\n</system_prompt>`
      );
    }
  }

  logger.flow("system_prompt", "applying_modifiers");
  try {
    prompt = await applyPromptModifiers(prompt, context as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error("Prompt modifiers failed in system prompt", (error as Error).message);
  }

  logger.flow("system_prompt", "build_complete", { length: prompt.length });
  return prompt;
}

export { BASE_SYSTEM_PROMPT };
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

export function buildInstructions(projectName: string | null): string {
  const cfg = core_config.loadConfig();
  const maxTokens = cfg.token_budget.instructions;

  // Static teaching template — always returned in full (never truncated).
  const instructions = INSTRUCTIONS_TEMPLATE;
  const headroom = maxTokens - core_config.estimateTokens(instructions);

  let memory: MemoryFragment[] = [];
  try {
    memory = core.loadMemory();
  } catch {
    logger.error("buildInstructions", "failed to load memory");
  }

  const globalFragments = memory.filter(f => f.project === null || f.project === undefined);
  const projectFragments = projectName
    ? memory.filter(f => f.project === projectName)
    : [];
  const totalGuides = guides.loadGuides().length;

  // Dynamic memory index — appended, trimmed ONLY within headroom.
  let index = "\n\n## Your current memory\n";

  if (globalFragments.length > 0 || projectFragments.length > 0) {
    if (projectFragments.length > 0) {
      const top = [...projectFragments]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 8);
      index += `- Project "${projectName}": ${projectFragments.length} fragments\n`;
      for (const f of top) {
        index += `  [${f.id}] ${f.title} (${f.confidence.toFixed(2)})\n`;
      }
    }
    if (globalFragments.length > 0) {
      const top = [...globalFragments]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
      index += `- Global: ${globalFragments.length} fragments\n`;
      for (const f of top) {
        index += `  [${f.id}] ${f.title} (${f.confidence.toFixed(2)})\n`;
      }
    }
    index += `\nUse memory_read to load full details of any fragment.\n`;
  } else {
    index += `You have no saved memories yet. Call memory_add to start building your knowledge base.\n`;
  }

  if (totalGuides > 0) {
    index += `\nYou have ${totalGuides} skill guide(s). Use guide_get to review them.\n`;
  }

  let result = instructions;
  if (headroom > 0) {
    const indexTokens = core_config.estimateTokens(index);
    if (indexTokens > headroom) {
      const ratio = headroom / indexTokens;
      index = index.substring(0, Math.floor(index.length * ratio));
    }
    result = instructions + index;
  } else {
    logger.warn("buildInstructions: token budget smaller than template; returning template only", { maxTokens });
  }

  logger.flow("buildInstructions", "complete", {
    project: projectName,
    globalCount: globalFragments.length,
    projectCount: projectFragments.length,
    guideCount: totalGuides,
    tokens: core_config.estimateTokens(result),
  });

  return result;
}

export async function buildInjectedTools(projectName: string | null): Promise<ToolDefinition[]> {
  const cfg = core_config.loadConfig();
  const maxFullTokens = cfg.token_budget.full_content;
  const maxSummaryTokens = cfg.token_budget.summary_index;
  const maxGuideTokens = cfg.token_budget.guides_detail;
  const maxFullCount = cfg.injection.max_full_content_fragments;
  const maxSummaryCount = cfg.injection.max_summary_fragments;
  const maxGuideCount = cfg.injection.max_guides;
  const maxGuideDetail = cfg.injection.max_guide_detail;

  let memory: MemoryFragment[] = [];
  try {
    memory = core.loadMemory();
  } catch {
    logger.error("buildInjectedTools", "failed to load memory");
  }

  let allGuides: any[] = [];
  try {
    allGuides = guides.loadGuides();
  } catch {
    logger.error("buildInjectedTools", "failed to load guides");
  }

  const globalFragments = memory.filter(f => f.project === null || f.project === undefined);
  const projectFragments = projectName
    ? memory.filter(f => f.project === projectName)
    : [];

  const allProjectFragments = [...projectFragments, ...globalFragments]
    .sort((a, b) => b.confidence - a.confidence);

  const fullContentFrags = allProjectFragments.slice(0, maxFullCount);
  const summaryFrags = allProjectFragments.slice(maxFullCount, maxFullCount + maxSummaryCount);

  const activeGuides = [...allGuides]
    .filter((g: any) => !g.deprecated && !g.superseded_by)
    .sort((a: any, b: any) => b.usage_count - a.usage_count)
    .slice(0, maxGuideCount);

  let injection = "\n\n---\nYOUR PERSISTENT MEMORY (injected automatically):\n\n";

  if (fullContentFrags.length > 0) {
    let fullText = "";
    let fullTokenBudget = maxFullTokens;

    for (const f of fullContentFrags) {
      let fragmentText = f.fragment;
      fragmentText = redactSecrets(fragmentText).redacted;
      const entry = `[${f.id}] ${f.title} (${f.confidence.toFixed(2)}, ${f.source})\n${fragmentText}\n\n`;
      const entryTokens = core_config.estimateTokens(entry);
      if (fullTokenBudget - entryTokens < 0) break;
      fullText += entry;
      fullTokenBudget -= entryTokens;
    }

    if (fullText) {
      injection += `== FULL MEMORY CONTENT ==\n${fullText}`;
    }
  }

  if (summaryFrags.length > 0) {
    let summaryText = "";
    let summaryTokenBudget = maxSummaryTokens;

    for (const f of summaryFrags) {
      const entry = `[${f.id}] ${f.title} — ${f.description || "(no description)"} (${f.confidence.toFixed(2)})\n`;
      const entryTokens = core_config.estimateTokens(entry);
      if (summaryTokenBudget - entryTokens < 0) break;
      summaryText += entry;
      summaryTokenBudget -= entryTokens;
    }

    if (summaryText) {
      injection += `== MEMORY INDEX (use memory_read id="<id>" for details) ==\n${summaryText}\n`;
    }
  }

  if (activeGuides.length > 0) {
    let guideText = "";
    let guideTokenBudget = maxGuideTokens;
    const detailCount = maxGuideDetail;

    for (const g of activeGuides) {
      const learnings = (g.learnings || []).slice(0, detailCount);
      const entry = `[guide: ${g.guide}] (${g.category}, used ${g.usage_count}x, success ${g.success_count}/${g.success_count + g.failure_count})` +
        (learnings.length > 0 ? `\n  Learnings: ${learnings.join("; ")}` : "") + "\n";
      const entryTokens = core_config.estimateTokens(entry);
      if (guideTokenBudget - entryTokens < 0) break;
      guideText += entry;
      guideTokenBudget -= entryTokens;
    }

    if (guideText) {
      injection += `== ACTIVE GUIDES (use guide_get guide="<name>" for details) ==\n${guideText}\n`;
    }
  }

  if (fullContentFrags.length === 0 && summaryFrags.length === 0 && activeGuides.length === 0) {
    injection += "No memories yet. Use memory_add to start building your knowledge base.\n";
  }

  injection += `---\nCall memory_read to search your memories. Call memory_add to save new knowledge.\n`;

  const clonedTools: ToolDefinition[] = TOOLS.map(tool => {
    const nudge = TOOL_NUDGES[tool.name];
    const baseDescription = nudge ? `${tool.description}\n${nudge}` : tool.description;
    return {
      name: tool.name,
      description: baseDescription,
      inputSchema: {
        type: tool.inputSchema.type,
        properties: { ...tool.inputSchema.properties },
        required: tool.inputSchema.required ? [...tool.inputSchema.required] : undefined,
        additionalProperties: tool.inputSchema.additionalProperties,
      },
      ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
      ...(tool.outputSchema ? {
        outputSchema: {
          type: tool.outputSchema.type,
          properties: { ...tool.outputSchema.properties },
          required: tool.outputSchema.required ? [...tool.outputSchema.required] : undefined,
        },
      } : {}),
    };
  });

  const memoryReadIdx = clonedTools.findIndex(t => t.name === "memory_read");
  if (memoryReadIdx >= 0) {
    clonedTools[memoryReadIdx] = {
      ...clonedTools[memoryReadIdx],
      description: clonedTools[memoryReadIdx].description + injection,
    };
  }

  logger.flow("buildInjectedTools", "complete", {
    project: projectName,
    fullCount: fullContentFrags.length,
    summaryCount: summaryFrags.length,
    guideCount: activeGuides.length,
    injectionTokens: core_config.estimateTokens(injection),
  });

  return clonedTools;
}
