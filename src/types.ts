export type FragmentType = "fact" | "pattern" | "lesson" | "warning" | "context";

export interface MemoryRelation {
  id: string;
  type: "contradicts" | "supersedes" | "superseded_by" | "supports" | "related_to";
  note?: string;
  created: string;
}

export interface MemoryFragment {
  id: string;
  title: string;
  description: string;
  fragment: string;
  project: string | null;
  confidence: number;
  source: "user" | "ai";
  created: string;
  lastAccessed: string;
  accessed: number;
  tags: string[];
  associatedWith: string[];
  relations: MemoryRelation[];
  negativeHits: number;
  quality_score: number | null;
  refinement_count: number;
  parent_id: string | null;
  child_ids: string[];
  session_id: string | null;
  task_type: string | null;
  outcome: string | null;
  positive_feedback: number;
  negative_feedback: number;
  last_refined: string | null;
  type: FragmentType;
  related_guides: string[];
  distill_candidate?: boolean;
}

export interface Guide {
  id: string;
  guide: string;
  category: string;
  description: string;
  usage_count: number;
  last_used: string;
  contexts: string[];
  learnings: string[];
  success_count: number;
  failure_count: number;
  auto_usage_count: number;
  anti_patterns: string[];
  known_pitfalls: string[];
  last_refined: string | null;
  depends_on: string[];
  enables: string[];
  superseded_by: string | null;
  deprecated: boolean;
  source_memories: string[];
  validated_by: string[];
}

export interface Session {
  id: string;
  session_id: string;
  timestamp: string;
  task_type: string;
  technology: string;
  guides_used: string[];
  memories_read: string[];
  memories_created: string[];
  task_outcome: string | null;
  refinement_attempts: number;
  self_critique_count: number;
  initial_approach: string | null;
  final_approach: string | null;
  approach_changed: boolean;
  lessons: string[];
  attempts?: Attempt[];
  status: "active" | "completed" | "abandoned";
  completed_at?: string;
  project: string | null;
}

export type AttemptOutcome = "rejected" | "partial" | "promising";

export interface Attempt {
  session_id: string;
  seq: number;
  approach: string;
  rationale: string | null;
  outcome: AttemptOutcome;
  critique: string | null;
  related_memory_id: number | null;
  confidence: number;
  last_accessed_at: string | null;
  access_count: number;
  created_at: string;
}

export type SuggestionStatus = "offered" | "accepted" | "dismissed";

export interface ImprovementSuggestion {
  id: number;
  session_id: string | null;
  suggestion: string;
  status: SuggestionStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface VirtualSession {
  id: string;
  started_at: string;
  tool_calls: ToolCallEntry[];
  project: string | null;
  technologies_seen: Set<string>;
  guides_used: Set<string>;
  memories_accessed: string[];
  memories_created: string[];
}

export interface ToolCallEntry {
  tool: string;
  timestamp: string;
  args_summary: string | null;
  result_summary: string | null;
}

export interface MemoryStats {
  total: number;
  avg_confidence: number;
  by_source: Record<string, number>;
  by_project: Record<string, number>;
  low_confidence: number;
  high_confidence: number;
}

export interface AuditResult {
  total_fragments: number;
  issues_found: number;
  issues: string[];
  healthy: boolean;
}

export interface GuideSuggestion {
  guide: string;
  category: string;
  keywords: string[];
  tracked: boolean;
  usage_count: number;
  last_used: string | null;
  learnings: string[];
  contexts: string[];
  description?: string;
}

export interface SuggestResult {
  relevant: GuideSuggestion[];
  missing: GuideSuggestion[];
  suggested: GuideSuggestion[];
  summary: string;
}

export interface TaskGuideDef {
  guide: string;
  category: string;
  keywords: string[];
}

export interface LemmaConfig {
  token_budget: {
    full_content: number;
    summary_index: number;
    guides_detail: number;
    instructions: number;
    continuity: number;
  };
  injection: {
    max_full_content_fragments: number;
    max_summary_fragments: number;
    max_guides: number;
    max_guide_detail: number;
  };
  virtual_session: {
    timeout_minutes: number;
    idle_timeout_seconds: number;
  };
  decay: {
    // "linear" = today's flat −0.002/run (default, unchanged). "ebbinghaus" =
    // opt-in exponential, type-aware forgetting keyed off time-since-access.
    model: "linear" | "ebbinghaus";
    // Per-type half-lives in days for the ebbinghaus model: durable knowledge
    // (patterns, architecture context) forgets slowly; transient warnings fast.
    half_life_days: {
      fact: number;
      pattern: number;
      lesson: number;
      warning: number;
      context: number;
    };
  };
}

export interface HookContext {
  project: string | null;
  timestamp: string;
}

export interface PromptContext {
  project: string | null;
  fragments: MemoryFragment[];
  globalFragments: MemoryFragment[];
}

export type TaskOutcome = "success" | "partial" | "failure" | "abandoned";
export type TaskType =
  | "debugging"
  | "implementation"
  | "refactoring"
  | "testing"
  | "research"
  | "documentation"
  | "optimization"
  | "other";
