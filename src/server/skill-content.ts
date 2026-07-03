/**
 * SKILL.md content installed to `~/.agents/skills/lemma/SKILL.md` so that
 * clients using the open skill format (Codex, and Claude Code) load Lemma's
 * usage rules into the system prompt.
 *
 * Why this exists: Codex does NOT inject the MCP server `instructions` field
 * into the system prompt (unlike Claude Code); it only uses it as a namespace
 * tool description. The skill file is the reliable channel for Lemma's
 * "recall → act → persist" rules on Codex.
 *
 * The frontmatter `description` is the progressive-disclosure TRIGGER. On Codex
 * it is the ONLY always-visible surface: the skill body (these rules) is NOT
 * preloaded — Codex injects just this one line into the developer context and
 * expects the model to decide to open the file. So the description must itself
 * be an imperative that forces the first `memory_read`, not a passive "what this
 * is". Keep it accurate and within the 1024-char frontmatter budget.
 */
import { VERSION } from "../version.js";

/** Marker embedded in the installed file so installSkill() can detect the version. */
export const SKILL_VERSION_STAMP = `lemma:skill:v=${VERSION}`;

export function buildSkillContent(): string {
  return `---
name: lemma
description: Persistent cross-session memory for AI agents via MCP. BEFORE starting ANY task (coding, debugging, refactoring, research, docs, optimization — any language), FIRST call memory_read to load what you already know so you never re-derive or re-explore known facts. AFTER finishing, call memory_add to persist new findings and session_attempt for dead ends — unsaved knowledge is lost permanently. Distills reusable guides from experience.
---

<!-- ${SKILL_VERSION_STAMP} -->

# Lemma — Persistent Memory & Learning

Lemma is a persistent memory server for AI agents over the Model Context Protocol.
Every session starts blank — knowledge survives ONLY through tool calls. If you
learn something and don't save it (\`memory_add\`), it is gone permanently.

## Workflow
1. **RECALL** — \`memory_read\` / \`semantic_search\`: load what's already known for this
   project/task. Never re-explore code or re-derive facts that are already saved.
2. **ACT** — do the task.
3. **PERSIST** — \`memory_add\` for new insights; \`guide_practice\` for guides applied;
   \`session_attempt\` for abandoned/dead-end approaches (the most valuable records).

## Two knowledge layers
- **Memory fragments** (\`memory_read\` / \`memory_add\`): atomic facts. Types: \`fact\`,
  \`pattern\`, \`lesson\`, \`warning\`, \`context\`. Confidence evolves with use and feedback.
- **Guides** (\`guide_get\` / \`guide_distill\` / \`guide_practice\`): procedural skills
  distilled from fragments. Track usage count + success/failure rate.
Pipeline: \`experience -> memory_add -> pattern/lesson -> guide_distill -> guide_practice\`.

## Tools at a glance
- **Recall & search**: \`memory_read\`, \`semantic_search\`, \`memory_library\` (full
  snapshot + maintenance signals), \`memory_stats\`, \`memory_audit\`.
- **Write & maintain**: \`memory_add\`, \`memory_update\`, \`memory_forget\`,
  \`memory_merge\`, \`memory_relate\` (supports / contradicts / supersedes / related_to),
  \`memory_feedback\`.
- **Guides**: \`guide_get\`, \`guide_create\`, \`guide_distill\`, \`guide_practice\`,
  \`guide_update\`, \`guide_forget\`, \`guide_merge\`.
- **Sessions & reasoning**: \`session_start\`, \`session_end\`, \`session_attempt\`,
  \`session_stats\`, \`suggestion_respond\`.
- **Background intelligence**: \`conflict_scan\`, \`proactive_analysis\`,
  \`project_analytics\` (run automatically; act on signals when sensible).

## Writing a fragment
\`\`\`
## [Topic Title]
### Context
[1-2 sentences: what and why it matters]
### [Content Section]
- [Key fact 1]
- [Key fact 2]
### Rules (optional)
- [Absolute constraint]
\`\`\`
One idea per fragment, 30-2000 chars, structured markdown (not prose). **Store
fragments in ENGLISH** (required for search/retrieval). Never ask permission to save.

## Background intelligence
Conflict detection, distill/merge/refine suggestions, and auto-linking run
automatically. From the CLI, \`lemma -lib\` prints a full knowledge-base snapshot
and \`lemma -vis\` launches a visualizer.
`;
}

/** Extract the version stamp from an installed skill file, or null if absent/unparseable. */
export function parseSkillVersion(content: string): string | null {
  const m = content.match(/lemma:skill:v=(\S+)/);
  return m ? m[1] : null;
}
