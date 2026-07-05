interface ToolProperty {
  type: string | string[];
  description?: string;
  items?: { type: string };
  enum?: string[];
  default?: unknown;
  // Nested object schema (e.g. memory_add.evidence).
  properties?: Record<string, ToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolInputSchema {
  type: string;
  properties: Record<string, ToolProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** MCP tool annotations — hints to clients about a tool's behavior. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  outputSchema?: ToolInputSchema;
}

// Annotation presets. All lemma tools are local (single SQLite DB), so every
// tool sets openWorldHint:false. Tools differ on read-only / destructive /
// idempotent semantics — grouped into four presets below.
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DEFAULT_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS: ToolDefinition[] = [
  {
    name: "session_start",
    description: "Start a traced work session. Records task metadata and returns relevant guides and pre-loaded memories for the task.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Type of task: 'debugging', 'implementation', 'refactoring', 'testing', 'research', 'documentation', 'optimization', or 'other'",
        },
        technologies: {
          type: "array",
          items: { type: "string" },
          description: "Technologies involved (e.g., ['react', 'typescript']). Optional.",
        },
        initial_approach: {
          type: "string",
          description: "Your initial plan or approach for this task. Optional.",
        },
      },
      required: ["task_type"],
    },
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The traced session ID." },
        guides: { type: "array", items: { type: "string" }, description: "Guide names returned as relevant for the task." },
        preloaded_memories: { type: "array", items: { type: "string" }, description: "Memory fragment IDs pre-loaded into context." },
      },
    },
  },
  {
    name: "session_end",
    description: "End the current traced session. Records outcome, updates guide success/failure tracking, and generates improvement suggestions if patterns are detected.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["success", "partial", "failure", "abandoned"],
          description: "How the task turned out",
        },
        final_approach: {
          type: "string",
          description: "What approach actually worked (or didn't). Optional.",
        },
        lessons: {
          type: "array",
          items: { type: "string" },
          description: "What was learned during this session. Optional.",
        },
      },
      required: ["outcome"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        outcome_recorded: { type: "boolean", description: "Whether the outcome was recorded." },
        suggestions: { type: "array", items: { type: "string" }, description: "Generated improvement suggestions." },
      },
    },
  },
  {
    name: "session_attempt",
    description: "Record a reasoning attempt during the current task — what you tried, why, and the outcome. Captures the reasoning journey (tried/rejected hypotheses) so future sessions don't repeat dead ends. Call whenever an approach is abandoned or only partially tried. Outcome 'rejected' is the MOST valuable (it prevents repeating a dead end).",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        approach: {
          type: "string",
          description: "The approach or hypothesis you tried.",
        },
        outcome: {
          type: "string",
          enum: ["rejected", "partial", "promising"],
          description: "'rejected' = abandoned (most valuable — dead end). 'partial' = tried but incomplete. 'promising' = looks good but unproven.",
        },
        critique: {
          type: "string",
          description: "Why it failed or was abandoned (for rejected/partial). This is your self-critique and becomes the dead-end warning.",
        },
        rationale: {
          type: "string",
          description: "Why you tried it in the first place. Optional.",
        },
        related_memory_id: {
          type: "string",
          description: "A memory fragment ID this attempt built on or contradicts. Optional.",
        },
      },
      required: ["approach", "outcome"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        recorded: { type: "boolean", description: "Whether the attempt was recorded." },
        attempt_id: { type: "string", description: "ID assigned to the recorded attempt." },
      },
    },
  },
  {
    name: "suggestion_respond",
    description: "Respond to a surfaced improvement suggestion — accept it as useful or dismiss it as irrelevant. Resolves the suggestion so it stops being surfaced at session_start and teaches Lemma your preferences. Call when a suggestion is no longer relevant or you've acted on it.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The id of the improvement suggestion to respond to (as surfaced at session_start).",
        },
        action: {
          type: "string",
          enum: ["accept", "dismiss"],
          description: "'accept' = the suggestion was useful (reinforces it). 'dismiss' = not relevant (stops surfacing it).",
        },
      },
      required: ["id", "action"],
    },
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        resolved: { type: "boolean", description: "Whether the suggestion was resolved." },
        id: { type: "number", description: "The suggestion ID that was resolved." },
      },
    },
  },
  {
    name: "memory_read",
    description: "START HERE — call this FIRST at the beginning of every task to recall what you already know before doing any work (never re-derive or re-explore facts that may already be saved). Reads memory fragments. SUMMARY MODE: shows title + description only (not full content). Use id parameter to get full detail of a specific fragment. Use all=true to see fragments from all projects.",
    inputSchema: {
      additionalProperties: false,
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
        id: {
          type: "string",
          description: "Get FULL DETAIL for a specific fragment ID. Use this after seeing the summary to read the complete content.",
        },
        context: {
          type: "string",
          description: "Optional context tag for this access (e.g., 'debugging', 'refactoring'). Boosts confidence and tags the fragment for future recall.",
        },
        all: {
          type: "boolean",
          description: "If true, show fragments from all projects. Default: false (current project + global only)",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Get full details for multiple fragment IDs at once. Optional.",
        },
        minConfidence: {
          type: "number",
          description: "Minimum confidence threshold (0-1). Only return fragments with confidence >= this value. Optional.",
        },
        afterDate: {
          type: "string",
          description: "ISO date string (e.g., '2026-04-01'). Only return fragments created on or after this date. Optional.",
        },
        beforeDate: {
          type: "string",
          description: "ISO date string (e.g., '2026-04-30'). Only return fragments created on or before this date. Optional.",
        },
        limit: {
          type: "number",
          description: "Max fragments to return per page (default 30, max 100). Only applies in browse/search mode, not for id/ids. Optional.",
        },
        offset: {
          type: "number",
          description: "Number of fragments to skip for pagination (default 0). Use next_offset from the previous response to fetch the next page. Optional.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
        expand_graph: {
          type: "boolean",
          description: "When reading a specific fragment (id), also surface related fragments reachable through its relations (bounded traversal: depth ≤ 2, strongest links first). Default: false. Optional.",
        },
      },
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of fragments returned in this response." },
        fragments: { type: "array", items: { type: "object" }, description: "Matching memory fragments (summary fields, or full content for id/ids)." },
        related_graph: { type: "array", items: { type: "object" }, description: "Fragments reached via relations when expand_graph is set (id, title, depth, score)." },
        has_more: { type: "boolean", description: "Whether more results are available beyond this page." },
        next_offset: { type: ["number", "null"], description: "Offset to pass for the next page, if has_more is true. Null when there is no further page." },
      },
    },
  },
  {
    name: "memory_add",
    description:
      "MANDATORY: Call this AFTER completing analysis/research to save findings. Synthesize information into short, reusable fragments.\n\nFRAGMENT SCHEMA — always follow this structure:\n## [Topic Title]\n\n### Context\n[1-2 sentences: what and why it matters]\n\n### [Content Section]\n- [Key fact 1]\n- [Key fact 2]\n\n### Rules (optional, for patterns/warnings)\n- [Absolute constraint]\n\nRULES:\n- ALWAYS store fragments in ENGLISH regardless of conversation language. This ensures search and retrieval works correctly.\n- Title: max 80 chars, start with topic name\n- Fragment: 30-2000 chars, structured markdown, NOT plain prose\n- Every fragment MUST have a ## heading and at least one ### section\n- Type: Choose based on nature:\n  * fact = technical info, API behavior, version details\n  * pattern = repeated solution, best practice, code pattern\n  * lesson = learned from experience, mistake, debugging insight\n  * warning = caution, gotcha, pitfall to avoid\n  * context = environment info, project setup, dependencies\n- Auto-title: If you omit title, first 40 chars of fragment used\n- Auto-description: First sentence extracted from fragment",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        fragment: {
          type: "string",
          description: "The memory fragment text to store. Follow this format:\n## [Topic Title]\n[1-2 sentences of context: what and why it matters]\n- [Key fact 1]\n- [Key fact 2]\n- [Constraint or note if any]\nKeep fragments between 30-2000 characters. Use structured markdown, not plain prose.",
        },
        title: {
          type: "string",
          description: "Short title for the memory (auto-generated if not provided). Max 80 characters.",
        },
        description: {
          type: "string",
          description: "Short description/summary (auto-generated if not provided). Max 150 characters.",
        },
        project: {
          type: ["string", "null"],
          description: "Project scope. Omit to auto-file under the current project (detected from cwd). Pass 'global' or null for cross-project scope.",
        },
        source: {
          type: "string",
          description: "Source of the memory (default: 'ai')",
          default: "ai",
        },
        confirm: {
          type: "boolean",
          description: "Set to true to store fragment as-is even if secrets are detected. Default: false (auto-redacts).",
          default: false,
        },
        type: {
          type: "string",
          enum: ["fact", "pattern", "lesson", "warning", "context"],
          description: "Fragment type. 'fact'=technical info, 'pattern'=repeated solution, 'lesson'=learned from experience, 'warning'=caution/gotcha, 'context'=environment info. Default: 'fact'.",
        },
        evidence: {
          type: "object",
          additionalProperties: false,
          description: "Optional code backing for this fragment. Cite the file and the exact snippet it was derived from; an opt-in recall check later flags the fragment if that snippet drifts. Windows-safe, no embeddings.",
          properties: {
            file: { type: "string", description: "Path to the cited source file." },
            symbol: { type: "string", description: "Optional symbol/function/section label the snippet belongs to." },
            snippet: { type: "string", description: "The exact code snippet the fragment is based on (stored verbatim + SHA-256)." },
          },
          required: ["file", "snippet"],
        },
      },
      required: ["fragment"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the fragment was stored." },
        id: { type: "string", description: "ID of the newly stored fragment." },
        conflicts: { type: "array", items: { type: "object" }, description: "Detected conflicts against existing fragments, if any." },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory fragment by ID. Can update title, fragment text, confidence, or all.",
    inputSchema: {
      additionalProperties: false,
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
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the fragment was updated." },
        id: { type: "string", description: "ID of the updated fragment." },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "memory_forget",
    description: "Remove a memory fragment by ID. Pass consolidate=true to archive (down-weight, keep, reversible), or invalidate=true to hide it from recall while preserving its content and version history (reversible), instead of hard-deleting.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to remove",
        },
        consolidate: {
          type: "boolean",
          description: "If true, archive the fragment (down-weight to 0.05 so recall ignores it) instead of deleting it — non-destructive and reversible. Default false (hard delete).",
        },
        invalidate: {
          type: "boolean",
          description: "If true, logically invalidate the fragment: hidden from recall entirely but kept in the DB with its full version history, and reversible. Use for superseded/outdated facts you may want to audit later. Takes precedence over consolidate. Default false.",
        },
      },
      required: ["id"],
    },
    annotations: DESTRUCTIVE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the fragment was removed." },
        id: { type: "string", description: "ID of the removed fragment." },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "memory_feedback",
    description: "Provide feedback on a memory fragment after use. positive = the memory was useful (boosts confidence), negative = it was not helpful (reduces confidence by -0.1).",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to give feedback on",
        },
        useful: {
          type: "boolean",
          description: "true if the memory was helpful, false if it was not relevant or incorrect",
        },
      },
      required: ["id", "useful"],
    },
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether feedback was applied." },
        id: { type: "string", description: "ID of the fragment receiving feedback." },
        confidence: { type: "number", description: "The fragment's updated confidence (0-1)." },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "memory_merge",
    description: "Merge multiple memory fragments into one. You decide the merged content, this tool just executes the merge. Use when you find related/overlapping fragments that should be consolidated. Pass consolidate=true to supersede+down-weight the sources (reversible) instead of deleting them.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of fragment IDs to merge (will be deleted after merge)",
        },
        title: {
          type: "string",
          description: "Title for the merged fragment",
        },
        fragment: {
          type: "string",
          description: "The merged content you prepared",
        },
        project: {
          type: ["string", "null"],
          description: "Project scope. Omit to auto-file under the current project (detected from cwd). Pass 'global' or null for cross-project scope. Optional.",
        },
        consolidate: {
          type: "boolean",
          description: "If true, keep the source fragments but mark them superseded by the merged one and down-weight them (non-destructive, reversible) instead of deleting. Default false.",
        },
      },
      required: ["ids", "title", "fragment"],
    },
    annotations: DESTRUCTIVE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the merge succeeded." },
        id: { type: "string", description: "ID of the new merged fragment." },
        merged_ids: { type: "array", items: { type: "string" }, description: "IDs of the source fragments that were deleted." },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "memory_relate",
    description:
      "Create a typed relation between two memory fragments. Bidirectional — reverse relation auto-created.\n\nRELATION TYPES — when to use each:\n- supports: Fragment A reinforces/validates Fragment B\n- contradicts: Fragment A contradicts/invalidates Fragment B\n- supersedes: Fragment A is newer and replaces Fragment B\n- related_to: General connection between fragments\n\nWHEN TO CALL:\n- After memory_add if you know this relates to an existing fragment\n- After memory_update if content changed significantly\n- After discovering two fragments are connected during analysis",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "ID of the source fragment",
        },
        targetId: {
          type: "string",
          description: "ID of the target fragment",
        },
        type: {
          type: "string",
          enum: ["contradicts", "supersedes", "supports", "related_to"],
          description: "Type of relation",
        },
        note: {
          type: "string",
          description: "Optional note explaining the relation",
        },
      },
      required: ["sourceId", "targetId", "type"],
    },
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the relation was created." },
        relation: { type: "string", description: "The relation type that was created (bidirectional auto-reverse applied)." },
      },
      required: ["success"],
    },
  },
  {
    name: "memory_stats",
    description: "Get memory store statistics: fragment counts, average confidence, project breakdown, and health metrics.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to filter stats (optional, defaults to all projects)",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number", description: "Total fragment count." },
        avg_confidence: { type: "number", description: "Average confidence across fragments (0-1)." },
        by_source: { type: "object", description: "Fragment counts grouped by source (ai/user)." },
        by_project: { type: "object", description: "Fragment counts grouped by project." },
        low_confidence: { type: "number", description: "Count of low-confidence fragments." },
        high_confidence: { type: "number", description: "Count of high-confidence fragments." },
      },
      required: ["total"],
    },
  },
  {
    name: "memory_audit",
    description: "Audit memory store for integrity issues: orphan references, duplicate IDs, confidence anomalies.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        total_fragments: { type: "number", description: "Total fragment count scanned." },
        issues_found: { type: "number", description: "Number of integrity issues detected." },
        issues: { type: "array", items: { type: "string" }, description: "Human-readable integrity issue descriptions (orphans, duplicates, anomalies)." },
        healthy: { type: "boolean", description: "True if no issues were found." },
      },
    },
  },
  {
    name: "guide_get",
    description: "Get guides with usage statistics. Returns guides sorted by usage count (most used first). Use task parameter to get suggestions based on a task description.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (web-frontend, web-backend, dev-tool, etc.). Optional.",
        },
        guide: {
          type: "string",
          description: "Get detail for a specific guide name. Optional.",
        },
        task: {
          type: "string",
          description: "Task description to get relevant guide suggestions (e.g., 'react component with hooks', 'nodejs api'). Optional.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of guides returned." },
        guides: { type: "array", items: { type: "object" }, description: "Guides with usage statistics (sorted by usage count)." },
        guide: { type: ["object", "null"], description: "Requested guide detail in single-guide mode; null otherwise." },
      },
      required: ["count"],
    },
  },
  {
    name: "guide_practice",
    description:
      "MANDATORY: Record guide usage - increments usage count, updates last_used date, and adds contexts/learnings. Call this when you use a guide during work.\n\nTEMPLATE:\n- guide: technology/method name (e.g., \"react\", \"git\", \"seo\")\n- category: web-frontend | web-backend | dev-tool | programming-language | data-storage | ...\n- contexts: WHERE you used it (e.g., [\"hooks\", \"state\", \"effects\"])\n- learnings: WHAT you discovered (e.g., [\"useCallback prevents re-renders\"])\n\nIf guide doesn't exist, it will be auto-created.\nCall this AFTER applying knowledge from a guide or memory fragment.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Guide name (e.g., 'react', 'python', 'git')",
        },
        category: {
          type: "string",
          description: "Category: web-frontend, web-backend, dev-tool, programming-language, data-storage, etc.",
        },
        description: {
          type: "string",
          description: "Detailed description, manual, or protocols for the guide. Optional.",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: Contexts where this guide was used (e.g., ['hooks', 'state']). Provide at least one context or empty array [].",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: New learnings discovered during use (e.g., ['useCallback prevents re-renders']). Provide at least one learning or empty array [].",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Optional outcome when using this guide. Tracks success rate.",
        },
      },
      required: ["guide", "category", "contexts", "learnings"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether guide usage was recorded." },
        guide: { type: "string", description: "Name of the guide practiced." },
        usage_count: { type: "number", description: "The guide's updated usage count." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "guide_create",
    description: "Definition mode: Create a new guide with a detailed manual, mission, and protocols. Use this to establish a reusable framework for a specific technology or methodology.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Guide name (e.g., 'X Viral Growth Engine', 'TDD Workflow')",
        },
        category: {
          type: "string",
          description: "Category: web-frontend, web-backend, dev-tool, programming-language, data-storage, etc.",
        },
        description: {
          type: "string",
          description: "The full manual for this guide. Follow this schema:\n\n## [Name] — [Subtitle]\n\n### Mission\n[Single sentence: what to achieve]\n\n### Protocol\n1. **[STEP]:** [action and expected outcome]\n2. **[STEP]:** [action and expected outcome]\n...\n\n### [Optional Section]\n[Relevant tables, templates, or reference data]\n\n### Rules\n- [Absolute rule 1]\n- [Absolute rule 2]\n- [Absolute rule 3]",
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
      required: ["guide", "category", "description"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the guide was created." },
        guide: { type: "string", description: "Name of the created guide." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "guide_distill",
    description:
      "Transform a memory fragment (static fact) into a guide's learning (procedural knowledge). Use this when a learned piece of information should become part of a permanent capability.\n\nWHEN TO CALL: After memory_add with type=\"pattern\" or type=\"lesson\". These fragment types represent reusable knowledge that should be promoted to a guide.\n\nTEMPLATE:\n- memory_id: The fragment ID to distill (e.g., \"m2a5d0cde45ce\")\n- guide: Target guide name — use technology name (e.g., \"react\", \"git\")\n- category: Required only if creating a new guide\n\nThe memory and guide will be bidirectionally linked automatically.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "ID of the memory fragment to distill",
        },
        guide: {
          type: "string",
          description: "Target guide name (e.g., 'react', 'git'). If it doesn't exist, it will be created.",
        },
        category: {
          type: "string",
          description: "Category for the guide (required only if creating a new guide).",
        },
      },
      required: ["memory_id", "guide"],
    },
    annotations: DEFAULT_WRITE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the learning was distilled into the guide." },
        guide: { type: "string", description: "Target guide name." },
        memory_id: { type: "string", description: "Source fragment ID that was distilled." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "guide_update",
    description: "Update an existing guide's properties (name, category, description) and its dependency graph — which guides it depends_on and which it enables.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Current name of the guide to update",
        },
        new_name: {
          type: "string",
          description: "New name for the guide (optional)",
        },
        category: {
          type: "string",
          description: "New category for the guide (optional)",
        },
        description: {
          type: "string",
          description: "New description/manual for the guide (optional)",
        },
        add_anti_patterns: {
          type: "array",
          items: { type: "string" },
          description: "Add anti-patterns to this guide. Optional.",
        },
        add_pitfalls: {
          type: "array",
          items: { type: "string" },
          description: "Add known pitfalls to this guide. Optional.",
        },
        add_depends_on: {
          type: "array",
          items: { type: "string" },
          description: "Guide names this guide depends on (prerequisites). Merged + de-duplicated; self-references ignored. Optional.",
        },
        add_enables: {
          type: "array",
          items: { type: "string" },
          description: "Guide names this guide enables (unlocks/leads to). Merged + de-duplicated; self-references ignored. Optional.",
        },
        superseded_by: {
          type: "string",
          description: "Mark this guide as superseded by another guide name. Optional.",
        },
        deprecated: {
          type: "boolean",
          description: "Mark this guide as deprecated. Optional.",
        },
      },
      required: ["guide"],
    },
    annotations: IDEMPOTENT,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the guide was updated." },
        guide: { type: "string", description: "Name of the updated guide." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "guide_forget",
    description: "Remove a guide from the persistent database.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Name of the guide to remove",
        },
      },
      required: ["guide"],
    },
    annotations: DESTRUCTIVE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the guide was removed." },
        guide: { type: "string", description: "Name of the removed guide." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "guide_merge",
    description: "Merge multiple guides into one. You decide the merged content (description, contexts, learnings). Usage counts are summed. Use when you find overlapping guides that should be consolidated.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        guides: {
          type: "array",
          items: { type: "string" },
          description: "Array of guide names to merge (will be deleted after merge)",
        },
        guide: {
          type: "string",
          description: "Name for the merged guide",
        },
        category: {
          type: "string",
          description: "Category for the merged guide",
        },
        description: {
          type: "string",
          description: "Merged description/manual (optional, can be empty)",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "Merged contexts (optional, will auto-merge from source guides if not provided)",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "Merged learnings (optional, will auto-merge from source guides if not provided)",
        },
      },
      required: ["guides", "guide", "category"],
    },
    annotations: DESTRUCTIVE,
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "Whether the merge succeeded." },
        guide: { type: "string", description: "Name of the new merged guide." },
        merged: { type: "array", items: { type: "string" }, description: "Names of the source guides that were deleted." },
      },
      required: ["success", "guide"],
    },
  },
  {
    name: "memory_library",
    description: `Library Mode: Analyze and organize your entire memory database. Returns a comprehensive snapshot with all fragments, guides, relations, pre-computed analysis signals (stale, duplicate, orphan detection), and suggested actions. After reviewing the snapshot, use other tools (memory_merge, memory_forget, memory_update, guide_distill, memory_relate) to execute organizational changes.\n\nWHEN TO CALL:\n- Periodically to maintain a clean, well-organized knowledge base\n- When memory feels cluttered or redundant\n- After a long project with many fragments added\n- To find distill candidates that haven't been promoted to guides`,
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to analyze ALL projects.",
        },
        focus: {
          type: "string",
          enum: ["full", "stale", "duplicates", "orphans", "distill", "guides"],
          description: "Focus area. 'full' = complete snapshot (default). Other values return only relevant sections.",
        },
        limit: {
          type: "number",
          description: "Max fragments to return per page (default 50, max 200). Optional.",
        },
        offset: {
          type: "number",
          description: "Number of fragments to skip for pagination (default 0). Optional.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        fragments: { type: "array", items: { type: "object" }, description: "Memory fragments in the snapshot." },
        guides: { type: "array", items: { type: "object" }, description: "Guides in the snapshot." },
        signals: { type: "object", description: "Pre-computed analysis signals (stale, duplicate, orphan detection)." },
        relations: { type: "object", description: "Relation graph summary: total, by_type, isolated_fragment_ids, hub_fragments." },
        suggestions: { type: ["array", "null"], items: { type: "string" }, description: "Suggested organizational actions as human-readable strings (null when none)." },
        has_more: { type: "boolean", description: "Whether more fragments are available beyond this page." },
      },
    },
  },
  {
    name: "session_stats",
    description: "Get virtual session statistics: recent tool usage patterns, technologies encountered, and memory activity.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent sessions to analyze (default 10)",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        active_session: { type: ["object", "null"], description: "The currently active virtual session (tool_calls, technologies, guides_used), or null." },
        recent_sessions: { type: "array", items: { type: "object" }, description: "Recent finalized virtual sessions." },
      },
    },
  },
  {
    name: "conflict_scan",
    description: "Scan memories for contradictions. Detects opposing sentiments, negation conflicts, and contradicting claims across the knowledge base. Returns pairs of conflicting memories with overlap scores.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to scan all memories.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        conflicts: { type: "array", items: { type: "object" }, description: "Pairs of conflicting fragments with overlap scores." },
        count: { type: "number", description: "Number of conflicts detected." },
      },
      required: ["count"],
    },
  },
  {
    name: "proactive_analysis",
    description: "Run proactive intelligence analysis on the knowledge base. Detects recurring patterns, suggests guide distillation, identifies stale/isolated memories, and recommends cleanup actions. This is the autonomous intelligence layer.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to analyze all.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        suggestions: { type: "array", items: { type: "object" }, description: "Proactive intelligence suggestions (distill, merge, refine, cleanup)." },
        count: { type: "number", description: "Number of suggestions generated." },
      },
      required: ["count"],
    },
  },
  {
    name: "project_analytics",
    description: "Get cross-session analytics for a project. Tracks knowledge growth rate, skill evolution, session outcomes, and overall project health. Shows how the AI's understanding of a project has evolved over time.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to analyze. Omit to see all projects overview.",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        project: { type: ["string", "null"], description: "Project name in single-project mode; null in overview mode." },
        health_score: { type: ["number", "null"], description: "Overall project health score 0-1 in single-project mode; null in overview mode." },
        recent_insights: { type: "array", items: { type: "object" }, description: "Recent knowledge-growth and session-outcome insights (single-project mode)." },
        count: { type: ["number", "null"], description: "Number of projects in overview mode; null in single-project mode." },
        projects: { type: "array", items: { type: "object" }, description: "Per-project summaries (overview mode)." },
      },
    },
  },
  {
    name: "semantic_search",
    description: "Search memories using TF-IDF semantic similarity. Finds related memories even when different words are used. Unlike FTS5 keyword search, this understands topic similarity. Use when keyword search fails to find related knowledge.",
    inputSchema: {
      additionalProperties: false,
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The text to find semantically similar memories for.",
        },
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to search all.",
        },
        topK: {
          type: "number",
          description: "Maximum results to return per page (default 10, max 30).",
        },
        offset: {
          type: "number",
          description: "Number of results to skip for pagination (default 0). Use next_offset from the previous response to fetch the next page. Optional.",
        },
        hybrid: {
          type: "boolean",
          description: "Opt into hybrid retrieval: fuse BM25 keyword ranking with TF-IDF similarity (Reciprocal Rank Fusion), rerank by recall priority, and diversify results (MMR). Better recall on mixed keyword+concept queries. Default: false (pure TF-IDF).",
        },
        response_format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format: 'markdown' (default, human-readable) or 'json' (machine-readable structured payload). Optional.",
        },
      },
      required: ["query"],
    },
    annotations: READ_ONLY,
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array", items: { type: "object" }, description: "Semantically similar fragments with similarity scores." },
        count: { type: "number", description: "Number of results returned." },
        has_more: { type: "boolean", description: "Whether more results are available beyond this page." },
      },
      required: ["count"],
    },
  },
];
