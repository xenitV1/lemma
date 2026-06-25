/**
 * Single source of prompt copy injected into the LLM.
 *
 * - INSTRUCTIONS_TEMPLATE: rich supporting context returned via the MCP
 *   `instructions` field (once per session). Replaces the old
 *   "Full rules in AGENTS.md" pointer.
 * - TOOL_NUDGES: short imperatives appended to tool descriptions (seen on
 *   every message, so kept lean). This is the structurally-guaranteed channel
 *   — the LLM must read tool descriptions to call tools.
 */

export const INSTRUCTIONS_TEMPLATE = `# Lemma — Persistent Memory

You start every session blank — knowledge survives only via tool calls. If you
learn something and don't save it (memory_add), it's gone permanently.

## Layers
- Memory fragments (memory_read/add): fact / pattern / lesson / warning / context.
  Confidence evolves with use.
- Guides (guide_get/distill/practice): procedural skills distilled from experience.
  Track usage + success rate.
Pipeline: experience -> memory_add -> pattern/lesson -> guide_distill -> guide_practice.

## How to work
1. RECALL: memory_read.  2. ACT.  3. PERSIST: insight -> memory_add, guide applied -> guide_practice.
Store fragments in ENGLISH (required for search). Never ask permission to save.

## Writing a fragment
## [Title] / ### Context (1-2 sentences) / ### [Content] (bullets).
One idea, 30-2000 chars. Types: fact/pattern/lesson/warning/context.

## Relations (memory_relate)
supports / contradicts / supersedes / related_to (bidirectional).

## Background intelligence
Conflict detection, suggestions (distill/merge/refine), and auto-linking run
automatically — act on signals when sensible.

## Commands
-lib -> memory_library (full snapshot). -vis -> launch visualizer.`;

export const TOOL_NUDGES: Record<string, string> = {
  session_start: "⚠️ Call this FIRST when starting a task — loads relevant context.",
  memory_read: "⚠️ ALWAYS read before acting — your past self may have solved this. Never re-explore code already in memory.",
  memory_add: "⚠️ Save new knowledge IMMEDIATELY — unsaved knowledge is lost forever. Never ask permission, just save.",
  memory_update: "When reality contradicts a memory, trust reality and update it here.",
  memory_feedback: "Give 👍 after a useful memory to boost its ranking.",
  session_end: "Call when done — record outcome (success/partial/failure) + lessons.",
  session_attempt: "⚠️ Record abandoned/partial approaches — dead ends are the MOST valuable memory (prevents repeating them).",
  suggestion_respond: "Respond to surfaced improvement suggestions — dismiss if not relevant, accept if useful (so Lemma learns your preferences).",
  guide_distill: "Promote a proven pattern/lesson into a reusable guide.",
  guide_practice: "⚠️ Always record each guide use + outcome here — it trains the guide.",
  memory_library: "User -lib -> memory_library full knowledge-base snapshot + maintenance signals.",
};
