import * as core from "../memory/index.js";
import * as guides from "../guides/index.js";
import * as sessions from "../sessions/index.js";
import * as virtualSession from "../sessions/virtual.js";
import { logger } from "../logger.js";
import { getDb } from "../db/database.js";
import * as store from "../db/memory-store.js";

import { collectLibrarySnapshot, formatLibrarySnapshot } from "../db/library-store.js";
import * as intel from "../intelligence/index.js";
import { redactSecrets } from "../memory/privacy.js";
import { loadConfig, estimateTokens } from "../memory/config.js";
import { buildResult, paginationMeta } from "./format.js";
import type { FragmentType, Attempt, AttemptOutcome, Session, SuggestionStatus } from "../types.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface SessionStartArgs {
  task_type?: string;
  technologies?: string[];
  initial_approach?: string;
  project?: string;
}

interface SessionEndArgs {
  outcome?: string;
  final_approach?: string;
  lessons?: string[];
}

interface SessionAttemptArgs {
  approach?: string;
  outcome?: string;
  critique?: string;
  rationale?: string;
  related_memory_id?: string;
}

interface SuggestionRespondArgs {
  id?: number;
  action?: string;
}

interface MemoryReadArgs {
  project?: string;
  query?: string;
  id?: string;
  context?: string;
  all?: boolean;
  ids?: string[];
  minConfidence?: number;
  afterDate?: string;
  beforeDate?: string;
  limit?: number;
  offset?: number;
  response_format?: "markdown" | "json";
}

interface MemoryAddArgs {
  fragment?: string;
  title?: string;
  description?: string;
  project?: string | null;
  source?: string;
  confirm?: boolean;
  type?: string;
}

interface MemoryUpdateArgs {
  id?: string;
  title?: string;
  fragment?: string;
  confidence?: number;
}

interface MemoryForgetArgs {
  id?: string;
}

interface MemoryFeedbackArgs {
  id?: string;
  useful?: boolean;
}

interface MemoryMergeArgs {
  ids?: string[];
  title?: string;
  fragment?: string;
  project?: string | null;
}

interface MemoryRelateArgs {
  sourceId?: string;
  targetId?: string;
  type?: string;
  note?: string;
}

interface MemoryStatsArgs {
  project?: string;
  response_format?: "markdown" | "json";
}

interface GuideGetArgs {
  category?: string;
  guide?: string;
  task?: string;
  response_format?: "markdown" | "json";
}

interface GuidePracticeArgs {
  guide?: string;
  category?: string;
  description?: string;
  contexts?: string[];
  learnings?: string[];
  outcome?: string;
}

interface GuideCreateArgs {
  guide?: string;
  category?: string;
  description?: string;
  contexts?: string[];
  learnings?: string[];
}

interface GuideDistillArgs {
  memory_id?: string;
  guide?: string;
  category?: string;
}

interface GuideUpdateArgs {
  guide?: string;
  new_name?: string;
  category?: string;
  description?: string;
  add_anti_patterns?: string[];
  add_pitfalls?: string[];
  superseded_by?: string;
  deprecated?: boolean;
}

interface GuideForgetArgs {
  guide?: string;
}

interface GuideMergeArgs {
  guides?: string[];
  guide?: string;
  category?: string;
  description?: string;
  contexts?: string[];
  learnings?: string[];
}

interface SessionStatsArgs {
  count?: number;
  response_format?: "markdown" | "json";
}

interface MemoryLibraryArgs {
  project?: string | null;
  focus?: "full" | "stale" | "duplicates" | "orphans" | "distill" | "guides";
  limit?: number;
  offset?: number;
  response_format?: "markdown" | "json";
}

interface ToolCallRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

let activeSessionId: string | null = null;

let _notifyChange: (() => void) | null = null;

export function resetSessionState(): void {
  activeSessionId = null;
  virtualSession.finalizeVirtualSession();
}

function resolveActiveSession(allSessions: Session[] = sessions.loadSessions()): Session | null {
  if (activeSessionId) {
    const current = sessions.findSession(allSessions, activeSessionId);
    if (current && current.status === "active") {
      return current;
    }
  }

  const persisted = sessions.findActiveSession(allSessions);
  if (persisted) {
    activeSessionId = persisted.session_id;
    return persisted;
  }

  activeSessionId = null;
  return null;
}

export function autoStartSession(project: string | null): void {
  const allSessions = sessions.loadSessions();
  const existingActive = resolveActiveSession(allSessions);
  if (existingActive) {
    logger.flow("auto_session", "start_skipped", { reason: "already_active", activeSessionId: existingActive.session_id });
    return;
  }

  const session = sessions.createSession("auto", []);
  session.initial_approach = null;
  activeSessionId = session.session_id;
  allSessions.push(session);
  sessions.saveSessions(allSessions);

  logger.flow("auto_session", "started", { session_id: session.session_id, project });
}

export function autoEndSession(vs: any): void {
  const allSessions = sessions.loadSessions();
  const session = resolveActiveSession(allSessions);
  if (!session) return;

  const toolCount = vs.duration_tool_calls || 0;
  const techs = vs.technologies || [];
  const memCreated = vs.memories_created || [];
  const guidesUsed = vs.guides_used || [];
  const project = vs.project || null;

  const outcome = memCreated.length > 0 || toolCount > 0
    ? "partial"
    : "abandoned";

  sessions.endSession(session, outcome, null, []);
  sessions.saveSessions(allSessions);
  activeSessionId = null;

  logger.flow("auto_session", "ended", {
    session_id: session.session_id,
    tool_calls: toolCount,
    techs: techs.length,
    mem_created: memCreated.length,
    guides_used: guidesUsed.length,
    project,
  });
}

function getSessionContext(): { memoriesAccessed: string[]; memoriesCreated: string[]; guidesUsed: string[] } {
  const vs = virtualSession.getCurrentVirtualSession();
  return {
    memoriesAccessed: vs ? [...vs.memories_accessed] : [],
    memoriesCreated: vs ? [...vs.memories_created] : [],
    guidesUsed: vs ? [...vs.guides_used] : [],
  };
}

function buildHookBlock(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  return "\n\nSUGGESTED ACTIONS:\n" + suggestions.map(s => `- ${s}`).join("\n");
}

export function setNotifyChange(fn: () => void): void {
  _notifyChange = fn;
  logger.debug("setNotifyChange", "notification handler registered");
}

function notifyMemoryChange(): void {
  if (_notifyChange) {
    logger.notify("memory_change", "sending");
    _notifyChange();
  }
}

function buildContinuityRecall(taskType: string, project: string | null = null): string {
  const budget = loadConfig().token_budget.continuity;

  // Layer 1 — dead ends (rejected/partial attempts from similar prior sessions).
  const recent = sessions.loadRecentAttempts({ task_type: taskType, project, limit: 15, minConfidence: 0.2 });
  const deadEnds = recent.filter(a => a.outcome === "rejected" || a.outcome === "partial");

  // Layer 2 — lessons captured at the end of completed similar sessions.
  const lessons: string[] = [];
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT s.lessons FROM sessions s
       WHERE s.status = 'completed' AND s.task_type = ? AND s.lessons IS NOT NULL
         AND (s.project = ? OR s.project IS NULL)
       ORDER BY s.ended_at DESC LIMIT 5`
    ).all(taskType, project) as { lessons: string | null }[];
    for (const r of rows) {
      if (!r.lessons) continue;
      try {
        const parsed = JSON.parse(r.lessons) as unknown;
        if (Array.isArray(parsed)) for (const l of parsed) if (typeof l === "string" && l.trim()) lessons.push(l.trim());
      } catch { /* malformed JSON — skip this session's lessons */ }
    }
  } catch (err) {
    logger.warn("continuity_recall lessons_load_failed", { error: String(err) });
  }

  // Layer 3 — warning fragments recorded for this project (or global).
  const warnings: { title: string | null; fragment: string }[] = [];
  try {
    const db = getDb();
    const rows = db.prepareCached(
      `SELECT title, fragment FROM memories
       WHERE type = 'warning' AND (project = ? OR project IS NULL)
       ORDER BY confidence DESC, access_count DESC LIMIT 5`
    ).all(project) as { title: string | null; fragment: string }[];
    warnings.push(...rows);
  } catch (err) {
    logger.warn("continuity_recall warnings_load_failed", { error: String(err) });
  }

  if (deadEnds.length === 0 && lessons.length === 0 && warnings.length === 0) return "";

  const header = `\n\n## Prior reasoning on similar ${taskType} tasks`;
  let used = estimateTokens(header);
  let block = header;

  // Dead ends (highest priority).
  if (deadEnds.length > 0) {
    const sub = "\n### Dead ends (don't repeat)";
    block += sub;
    used += estimateTokens(sub);
    for (const a of deadEnds) {
      const line = `\n- Tried: ${a.approach}. Rejected because: ${a.critique ?? "unknown"}`;
      if (used + estimateTokens(line) > budget) break; // never truncate mid-item; stop adding
      block += line;
      used += estimateTokens(line);
    }
    // Boost recalled attempts (they are relevant again) — best-effort; never break session_start.
    for (const a of deadEnds) {
      try { sessions.boostAttempt(a.session_id, a.seq, 0.015); } catch { logger.debug("continuity_recall", "boost_failed"); }
    }
  }

  // Lessons (second priority).
  if (lessons.length > 0) {
    const sub = "\n### What worked / lessons";
    if (used + estimateTokens(sub) <= budget) {
      block += sub;
      used += estimateTokens(sub);
      for (const l of lessons) {
        const line = `\n- ${l}`;
        if (used + estimateTokens(line) > budget) break;
        block += line;
        used += estimateTokens(line);
      }
    }
  }

  // Warnings (third priority).
  if (warnings.length > 0) {
    const sub = "\n### Warnings";
    if (used + estimateTokens(sub) <= budget) {
      block += sub;
      used += estimateTokens(sub);
      for (const w of warnings) {
        const text = (w.title && w.title.trim()) || (w.fragment.length > 120 ? w.fragment.slice(0, 120) + "…" : w.fragment);
        const line = `\n- ${text}`;
        if (used + estimateTokens(line) > budget) break;
        block += line;
        used += estimateTokens(line);
      }
    }
  }

  return block;
}

// Distills REPEATED dead-ends (rejected/partial attempts that recur across sessions
// with the same task_type) into the most-recently-practiced guide's known_pitfalls list.
// Uses the existing TF-IDF engine (findSemanticSimilarPairs @ >= 0.5) so a one-off
// dead-end with no prior match is never distilled (no false positives). Returns the
// list of pitfall strings actually distilled this call.
function distillRepeatedDeadEnds(session: Session): string[] {
  const distilled: string[] = [];
  const currentAttempts = sessions.loadAttemptsForSession(session.session_id).filter(a => a.outcome === "rejected" || a.outcome === "partial");
  if (currentAttempts.length === 0) return distilled;

  // Gather past rejected/partial attempts from OTHER sessions with the same task_type.
  const pastRows = getDb().prepareCached(
    `SELECT sa.approach, sa.critique FROM session_attempts sa
     JOIN sessions s ON s.id = sa.session_id
     WHERE s.id != ? AND s.task_type = ? AND sa.outcome IN ('rejected','partial')`
  ).all(session.session_id, session.task_type) as { approach: string; critique: string | null }[];

  if (pastRows.length === 0) return distilled;

  const pastTexts = pastRows.map(r => `${r.approach} ${r.critique ?? ""}`);
  const guideDb = getDb();
  for (const cur of currentAttempts) {
    const candidate = { id: cur.session_id + ":" + cur.seq, text: `${cur.approach} ${cur.critique ?? ""}` };
    // Reuse the existing TF-IDF similarity: build vectors over [candidate + past], find pairs >= 0.5.
    const corpus = [
      { id: candidate.id, title: "", fragment: candidate.text, description: "" },
      ...pastTexts.map((t, i) => ({ id: `past${i}`, title: "", fragment: t, description: "" })),
    ];
    const vectors = intel.buildVectors(corpus as any);
    const pairs = intel.findSemanticSimilarPairs(vectors, 0.5, 5);
    const matched = pairs.some(p => p.id_a === candidate.id || p.id_b === candidate.id);
    if (!matched) continue;

    // Distill into the most recently practiced guide for this session, if any.
    const guideName = session.guides_used?.[session.guides_used.length - 1];
    const guide = guideName ? guides.getGuideFromDb(guideName) : null;
    if (!guide) {
      // No guide to distill into — record a warning fragment so the repeated dead end
      // still surfaces in future recall (spec §5.3: guide-missing → warning fragment).
      try {
        const warningText = `Repeated dead end on ${session.task_type}: "${cur.approach}" fails because: ${cur.critique ?? "repeated dead end"}`;
        store.addMemory(guideDb, warningText, "ai", `Repeated dead end: ${session.task_type}`, session.project, undefined, "warning");
      } catch (err) {
        logger.warn("distillRepeatedDeadEnds warning fragment failed", { error: String(err) });
      }
      continue;
    }
    const pitfall = `Approach "${cur.approach}" fails because: ${cur.critique ?? "repeated dead end"}`;
    guide.known_pitfalls = Array.from(new Set([...(guide.known_pitfalls ?? []), pitfall]));
    guides.upsertGuideToDb(guideDb, guide);
    distilled.push(pitfall);
  }
  return distilled;
}

export async function handleSessionStart(args?: SessionStartArgs): Promise<ToolResult> {
  const taskType = args?.task_type;
  const technologies = args?.technologies || [];
  const initialApproach = args?.initial_approach || null;
  const project = args?.project || core.detectProject() || null;

  logger.flow("session_start", "start", { task_type: taskType, technologies, has_initial_approach: !!initialApproach, project });

  if (!taskType) {
    logger.warn("session_start validation failed", { reason: "missing task_type" });
    return {
      content: [{ type: "text", text: "Error: 'task_type' parameter is required" }],
      isError: true,
    };
  }

  logger.data("sessions", "load");
  const allSessions = sessions.loadSessions();
  const existing = sessions.findActiveSession(allSessions);
  if (existing) {
    logger.flow("session_start", "abandon_existing", { session_id: existing.session_id, task_type: existing.task_type });
    existing.status = "abandoned";
    existing.task_outcome = "abandoned";
  }

  const session = sessions.createSession(taskType, technologies, project);
  try {
    sessions.decayAttempts();
  } catch (err) {
    logger.warn("session_start decayAttempts failed", { error: String(err) });
  }
  session.initial_approach = initialApproach;
  activeSessionId = session.session_id;
  allSessions.push(session);
  logger.data("sessions", "save", { session_id: session.session_id, total_sessions: allSessions.length });
  sessions.saveSessions(allSessions);

  const taskDesc = [taskType, ...technologies].join(" ");
  const suggestions = guides.suggestGuides(taskDesc, guides.loadGuides());
  logger.flow("session_start", "guide_suggestions", { task_desc: taskDesc, relevant: suggestions.relevant.length, suggested: suggestions.suggested.length });

  const formattedSuggestions = guides.formatSuggestions(suggestions);

  const relevantResults = core.searchMemory(taskDesc, { limit: 3 });
  logger.flow("session_start", "preload_memories", { relevant_count: relevantResults.length });

  const db = getDb();
  for (const frag of relevantResults) {
    const row = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(frag.id) as { id: number } | undefined;
    if (row) {
      store.boostConfidence(db, row.id, 0.02);
    }
  }

  let response = `Session started: ${session.session_id} (${taskType})\n`;
  if (technologies.length > 0) {
    response += `Technologies: ${technologies.join(", ")}\n`;
  }

  if (relevantResults.length > 0) {
    response += `\nPre-loaded memories:\n`;
    for (const frag of relevantResults) {
      const scopeTag = frag.project || "global";
      response += `  [${frag.id}] [${scopeTag}] ${frag.title} (${frag.confidence.toFixed(2)})\n`;
      response += `    ${frag.description}\n`;
    }
  }

  response += `\n${formattedSuggestions}`;

  logger.flow("session_start", "complete", { session_id: session.session_id, task_type: taskType, suggestions: suggestions.relevant.length + suggestions.suggested.length, preloaded: relevantResults.length });

  const continuity = buildContinuityRecall(taskType, project);
  if (continuity) {
    response += continuity;
  }

  // Surface pending improvement suggestions from past sessions as OFFERS (consider; never enforced).
  let pendingSuggestions: { id: number; suggestion: string }[] = [];
  try {
    pendingSuggestions = sessions.loadPendingSuggestions(3).map(s => ({ id: s.id, suggestion: s.suggestion }));
  } catch (err) {
    logger.warn("session_start loadPendingSuggestions failed", { error: String(err) });
  }
  if (pendingSuggestions.length > 0) {
    response += `\n\n## Past improvement suggestions (consider; dismiss if not relevant)\n`;
    for (const s of pendingSuggestions) {
      response += `- [${s.id}] ${s.suggestion}\n`;
    }
  }

  return {
    content: [{ type: "text", text: response }],
    structuredContent: {
      session_id: session.session_id,
      guides: [...suggestions.relevant, ...suggestions.suggested].map((g: any) => g.guide ?? g.name ?? g).filter(Boolean),
      preloaded_memories: relevantResults.map((f: any) => f.id),
    },
  };
}

export async function handleSessionEnd(args?: SessionEndArgs): Promise<ToolResult> {
  const outcome = args?.outcome;
  const finalApproach = args?.final_approach || null;
  const lessons = args?.lessons || [];

  logger.flow("session_end", "start", { outcome, has_final_approach: !!finalApproach, lesson_count: lessons.length });

  if (!outcome) {
    logger.warn("session_end validation failed", { reason: "missing outcome" });
    return {
      content: [{ type: "text", text: "Error: 'outcome' parameter is required" }],
      isError: true,
    };
  }

  logger.data("sessions", "load");
  const allSessions = sessions.loadSessions();
  const session = resolveActiveSession(allSessions);

  if (!session) {
    logger.warn("session_end no active session", { activeSessionId });
    return {
      content: [{ type: "text", text: "Error: No active session to end." }],
      isError: true,
    };
  }

  logger.flow("session_end", "session_found", { session_id: session.session_id, task_type: session.task_type });

  sessions.endSession(session, outcome, finalApproach, lessons);

  const improvementLines: string[] = [];

  if (session.guides_used && session.guides_used.length > 0) {
    logger.flow("session_end", "evaluating_guides", { guides_used: session.guides_used, outcome });
    const guideDb = getDb();
    for (const guideName of session.guides_used) {
      const guide = guides.getGuideFromDb(guideName);
      if (guide) {
        if (outcome === "success") {
          guide.success_count = (guide.success_count || 0) + 1;
        } else if (outcome === "failure") {
          guide.failure_count = (guide.failure_count || 0) + 1;
          const total = (guide.success_count || 0) + (guide.failure_count || 0);
          if (total >= 3) {
            const rate = guide.success_count / total;
            if (rate < 0.4) {
              logger.warn("session_end low guide success rate", { guide: guideName, success_rate: rate.toFixed(2), total });
              improvementLines.push(`  [!] Guide "${guideName}" success rate is ${rate.toFixed(2)} (${guide.success_count}/${total}). Consider refining with guide_update.`);
            }
          }
        }
        guides.upsertGuideToDb(guideDb, guide);
      }
    }
  }

  logger.data("sessions", "save", { session_id: session.session_id, outcome });

  // Distill repeated dead-ends into guide pitfalls (best-effort; never break session_end).
  let distilledPitfalls: string[] = [];
  try {
    distilledPitfalls = distillRepeatedDeadEnds(session);
  } catch (err) {
    logger.warn("session_end distill failed", { error: String(err) });
  }

  // Persist low-success improvement lines so they can be surfaced as OFFERS at the next
  // session_start (never enforced). best-effort; never break session_end.
  for (const line of improvementLines) {
    try {
      sessions.saveImprovementSuggestion(session.session_id, line.trim());
    } catch (err) {
      logger.warn("session_end saveImprovementSuggestion failed", { error: String(err) });
    }
  }

  sessions.saveSessions(allSessions);
  activeSessionId = null;

  let response = `Session ${session.session_id} ended: ${outcome}\n`;
  response += `Task: ${session.task_type} | Duration: ${session.timestamp} → ${session.completed_at}\n`;
  if (lessons.length > 0) {
    response += `Lessons: ${lessons.length} recorded\n`;
  }
  if (improvementLines.length > 0) {
    response += `\nIMPROVEMENT SUGGESTIONS:\n${improvementLines.join("\n")}\n`;
  }
  if (distilledPitfalls.length > 0) {
    response += `\nDistilled ${distilledPitfalls.length} repeated dead-end(s) into guide pitfalls.\n`;
  }

  const sCtx = getSessionContext();
  const reviewSuggestions: string[] = [];

  if (sCtx.memoriesAccessed.length > 0 || sCtx.memoriesCreated.length > 0 || sCtx.guidesUsed.length > 0) {
    response += `\nSESSION REVIEW:`;
    if (sCtx.memoriesAccessed.length > 0) {
      response += `\n  Memories read: ${sCtx.memoriesAccessed.map(m => `[${m}]`).join(", ")}`;
    }
    if (sCtx.memoriesCreated.length > 0) {
      response += `\n  Memories created: ${sCtx.memoriesCreated.map(m => `[${m}]`).join(", ")}`;
    }
    if (sCtx.guidesUsed.length > 0) {
      response += `\n  Guides used: ${sCtx.guidesUsed.join(", ")}`;
    }
    if (session.guides_used && session.guides_used.length > 0) {
      const notPracticed = session.guides_used.filter(g => !sCtx.guidesUsed.includes(g));
      if (notPracticed.length > 0) {
        response += `\n  Guides used but NOT practiced: ${notPracticed.join(", ")}`;
      }
    }

    if (sCtx.memoriesCreated.length > 0 && sCtx.memoriesAccessed.length > 0) {
      const db = getDb();
      let relateCount = 0;
      for (const createdId of sCtx.memoriesCreated) {
        if (relateCount >= 3) break;
        const lastRead = sCtx.memoriesAccessed[sCtx.memoriesAccessed.length - 1];
        if (createdId !== lastRead) {
          const srcRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(createdId) as { id: number } | undefined;
          const tgtRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(lastRead) as { id: number } | undefined;
          if (srcRow && tgtRow) {
            store.addRelation(db, srcRow.id, tgtRow.id, "related_to", "Auto-linked: same session");
            relateCount++;
          }
        }
      }
      if (relateCount > 0) {
        response += `\nAuto-linked ${relateCount} created memories to session context.`;
      }
    }
    if (sCtx.memoriesCreated.length > 0) {
      reviewSuggestions.push(`If any created memories represent reusable skills, call guide_distill to promote them.`);
    }
    if (session.guides_used && session.guides_used.length > 0) {
      const notPracticed = session.guides_used.filter(g => !sCtx.guidesUsed.includes(g));
      if (notPracticed.length > 0) {
        reviewSuggestions.push(`Guides used but not practiced: ${notPracticed.join(", ")}. Call guide_practice to track experience.`);
      }
    }
  }

  const vs = virtualSession.getCurrentVirtualSession();
  if (vs && vs.technologies_seen && vs.technologies_seen.size > 0) {
    const techs = [...vs.technologies_seen];
    response += `\nAuto-detected technologies: ${techs.join(", ")}`;
    const matchedGuides = techs.filter(t => guides.getGuideFromDb(t));
    if (matchedGuides.length > 0) {
      response += `\nAuto-tracked guides: ${matchedGuides.join(", ")}`;
    }
  }

  response += buildHookBlock(reviewSuggestions);

  virtualSession.finalizeVirtualSession();

  logger.flow("session_end", "complete", { session_id: session.session_id, outcome, improvement_suggestions: improvementLines.length });
  return {
    content: [{ type: "text", text: response }],
    structuredContent: {
      outcome_recorded: true,
      suggestions: [...improvementLines.map(l => l.trim()), ...reviewSuggestions],
    },
  };
}

export async function handleSessionAttempt(args?: SessionAttemptArgs): Promise<ToolResult> {
  const approach = args?.approach;
  const outcome = args?.outcome;

  if (!approach || !outcome) {
    return {
      content: [{ type: "text", text: "Error: 'approach' and 'outcome' are required for session_attempt." }],
      isError: true,
    };
  }

  // Runtime-validate outcome against the enum; only AFTER this point is the
  // AttemptOutcome cast below honest (safe assertion at a checked boundary).
  if (!["rejected", "partial", "promising"].includes(outcome)) {
    return {
      content: [{ type: "text", text: "Error: 'outcome' must be one of: rejected, partial, promising." }],
      isError: true,
    };
  }

  const allSessions = sessions.loadSessions();
  const session = resolveActiveSession(allSessions);
  if (!session) {
    logger.warn("session_attempt no active session", {});
    return {
      content: [{ type: "text", text: "Error: No active session. Call session_start before recording attempts." }],
      isError: true,
    };
  }
  const sessionId = session.session_id;

  // Redact secrets from free-text fields before persisting (reuses memory/privacy.ts —
  // attempts contain reasoning that may paste in tokens/keys). rationale is short and optional; left as-is.
  const approachRedacted = redactSecrets(approach).redacted;
  const critiqueRedacted = args?.critique ? redactSecrets(args.critique).redacted : null;

  // Best-effort: a DB hiccup (CHECK/UNIQUE violation, disk error) must surface as a clean
  // tool error, not an uncaught throw that breaks the session_attempt flow. Mirrors the
  // best-effort try/catch pattern used by session_end distill and session_start decay.
  let attempt: Attempt | undefined;
  try {
    attempt = sessions.recordAttempt(sessionId, {
      approach: approachRedacted,
      outcome: outcome as AttemptOutcome,
      critique: critiqueRedacted,
      rationale: args?.rationale ?? null,
      related_memory_id: args?.related_memory_id ?? null,
    });
  } catch (err) {
    logger.warn("session_attempt recordAttempt failed", { error: String(err), session_id: sessionId });
    return {
      content: [{ type: "text", text: "Error: Could not record this attempt to the session store." }],
      isError: true,
    };
  }

  // Self-critique = articulating why a failed/partial approach fell short.
  // Promising outcomes are confirmation, not self-critique, so they don't count.
  if ((outcome === "rejected" || outcome === "partial") && args?.critique) {
    session.self_critique_count = (session.self_critique_count ?? 0) + 1;
  }
  session.refinement_attempts = (session.refinement_attempts ?? 0) + 1;
  sessions.saveSessions(allSessions);

  notifyMemoryChange();

  const valueTag = outcome === "rejected" ? "(dead end — most valuable)" : outcome === "partial" ? "(partial)" : "(promising)";
  // Echo the REDACTED approach (not the raw input) so the handler emits a single
  // secret-safe variant; truncate to keep the confirmation message short.
  const preview = approachRedacted.length > 80 ? approachRedacted.slice(0, 80) + "…" : approachRedacted;
  logger.flow("session_attempt", "recorded", { session_id: sessionId, seq: attempt?.seq, outcome });
  return {
    content: [{ type: "text", text: `Recorded attempt #${attempt?.seq} — ${preview} ${valueTag}.` }],
    structuredContent: {
      recorded: !!attempt,
      attempt_id: attempt?.seq != null ? `${sessionId}#${attempt.seq}` : "",
    },
  };
}

export async function handleSuggestionRespond(args?: SuggestionRespondArgs): Promise<ToolResult> {
  const id = args?.id;
  const action = args?.action;

  if (id === undefined || action === undefined) {
    return {
      content: [{ type: "text", text: "Error: 'id' and 'action' are required for suggestion_respond." }],
      isError: true,
    };
  }

  if (!["accept", "dismiss"].includes(action)) {
    return {
      content: [{ type: "text", text: "Error: 'action' must be one of: accept, dismiss." }],
      isError: true,
    };
  }

  logger.flow("suggestion_respond", "start", { id, action });

  // Map the tool's verb to the stored status enum value (accept -> accepted, dismiss -> dismissed).
  const status: SuggestionStatus = action === "accept" ? "accepted" : "dismissed";

  // Best-effort: a bad/missing id (or DB hiccup) must surface as a clean tool error, mirroring the
  // best-effort try/catch used by session_attempt's recordAttempt.
  try {
    sessions.updateSuggestionStatus(id, status);
  } catch (err) {
    logger.warn("suggestion_respond updateSuggestionStatus failed", { error: String(err), id, action });
    return {
      content: [{ type: "text", text: "Error: Could not update this suggestion in the store." }],
      isError: true,
    };
  }

  // On dismiss, penalize the dead-end attempts that produced this suggestion, so the same
  // failed path is de-prioritized in future recall (spec §5.4: dismiss → −0.02 confidence).
  // Best-effort: a failure here must NOT undo the successful status update above.
  if (action === "dismiss") {
    try {
      const suggestion = sessions.getSuggestion(id);
      if (suggestion?.session_id) {
        const attempts = sessions.loadAttemptsForSession(suggestion.session_id);
        for (const a of attempts) {
          if (a.outcome === "rejected" || a.outcome === "partial") {
            sessions.penalizeAttempt(suggestion.session_id, a.seq, 0.02);
          }
        }
      }
    } catch (err) {
      logger.warn("suggestion_respond dismiss penalize failed", { error: String(err), id });
    }
  }

  // On accept, boost the promising/successful attempts that produced this suggestion, reinforcing
  // the productive path in future recall (spec §5.4: accept → +0.02 confidence, mirror of dismiss).
  // Best-effort: a failure here must NOT undo the successful status update above.
  if (action === "accept") {
    try {
      const suggestion = sessions.getSuggestion(id);
      if (suggestion?.session_id) {
        const attempts = sessions.loadAttemptsForSession(suggestion.session_id);
        for (const a of attempts) {
          if (a.outcome === "promising") {
            sessions.boostAttempt(suggestion.session_id, a.seq, 0.02);
          }
        }
      }
    } catch (err) {
      logger.warn("suggestion_respond accept boost failed", { error: String(err), id });
    }
  }

  const message = action === "accept"
    ? `Accepted suggestion #${id}. It will no longer be surfaced; related promising attempts were reinforced.`
    : `Dismissed suggestion #${id}. It will no longer be surfaced; related dead ends were de-prioritized.`;
  logger.flow("suggestion_respond", "complete", { id, action });
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      resolved: true,
      id,
    },
  };
}

/**
 * Track read fragment IDs into the active formal/virtual session's `memories_read`.
 * Required so `guide_practice` validation can link guides to the memories that informed them.
 * Best-effort: never throws (memory_read must not fail because session-tracking failed).
 */
function trackReadIntoSession(readIds: string[]): void {
  if (readIds.length === 0) return;
  try {
    const allSessions = sessions.loadSessions();
    const session = resolveActiveSession(allSessions);
    if (!session) return;
    const existing = new Set(session.memories_read || []);
    let added = false;
    for (const id of readIds) {
      if (!existing.has(id)) {
        existing.add(id);
        added = true;
      }
    }
    if (!added) return;
    session.memories_read = [...existing];
    sessions.saveSessions([session]);
    logger.flow("memory_read", "session_track_read", { session_id: session.session_id, count: session.memories_read.length });
  } catch (error: unknown) {
    logger.warn("memory_read session_track_read failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleMemoryRead(args?: MemoryReadArgs): Promise<ToolResult> {
  const currentProject = args?.project || core.detectProject();
  const query = args?.query || null;
  const detailId = args?.id || null;
  const context = args?.context || null;
  const showAll = args?.all === true;

  logger.flow("memory_read", "start", { project: currentProject, query, id: detailId, ids: args?.ids?.length, all: showAll, context });

  const detailIds = args?.ids || null;
  if (detailIds && Array.isArray(detailIds) && detailIds.length > 0) {
    logger.debug("memory_read batch_ids", { ids: detailIds });
    const results: string[] = [];
    const readIds: string[] = [];
    for (const did of detailIds) {
      const fragment = core.getFragmentById(did);
      if (fragment) {
        const boosted = core.boostOnAccess(fragment, context);
        results.push(core.formatMemoryDetail(boosted));
        readIds.push(did);
      } else {
        logger.warn("memory_read batch_id not_found", { id: did });
        results.push(`Fragment [${did}] not found.`);
      }
    }
    trackReadIntoSession(readIds);
    notifyMemoryChange();
    logger.flow("memory_read", "complete_batch", { ids_requested: detailIds.length });
    return {
      content: [{ type: "text", text: results.join("\n\n") }],
      structuredContent: {
        count: readIds.length,
        fragments: readIds.map((rid: string) => ({ id: rid })),
        has_more: false,
        next_offset: null,
      },
    };
  }

  if (detailId) {
    logger.flow("memory_read", "single_id_lookup", { id: detailId });
    const fragment = core.getFragmentById(detailId);
    if (!fragment) {
      logger.warn("memory_read id not_found", { id: detailId });
      return {
        content: [{ type: "text", text: `Error: Fragment with ID '${detailId}' not found` }],
        isError: true,
      };
    }
    const boosted = core.boostOnAccess(fragment, context);
    trackReadIntoSession([detailId]);
    notifyMemoryChange();

    logger.flow("memory_read", "complete_single", { id: detailId, confidence: boosted.confidence?.toFixed(2) });
    return {
      content: [{ type: "text", text: core.formatMemoryDetail(boosted) }],
      structuredContent: {
        count: 1,
        fragments: [{ id: detailId }],
        has_more: false,
        next_offset: null,
      },
    };
  }

  // Pagination params (browse/search branch only; id/ids branches returned above).
  const limit = Math.min(Math.max(args?.limit ?? 30, 1), 100);
  const offset = Math.max(0, args?.offset ?? 0);
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  // Fetch a generous superset so offset+limit slicing has room to work. The old
  // hard 30/200 caps are gone — callers page through via limit/offset instead.
  let allResults: any[];
  if (query) {
    allResults = core.searchMemory(query, { limit: 500 });
  } else {
    allResults = core.searchMemory("", { limit: 500 });
  }
  // Apply project scope to BOTH query and browse modes (only showAll escapes it).
  // Without this, query mode returned cross-project matches and auto-linked them
  // permanently (associatedWith + related_to), causing cross-project data pollution.
  if (!showAll) {
    allResults = core.filterByProject(allResults, currentProject);
  }
  allResults = core.filterFragments(allResults, {
    minConfidence: args?.minConfidence,
    afterDate: args?.afterDate,
    beforeDate: args?.beforeDate,
  });

  const total = allResults.length;
  const results = allResults.slice(offset, offset + limit);
  const page = paginationMeta(total, limit, offset);

  logger.flow("memory_read", "search_results", { query, total, result_count: results.length, offset, limit, minConfidence: args?.minConfidence });

  const resultIds = new Set((results as any[]).map((r: any) => r.id));
  for (const frag of results) {
    core.boostOnAccess(frag, context);
  }

  // Record which fragments were read into the active session (for guide_practice validation).
  trackReadIntoSession([...resultIds]);

  if (query && resultIds.size > 1) {
    const idArray = [...resultIds];
    for (const id of idArray) {
      const target = (results as any[]).find((f: any) => f.id === id);
      if (!target) continue;
      const others = idArray.filter(x => x !== id);
      const existing = new Set<string>(target.associatedWith || []);
      for (const otherId of others) {
        if (!existing.has(otherId)) {
          existing.add(otherId);
          const other = (results as any[]).find((f: any) => f.id === otherId);
          if (other) {
            const otherAssoc = new Set<string>(other.associatedWith || []);
            if (!otherAssoc.has(id)) {
              otherAssoc.add(id);
              other.associatedWith = [...otherAssoc];
            }
          }
        }
      }
      target.associatedWith = [...existing];
    }
    const assocDb = getDb();
    for (const frag of results) {
      if (resultIds.has(frag.id) && frag.associatedWith && frag.associatedWith.length > 0) {
        core.updateFragmentInDb(frag.id, { associated_with: frag.associatedWith });
      }
    }
  }

  let autoRelateCount = 0;
  if (query && resultIds.size > 1) {
    const relateDb = getDb();
    const idArray = [...resultIds];
    const hub = idArray[0];
    const hubRow = relateDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(hub) as { id: number } | undefined;
    if (hubRow) {
      for (let i = 1; i < idArray.length && autoRelateCount < 3; i++) {
        const targetRow = relateDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(idArray[i]) as { id: number } | undefined;
        if (targetRow) {
          const success = store.addRelation(relateDb, hubRow.id, targetRow.id, "related_to", "Auto-linked: co-read in same query");
          if (success) autoRelateCount++;
        }
      }
    }
  }

  const scopeInfo = showAll ? "all projects" : currentProject || "global";
  const formatted = core.formatMemoryForLLM(results, scopeInfo);
  notifyMemoryChange();

  let hookResponse = formatted;
  if (autoRelateCount > 0) {
    hookResponse += `\nAuto-linked ${autoRelateCount} co-read fragments with related_to relations.`;
  }
  if (page.has_more) {
    hookResponse += `\nShowing ${results.length} of ${total} fragments (offset ${offset}). Pass offset=${page.next_offset} for the next page, or use the query parameter to search.`;
  } else if (!query && !detailId) {
    hookResponse += `\nShowing top ${(results as any[]).length} fragments (ranked by relevance). Use query parameter to search, or id for a specific fragment.`;
  }

  logger.flow("memory_read", "complete_search", { query, total, results: (results as any[]).length, scope: scopeInfo, has_more: page.has_more });

  const structured = {
    count: (results as any[]).length,
    total,
    fragments: (results as any[]).map((r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      type: r.type ?? "fact",
      confidence: r.confidence,
      project: r.project ?? null,
    })),
    has_more: page.has_more,
    next_offset: page.next_offset,
  };

  return buildResult({ text: hookResponse, data: structured, format: responseFormat });
}

export async function handleMemoryAdd(args?: MemoryAddArgs): Promise<ToolResult> {
  const fragment = args?.fragment;
  const title = args?.title || null;
  const description = args?.description || null;
  // Project scope: explicit `project` wins. If omitted, fall back to the
  // detected project (cwd basename) so memory is isolated per project by
  // default. Pass `project: null` explicitly to force global scope.
  const project = args?.project === undefined ? (core.detectProject() || null) : args.project;
  const source = (args?.source || "ai") as "user" | "ai";
  const validTypes: FragmentType[] = ["fact", "pattern", "lesson", "warning", "context"];
  const fragmentType = validTypes.includes((args?.type || "") as FragmentType)
    ? (args?.type as FragmentType)
    : "fact";

  logger.flow("memory_add", "start", { title, project, source, type: fragmentType, has_description: !!description, fragment_length: fragment?.length });

  if (!fragment || typeof fragment !== "string") {
    logger.warn("memory_add validation failed", { reason: "missing or invalid fragment" });
    return {
      content: [{ type: "text", text: "Error: 'fragment' parameter is required and must be a string" }],
      isError: true,
    };
  }

  logger.flow("memory_add", "secret_detection", { confirm: args?.confirm });
  const { redacted, found } = core.redactSecrets(fragment);
  const hasSecrets = found.length > 0;
  const neverConfirmTypes = ["Private key", "OpenAI API key", "OpenAI project key", "GitHub token", "AWS access key"];
  const hasCriticalSecrets = found.some(f => neverConfirmTypes.includes(f.type));
  const finalFragment = hasSecrets && (!args?.confirm || hasCriticalSecrets) ? redacted : fragment;

  const similarMatch = core.findSimilarByText(finalFragment, project);
  if (similarMatch) {
    logger.warn("memory_add duplicate_detected", { similar_id: similarMatch.id, similar_title: similarMatch.title });
    return {
      content: [{
        type: "text",
        text: `A similar memory already exists [${similarMatch.id}]: "${similarMatch.title}"\nUse memory_update on [${similarMatch.id}] if you want to modify it.`
      }],
      isError: true,
    };
  }

  if (hasCriticalSecrets && args?.confirm) {
    logger.warn("memory_add critical_secret_blocked", { secret_types: found.filter(f => neverConfirmTypes.includes(f.type)).map(f => f.type) });
  }
  if (hasSecrets) {
    logger.warn("memory_add secrets_detected", { secret_types: found.map(f => f.type), confirmed: !!args?.confirm });
  }

  const newFragment = core.createFragment(finalFragment, source, title, project, description, fragmentType);
  logger.flow("memory_add", "fragment_created", { id: newFragment.id, title: newFragment.title });

  if (fragmentType === "pattern" || fragmentType === "lesson") {
    newFragment.distill_candidate = true;
  }

  core.addFragmentToDb(newFragment);

  if (activeSessionId) {
    logger.data("sessions", "load");
    const allSessions = sessions.loadSessions();
    const session = sessions.findSession(allSessions, activeSessionId);
    if (session) {
      logger.flow("memory_add", "session_link", { session_id: activeSessionId, task_type: session.task_type });
      core.updateFragmentInDb(newFragment.id, {
        session_id: activeSessionId,
        task_type: session.task_type,
      });
      newFragment.session_id = activeSessionId;
      newFragment.task_type = session.task_type;
      session.memories_created = session.memories_created || [];
      session.memories_created.push(newFragment.id);
      logger.data("sessions", "save", { reason: "link_memory", session_id: activeSessionId });
      sessions.saveSessions(allSessions);
    }
  }

  const overlaps = core.findTopicOverlapsByText(finalFragment, project, 5)
    .filter(o => o.id !== newFragment.id);
  logger.flow("memory_add", "overlap_check", { overlap_count: overlaps.length });

  const scopeInfo = newFragment.project ? ` (project: ${newFragment.project})` : " (global)";
  let response = `Added fragment [${newFragment.id}]${scopeInfo}: "${newFragment.title}"\nSummary: ${newFragment.description}`;
  if (newFragment.distill_candidate) {
    response += `\nFlagged as distill candidate (type: ${fragmentType}).`;
  }
  if (hasSecrets) {
    response += `\n\n⚠️ Privacy: ${found.length} potential secret(s) detected and auto-redacted: ${found.map(f => f.type).join(", ")}. Use confirm: true to store as-is.`;
  }
  if (overlaps.length > 0) {
    const strongest = overlaps[0];
    const overlapDb = getDb();
    const sourceRow = overlapDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(newFragment.id) as { id: number } | undefined;
    const targetRow = overlapDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(strongest.id) as { id: number } | undefined;
    if (sourceRow && targetRow) {
      store.addRelation(overlapDb, sourceRow.id, targetRow.id, "related_to", `Auto-linked: topic overlap (${strongest.confidence.toFixed(2)})`);
    }
    notifyMemoryChange();
    response += `\n\nRelated memories (auto-linked to strongest match):`;
    response += `\n  [${strongest.id}] "${strongest.title}" (${strongest.confidence.toFixed(2)}) — AUTO-LINKED`;
    for (let i = 1; i < overlaps.length; i++) {
      response += `\n  [${overlaps[i].id}] "${overlaps[i].title}" (${overlaps[i].confidence.toFixed(2)})`;
    }
  }

  const hookSuggestions: string[] = [];
  const sCtx = getSessionContext();
  const otherAccessed = sCtx.memoriesAccessed.filter(mid => mid !== newFragment.id);
  if (otherAccessed.length > 0) {
    const lastRead = otherAccessed[otherAccessed.length - 1];
    const ctxDb = getDb();
    const srcRow = ctxDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(newFragment.id) as { id: number } | undefined;
    const tgtRow = ctxDb.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(lastRead) as { id: number } | undefined;
    if (srcRow && tgtRow) {
      store.addRelation(ctxDb, srcRow.id, tgtRow.id, "related_to", "Auto-linked: same session context");
    }
    notifyMemoryChange();
    response += `\nAuto-linked to last read memory [${lastRead}] (same session context).`;
  }
  if (fragmentType === "pattern" || fragmentType === "lesson") {
    hookSuggestions.push(`This is a ${fragmentType}. Consider guide_distill to promote it into a reusable skill.`);
  }

  const memoryForIntel = core.loadMemory();
  const conflicts = intel.detectConflict(newFragment, memoryForIntel.filter((f: any) => f.id !== newFragment.id));
  if (conflicts.length > 0) {
    hookSuggestions.push(`CONFLICT: ${conflicts.length} potentially contradicting memory(ies) detected: ${conflicts.map(c => `[${c.memory_b_id}] "${c.memory_b_title}"`).join(", ")}. Use memory_relate with type "contradicts" to link.`);
  }

  const allGuides = guides.loadGuides();
  const proactiveSuggestions = intel.checkAfterMemoryAdd(newFragment, memoryForIntel, allGuides);
  if (proactiveSuggestions.length > 0) {
    response += intel.formatSuggestions(proactiveSuggestions);
  }

  response += buildHookBlock(hookSuggestions);

  logger.flow("memory_add", "complete", { id: newFragment.id, title: newFragment.title, overlaps: overlaps.length });
  return {
    content: [{ type: "text", text: response }],
    structuredContent: {
      success: true,
      id: newFragment.id,
      conflicts: conflicts.map((c: any) => ({ id: c.memory_b_id, title: c.memory_b_title })),
    },
  };
}

export async function handleMemoryUpdate(args?: MemoryUpdateArgs): Promise<ToolResult> {
  const id = args?.id;
  const title = args?.title;
  const fragment = args?.fragment;
  const confidence = args?.confidence;

  logger.flow("memory_update", "start", { id, has_title: title !== undefined, has_fragment: fragment !== undefined, has_confidence: confidence !== undefined });

  if (!id || typeof id !== "string") {
    logger.warn("memory_update validation failed", { reason: "missing or invalid id" });
    return {
      content: [{ type: "text", text: "Error: 'id' parameter is required and must be a string" }],
      isError: true,
    };
  }

  const target = core.getFragmentById(id);

  if (!target) {
    logger.warn("memory_update fragment not_found", { id });
    return {
      content: [{ type: "text", text: `Error: Fragment with ID '${id}' not found` }],
      isError: true,
    };
  }

  if (title !== undefined) {
    if (typeof title !== "string") {
      logger.warn("memory_update validation failed", { reason: "title not string" });
      return {
        content: [{ type: "text", text: "Error: 'title' must be a string" }],
        isError: true,
      };
    }
    logger.debug("memory_update updating_title", { id, new_title: title });
  }

  if (fragment !== undefined) {
    if (typeof fragment !== "string") {
      logger.warn("memory_update validation failed", { reason: "fragment not string" });
      return {
        content: [{ type: "text", text: "Error: 'fragment' must be a string" }],
        isError: true,
      };
    }
    const db = getDb();
    const ftsQuery = fragment.replace(/[\p{P}\p{S}]/gu, " ").split(/\s+/).filter(t => t.length > 0).join(" OR ");
    if (ftsQuery) {
      const projectFilter = target.project
        ? ` AND (m.project = ? OR m.project IS NULL)`
        : ` AND m.project IS NULL`;
      const params: string[] = target.project
        ? [ftsQuery, target.project.toLowerCase()]
        : [ftsQuery];
      const rows = db.prepareCached(
        `SELECT m.legacy_id as id, m.title FROM memory_fts fts JOIN memories m ON m.id = fts.rowid WHERE memory_fts MATCH ?${projectFilter} ORDER BY bm25(memory_fts) LIMIT 3`
      ).all(...params) as { id: string; title: string }[];
      const existing = rows.find(r => r.id !== id);
      if (existing) {
        logger.warn("memory_update duplicate_detected", { id, similar_id: existing.id });
        return {
          content: [{ type: "text", text: `Error: Similar fragment already exists: [${existing.id}] "${existing.title}". Use a different content or update the existing one.` }],
          isError: true,
        };
      }
    }
    logger.debug("memory_update updating_fragment", { id });
  }

  if (confidence !== undefined) {
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      logger.warn("memory_update validation failed", { reason: "confidence out of range", confidence });
      return {
        content: [{ type: "text", text: "Error: 'confidence' must be a number between 0 and 1" }],
        isError: true,
      };
    }
    logger.debug("memory_update updating_confidence", { id, new_confidence: confidence });
  }

  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (fragment !== undefined) updates.fragment = fragment;
  if (confidence !== undefined) updates.confidence = confidence;

  const success = core.updateFragmentInDb(id, updates);
  if (!success) {
    return {
      content: [{ type: "text", text: `Error: Failed to update fragment [${id}]` }],
      isError: true,
    };
  }

  if (fragment !== undefined) {
    const db = getDb();
    db.prepareCached(
      "UPDATE memories SET access_count = access_count + 1, updated_at = datetime('now') WHERE legacy_id = ?"
    ).run(id);
  }

  notifyMemoryChange();

  let updateResponse = `Updated fragment [${id}]: "${title || target.title}"`;
  if (fragment !== undefined) {
    updateResponse += `\nOrphan relations cleaned up after content change.`;
  }

  logger.flow("memory_update", "complete", { id, title: title || target.title });
  return {
    content: [{ type: "text", text: updateResponse }],
    structuredContent: { success: true, id },
  };
}

export async function handleMemoryForget(args?: MemoryForgetArgs): Promise<ToolResult> {
  const id = args?.id;

  logger.flow("memory_forget", "start", { id });

  if (!id || typeof id !== "string") {
    logger.warn("memory_forget validation failed", { reason: "missing or invalid id" });
    return {
      content: [{ type: "text", text: "Error: 'id' parameter is required and must be a string" }],
      isError: true,
    };
  }

  logger.data("memory", "load");
  const target = core.getFragmentById(id);

  if (!target) {
    logger.warn("memory_forget fragment not_found", { id });
    return {
      content: [{ type: "text", text: `Error: Fragment with ID '${id}' not found` }],
      isError: true,
    };
  }

  core.deleteMemory(id);
  guides.removeMemoryFromGuides(id);

  logger.data("memory", "save", { reason: "forget_fragment", id });
  notifyMemoryChange();

  logger.flow("memory_forget", "complete", { id });
  return {
    content: [{ type: "text", text: `Forgot fragment with ID: ${id}` }],
    structuredContent: { success: true, id },
  };
}

export async function handleMemoryFeedback(args?: MemoryFeedbackArgs): Promise<ToolResult> {
  const id = args?.id;
  const useful = args?.useful;

  logger.flow("memory_feedback", "start", { id, useful });

  if (!id || typeof id !== "string") {
    logger.warn("memory_feedback validation failed", { reason: "missing or invalid id" });
    return {
      content: [{ type: "text", text: "Error: 'id' parameter is required" }],
      isError: true,
    };
  }
  if (typeof useful !== "boolean") {
    logger.warn("memory_feedback validation failed", { reason: "missing or invalid useful" });
    return {
      content: [{ type: "text", text: "Error: 'useful' parameter is required and must be a boolean" }],
      isError: true,
    };
  }

  logger.data("memory", "load");
  const target = core.getFragmentById(id);

  if (!target) {
    logger.warn("memory_feedback fragment not_found", { id });
    return {
      content: [{ type: "text", text: `Error: Fragment with ID '${id}' not found` }],
      isError: true,
    };
  }

  if (useful) {
    const boosted = core.boostOnAccess(target);
    const db = getDb();
    db.prepareCached(
      `UPDATE memories SET positive_feedback = COALESCE(positive_feedback, 0) + 1, updated_at = datetime('now') WHERE legacy_id = ?`
    ).run(id);
    logger.data("memory", "save", { reason: "positive_feedback", id, new_confidence: boosted.confidence?.toFixed(2) });
    notifyMemoryChange();
    logger.flow("memory_feedback", "complete_positive", { id, confidence: boosted.confidence?.toFixed(2) });
    return {
      content: [{ type: "text", text: `Positive feedback recorded for [${id}]. Confidence boosted to ${boosted.confidence.toFixed(2)}.` }],
      structuredContent: { success: true, id, confidence: boosted.confidence },
    };
  } else {
    const penalized = core.recordNegativeHit(target);
    const db = getDb();
    db.prepareCached(
      `UPDATE memories SET negative_feedback = COALESCE(negative_feedback, 0) + 1, updated_at = datetime('now') WHERE legacy_id = ?`
    ).run(id);
    logger.data("memory", "save", { reason: "negative_feedback", id, new_confidence: penalized.confidence?.toFixed(2) });
    notifyMemoryChange();
    logger.flow("memory_feedback", "complete_negative", { id, confidence: penalized.confidence?.toFixed(2) });
    return {
      content: [{ type: "text", text: `Negative feedback recorded for [${id}]. Confidence reduced to ${penalized.confidence.toFixed(2)}.` }],
      structuredContent: { success: true, id, confidence: penalized.confidence },
    };
  }
}

export async function handleMemoryMerge(args?: MemoryMergeArgs): Promise<ToolResult> {
  const ids = args?.ids;
  const title = args?.title;
  const fragment = args?.fragment;
  // Project scope: explicit `project` wins. If omitted, fall back to the
  // detected project (cwd basename) so memory is isolated per project by
  // default. Pass `project: null` explicitly to force global scope.
  const project = args?.project === undefined ? (core.detectProject() || null) : args.project;

  logger.flow("memory_merge", "start", { ids, title, project });

  if (!ids || !Array.isArray(ids) || ids.length < 2) {
    logger.warn("memory_merge validation failed", { reason: "ids must be array with at least 2 elements" });
    return {
      content: [{ type: "text", text: "Error: 'ids' must be an array with at least 2 fragment IDs" }],
      isError: true,
    };
  }

  if (!title || typeof title !== "string") {
    logger.warn("memory_merge validation failed", { reason: "title required" });
    return {
      content: [{ type: "text", text: "Error: 'title' is required and must be a string" }],
      isError: true,
    };
  }

  if (!fragment || typeof fragment !== "string") {
    logger.warn("memory_merge validation failed", { reason: "fragment required" });
    return {
      content: [{ type: "text", text: "Error: 'fragment' is required and must be a string" }],
      isError: true,
    };
  }

  const db = getDb();

  const sourceFrags: any[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const frag = store.getMemoryById(db, id);
    if (frag) {
      sourceFrags.push(frag);
    } else {
      notFound.push(id);
    }
  }
  if (notFound.length > 0) {
    logger.warn("memory_merge fragments not_found", { missing: notFound });
    return {
      content: [{ type: "text", text: `Error: Fragment(s) not found: ${notFound.join(", ")}` }],
      isError: true,
    };
  }

  logger.flow("memory_merge", "merged_fragment_created", { title });

  const inheritedRelations: any[] = [];
  const inheritedGuides: string[] = [];
  const inheritedAssociated: string[] = [];
  for (const src of sourceFrags) {
    if (src.relations) {
      for (const rel of src.relations) {
        if (!ids.includes(rel.id) && !inheritedRelations.find(r => r.id === rel.id && r.type === rel.type)) {
          inheritedRelations.push({ ...rel });
        }
      }
    }
    if (src.related_guides) {
      for (const g of src.related_guides) {
        if (!inheritedGuides.includes(g)) inheritedGuides.push(g);
      }
    }
    if (src.associatedWith) {
      for (const assocId of src.associatedWith) {
        if (!ids.includes(assocId) && !inheritedAssociated.includes(assocId)) {
          inheritedAssociated.push(assocId);
        }
      }
    }
  }

  const numericIds: number[] = [];
  for (const legacyId of ids) {
    const row = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(legacyId) as { id: number } | undefined;
    if (row) numericIds.push(row.id);
  }

  const newNumericId = store.mergeMemories(db, numericIds, title, fragment);
  if (!newNumericId) {
    logger.warn("memory_merge failed", { reason: "mergeMemories returned null" });
    return {
      content: [{ type: "text", text: "Error: Failed to merge fragments" }],
      isError: true,
    };
  }

  const legacyRow = db.prepareCached("SELECT legacy_id FROM memories WHERE id = ?").get(newNumericId) as { legacy_id: string };
  const newLegacyId = legacyRow.legacy_id;

  const newFragUpdates: Record<string, any> = {};
  if (project !== undefined) newFragUpdates.project = project;
  if (inheritedGuides.length > 0) newFragUpdates.related_guides = inheritedGuides;
  if (inheritedAssociated.length > 0) newFragUpdates.associated_with = inheritedAssociated;
  if (Object.keys(newFragUpdates).length > 0) {
    store.updateMemory(db, newLegacyId, newFragUpdates as any);
  }

  const assocRows = db.prepareCached(
    `SELECT id, associated_with FROM memories WHERE associated_with IS NOT NULL AND id != ?`
  ).all(newNumericId) as { id: number; associated_with: string }[];
  for (const row of assocRows) {
    const arr: string[] = JSON.parse(row.associated_with);
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (ids.includes(arr[i])) {
        arr[i] = newLegacyId;
        changed = true;
      }
    }
    if (changed) {
      const deduped = [...new Set(arr)];
      db.prepareCached(
        `UPDATE memories SET associated_with = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(deduped.length > 0 ? JSON.stringify(deduped) : null, row.id);
    }
  }

  for (const oldLegacyId of ids) {
    const guideRows = db.prepareCached(
      "SELECT * FROM guides WHERE source_memories LIKE ? OR validated_by LIKE ?"
    ).all(`%${oldLegacyId}%`, `%${oldLegacyId}%`) as Record<string, any>[];
    for (const row of guideRows) {
      const srcMem: string[] = row.source_memories ? JSON.parse(row.source_memories) : [];
      const valBy: string[] = row.validated_by ? JSON.parse(row.validated_by) : [];
      if (srcMem.some((mId: string) => ids.includes(mId))) {
        const updated = [...new Set(srcMem.map((mId: string) => ids.includes(mId) ? newLegacyId : mId))];
        db.prepareCached("UPDATE guides SET source_memories = ?, updated_at = datetime('now') WHERE id = ?")
          .run(updated.length > 0 ? JSON.stringify(updated) : null, row.id);
      }
      if (valBy.some((mId: string) => ids.includes(mId))) {
        const updated = [...new Set(valBy.map((mId: string) => ids.includes(mId) ? newLegacyId : mId))];
        db.prepareCached("UPDATE guides SET validated_by = ?, updated_at = datetime('now') WHERE id = ?")
          .run(updated.length > 0 ? JSON.stringify(updated) : null, row.id);
      }
    }
  }

  for (const rel of inheritedRelations) {
    store.addRelation(db,
      (db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(newLegacyId) as { id: number }).id,
      (db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(rel.id) as { id: number }).id,
      rel.type,
      rel.note
    );
  }

  notifyMemoryChange();

  logger.data("memory", "save", { reason: "merge_fragments", new_id: newLegacyId, removed_ids: ids });
  logger.flow("memory_merge", "complete", { new_id: newLegacyId, merged_count: ids.length });

  const scopeInfo = project ? ` (project: ${project})` : " (global)";
  let response = `Merged ${ids.length} fragments into [${newLegacyId}]${scopeInfo}: "${title}"\nRemoved IDs: ${ids.join(", ")}`;

  if (inheritedRelations.length > 0 || inheritedGuides.length > 0) {
    response += `\n\nINHERITED CONNECTIONS:`;
    if (inheritedRelations.length > 0) {
      response += `\n- Relations: ${inheritedRelations.map(r => `[${r.id}] ${r.type}`).join(", ")}`;
    }
    if (inheritedGuides.length > 0) {
      response += `\n- Guides: ${inheritedGuides.join(", ")}`;
    }
  }

  return {
    content: [{ type: "text", text: response }],
    structuredContent: {
      success: true,
      id: newLegacyId,
      merged_ids: ids,
    },
  };
}

export async function handleMemoryRelate(args?: MemoryRelateArgs): Promise<ToolResult> {
  const sourceId = args?.sourceId;
  const targetId = args?.targetId;
  const type = args?.type;
  const note = args?.note;

  logger.flow("memory_relate", "start", { sourceId, targetId, type, has_note: !!note });

  if (!sourceId || !targetId || !type) {
    logger.warn("memory_relate validation failed", { reason: "missing required params" });
    return {
      content: [{ type: "text", text: "Error: 'sourceId', 'targetId', and 'type' parameters are required" }],
      isError: true,
    };
  }

  const validTypes = ["contradicts", "supersedes", "supports", "related_to"];
  if (!validTypes.includes(type)) {
    logger.warn("memory_relate validation failed", { reason: "invalid type", type });
    return {
      content: [{ type: "text", text: `Error: 'type' must be one of: ${validTypes.join(", ")}` }],
      isError: true,
    };
  }

  if (sourceId === targetId) {
    logger.warn("memory_relate validation failed", { reason: "sourceId equals targetId" });
    return {
      content: [{ type: "text", text: "Error: sourceId and targetId cannot be the same" }],
      isError: true,
    };
  }

  logger.data("memory", "load");
  const db = getDb();
  const sourceRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(sourceId) as { id: number } | undefined;
  const targetRow = db.prepareCached("SELECT id FROM memories WHERE legacy_id = ?").get(targetId) as { id: number } | undefined;

  if (!sourceRow) {
    logger.warn("memory_relate source not_found", { sourceId });
    return {
      content: [{ type: "text", text: `Error: Source fragment [${sourceId}] not found` }],
      isError: true,
    };
  }

  if (!targetRow) {
    logger.warn("memory_relate target not_found", { targetId });
    return {
      content: [{ type: "text", text: `Error: Target fragment [${targetId}] not found` }],
      isError: true,
    };
  }

  const success = store.addRelation(db, sourceRow.id, targetRow.id, type, note || undefined);
  if (!success) {
    logger.warn("memory_relate relation_exists", { sourceId, targetId, type });
    return {
      content: [{ type: "text", text: `Relation already exists between [${sourceId}] and [${targetId}] with type '${type}'` }],
      isError: true,
    };
  }

  logger.data("memory", "save", { reason: "add_relation", sourceId, targetId, type });
  notifyMemoryChange();

  logger.flow("memory_relate", "complete", { sourceId, targetId, type });
  return {
    content: [{ type: "text", text: `Created relation: [${sourceId}] --${type}--> [${targetId}]${note ? ` (${note})` : ""}` }],
    structuredContent: { success: true, relation: type },
  };
}

export async function handleGuideGet(args?: GuideGetArgs): Promise<ToolResult> {
  const category = args?.category || null;
  const guideName = args?.guide || null;
  const task = args?.task || null;
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  logger.flow("guide_get", "start", { category, guide: guideName, task });

  if (task) {
    const result = guides.suggestGuides(task, guides.loadGuides());
    logger.flow("guide_get", "task_suggestions", { task, relevant: result.relevant.length, suggested: result.suggested.length });
    const formatted = guides.formatSuggestions(result);
    return buildResult({ text: formatted, data: { count: result.suggested.length, guides: result.suggested, guide: null }, format: responseFormat });
  }

  if (guideName) {
    logger.flow("guide_get", "single_guide_lookup", { guide: guideName });
    const guide = guides.getGuideFromDb(guideName);
    logger.flow("guide_get", "complete_single", { guide: guideName, found: !!guide });
    return buildResult({
      text: guides.formatGuideDetail(guide),
      data: { count: guide ? 1 : 0, guides: guide ? [guide] : [], guide: guide ?? null },
      format: responseFormat,
    });
  }

  const filtered = category
    ? guides.getGuidesByCategoryFromDb(category)
    : guides.loadGuides();

  logger.flow("guide_get", "complete_list", { category, filtered: filtered.length });
  const formatted = guides.formatGuidesForLLM(filtered);
  return buildResult({ text: formatted, data: { count: filtered.length, guides: filtered, guide: null }, format: responseFormat });
}

export async function handleGuidePractice(args?: GuidePracticeArgs): Promise<ToolResult> {
  const guideName = args?.guide;
  const category = args?.category;
  const description = args?.description || "";
  const contexts = args?.contexts || [];
  const learnings = args?.learnings || [];

  logger.flow("guide_practice", "start", { guide: guideName, category, outcome: args?.outcome, context_count: contexts.length, learning_count: learnings.length });

  if (!guideName || !category) {
    logger.warn("guide_practice validation failed", { reason: "missing guide or category" });
    return {
      content: [{ type: "text", text: "Error: 'guide' and 'category' parameters are required" }],
      isError: true,
    };
  }

  let updated = guides.findSimilarGuideByName(guideName);
  const preUsageCount = updated?.usage_count || 0;

  if (!updated) {
    updated = guides.createGuide(guideName, category, description, contexts, learnings);
    if (args?.outcome === "success") updated.success_count = 1;
    else if (args?.outcome === "failure") updated.failure_count = 1;
    const db = getDb();
    guides.upsertGuideToDb(db, updated);
  } else {
    updated.usage_count += 1;
    updated.last_used = guides.getToday();
    if (updated.auto_usage_count == null) updated.auto_usage_count = 0;

    if (!updated.description && description) {
      updated.description = description.trim();
    }

    const existingContexts = new Set(updated.contexts.map(c => c.toLowerCase()));
    for (const ctx of contexts) {
      const normalized = ctx.toLowerCase().trim();
      if (normalized && !existingContexts.has(normalized)) {
        updated.contexts.push(normalized);
        existingContexts.add(normalized);
      }
    }

    const existingLearnings = new Set(updated.learnings);
    for (const learning of learnings) {
      const trimmed = learning.trim();
      if (trimmed && !existingLearnings.has(trimmed)) {
        updated.learnings.push(trimmed);
        existingLearnings.add(trimmed);
      }
    }

    if (args?.outcome === "success") {
      updated.success_count = (updated.success_count || 0) + 1;
    } else if (args?.outcome === "failure") {
      updated.failure_count = (updated.failure_count || 0) + 1;
    }

    const db = getDb();
    guides.upsertGuideToDb(db, updated);
  }

  logger.flow("guide_practice", "guide_updated", { guide: guideName, usage_before: preUsageCount, usage_after: updated.usage_count });

  if (activeSessionId) {
    logger.data("sessions", "load");
    const allSessions = sessions.loadSessions();
    const session = sessions.findSession(allSessions, activeSessionId);
    if (session) {
      if (!session.guides_used) session.guides_used = [];
      if (!session.guides_used.includes(guideName.toLowerCase())) {
        session.guides_used.push(guideName.toLowerCase());
      }

      if (session.memories_read && session.memories_read.length > 0) {
        const normalizedName = guideName.toLowerCase().trim();
        if (!updated.validated_by) updated.validated_by = [];
        for (const memId of session.memories_read) {
          if (!updated.validated_by.includes(memId)) {
            updated.validated_by.push(memId);
          }
          const memFrag = core.getFragmentById(memId);
          if (memFrag) {
            if (!memFrag.related_guides) memFrag.related_guides = [];
            if (!memFrag.related_guides.includes(normalizedName)) {
              memFrag.related_guides.push(normalizedName);
              core.updateFragmentInDb(memId, { related_guides: memFrag.related_guides });
            }
          }
        }
        logger.flow("guide_practice", "practice_validation_links", { guide: guideName, memories_linked: session.memories_read.length });
        const db = getDb();
        guides.upsertGuideToDb(db, updated);
      }

      logger.data("sessions", "save", { reason: "track_guide_practice", session_id: activeSessionId, guide: guideName });
      sessions.saveSessions(allSessions);
    }
  }

  const isNew = updated.usage_count === 1;
  const action = isNew ? "Created" : "Updated";
  let response = `${action} guide "${updated.guide}" (${updated.category}): ${updated.usage_count}x usage, ${updated.learnings.length} learnings, ${updated.contexts.length} contexts`;

  const hookSuggestions: string[] = [];
  const totalAttempts = (updated.success_count || 0) + (updated.failure_count || 0);
  if (totalAttempts >= 3 && (updated.success_count || 0) / totalAttempts < 0.4) {
    hookSuggestions.push(`Guide "${updated.guide}" success rate is ${((updated.success_count || 0) / totalAttempts).toFixed(2)} (${updated.success_count}/${totalAttempts}). Consider guide_update to refine.`);
  }

  const allGuides = guides.loadGuides();
  const practiceSuggestions = intel.checkAfterGuidePractice(updated, allGuides);
  if (practiceSuggestions.length > 0) {
    response += intel.formatSuggestions(practiceSuggestions);
  }

  response += buildHookBlock(hookSuggestions);

  logger.flow("guide_practice", "complete", { guide: guideName, action, usage_count: updated.usage_count });
  return {
    content: [{ type: "text", text: response }],
    structuredContent: { success: true, guide: guideName, usage_count: updated.usage_count },
  };
}

export async function handleGuideCreate(args?: GuideCreateArgs): Promise<ToolResult> {
  const guideName = args?.guide;
  const category = args?.category;
  const description = args?.description;
  const contexts = args?.contexts || [];
  const learnings = args?.learnings || [];

  logger.flow("guide_create", "start", { guide: guideName, category, has_description: !!description });

  if (!guideName || !category || !description) {
    logger.warn("guide_create validation failed", { reason: "missing guide, category, or description" });
    return {
      content: [{ type: "text", text: "Error: 'guide', 'category', and 'description' parameters are required" }],
      isError: true,
    };
  }

  const existing = guides.getGuideFromDb(guideName);

  if (existing) {
    logger.flow("guide_create", "updating_existing", { guide: guideName, existing_id: existing.guide });
    existing.description = description;
    logger.data("guides", "save", { reason: "update_existing_guide", guide: guideName });
    const db = getDb();
    guides.upsertGuideToDb(db, existing);
    return {
      content: [{ type: "text", text: `Updated manual for existing guide "${existing.guide}" (${existing.category})` }],
      structuredContent: { success: true, guide: existing.guide },
    };
  }

  logger.data("guides", "load");
  const similar = guides.findSimilarGuideByName(guideName);

  if (similar) {
    logger.flow("guide_create", "updating_existing", { guide: guideName, existing_id: similar.guide });
    similar.description = description;
    logger.data("guides", "save", { reason: "update_existing_guide", guide: guideName });
    const db = getDb();
    guides.upsertGuideToDb(db, similar);
    return {
      content: [{ type: "text", text: `Updated manual for existing guide "${similar.guide}" (${similar.category})` }],
      structuredContent: { success: true, guide: similar.guide },
    };
  }

  const newGuide = guides.createGuide(guideName, category, description, contexts, learnings);
  logger.data("guides", "save", { reason: "create_new_guide", guide: guideName });
  const db = getDb();
  guides.upsertGuideToDb(db, newGuide);

  logger.flow("guide_create", "complete", { guide: guideName, category, is_new: true });
  return {
    content: [{ type: "text", text: `Created new guide "${newGuide.guide}" (${newGuide.category}) with a detailed manual.` }],
    structuredContent: { success: true, guide: newGuide.guide },
  };
}

export async function handleGuideDistill(args?: GuideDistillArgs): Promise<ToolResult> {
  const memoryId = args?.memory_id;
  const guideName = args?.guide;
  const category = args?.category || "dev-tool";

  logger.flow("guide_distill", "start", { memory_id: memoryId, guide: guideName, category });

  if (!memoryId || !guideName) {
    logger.warn("guide_distill validation failed", { reason: "missing memory_id or guide" });
    return {
      content: [{ type: "text", text: "Error: 'memory_id' and 'guide' parameters are required" }],
      isError: true,
    };
  }

  const fragment = core.getFragmentById(memoryId);

  if (!fragment) {
    logger.warn("guide_distill memory not_found", { memory_id: memoryId });
    return {
      content: [{ type: "text", text: `Error: Memory fragment with ID '${memoryId}' not found.` }],
      isError: true,
    };
  }

  logger.flow("guide_distill", "fragment_found", { memory_id: memoryId, title: fragment.title });

  let updated = guides.getGuideFromDb(guideName);
  if (!updated) {
    updated = guides.createGuide(guideName, category, `Created via distillation from memory.`, [(fragment.project || "global").toLowerCase().trim()], [fragment.fragment]);
  } else {
    if (!updated.learnings.includes(fragment.fragment)) {
      updated.learnings.push(fragment.fragment);
    }
    const ctx = (fragment.project || "global").toLowerCase().trim();
    if (ctx && !updated.contexts.includes(ctx)) {
      updated.contexts.push(ctx);
    }
    updated.usage_count += 1;
    updated.last_used = guides.getToday();
  }

  if (!updated.source_memories) updated.source_memories = [];
  if (!updated.source_memories.includes(memoryId)) {
    updated.source_memories.push(memoryId);
  }
  if (!fragment.related_guides) fragment.related_guides = [];
  const normalizedName = guideName.toLowerCase().trim();
  if (!fragment.related_guides.includes(normalizedName)) {
    fragment.related_guides.push(normalizedName);
  }
  if (fragment.distill_candidate) {
    fragment.distill_candidate = false;
  }

  core.updateFragmentInDb(memoryId, {
    related_guides: fragment.related_guides,
    distill_candidate: false,
  });
  logger.data("guides", "save", { reason: "distill_memory_to_guide", memory_id: memoryId, guide: guideName });
  const db = getDb();
  guides.upsertGuideToDb(db, updated);

  let response = `Successfully distilled memory [${memoryId}] into guide "${updated.guide}" (${updated.category}).\n\n`;
  response += guides.formatGuideDetail(updated);

  logger.flow("guide_distill", "complete", { memory_id: memoryId, guide: guideName, category });
  return {
    content: [{ type: "text", text: response }],
    structuredContent: { success: true, guide: updated.guide, memory_id: memoryId },
  };
}

export async function handleGuideUpdate(args?: GuideUpdateArgs): Promise<ToolResult> {
  const guideName = args?.guide;
  const updates: Record<string, unknown> = {
    guide: args?.new_name,
    category: args?.category,
    description: args?.description,
    add_anti_patterns: args?.add_anti_patterns,
    add_pitfalls: args?.add_pitfalls,
    superseded_by: args?.superseded_by,
    deprecated: args?.deprecated,
  };

  const fieldsToUpdate = Object.entries(updates).filter(([, v]) => v !== undefined).map(([k]) => k);
  logger.flow("guide_update", "start", { guide: guideName, fields: fieldsToUpdate });

  if (!guideName) {
    logger.warn("guide_update validation failed", { reason: "missing guide name" });
    return {
      content: [{ type: "text", text: "Error: 'guide' parameter is required" }],
      isError: true,
    };
  }

  const guide = guides.getGuideFromDb(guideName);

  if (!guide) {
    logger.warn("guide_update guide not_found", { guide: guideName });
    return {
      content: [{ type: "text", text: `Error: Guide "${guideName}" not found.` }],
      isError: true,
    };
  }

  if (args?.new_name) { guide.guide = args.new_name.toLowerCase().trim(); }
  if (args?.category) { guide.category = args.category.toLowerCase().trim(); }
  if (args?.description) { guide.description = args.description.trim(); }
  if (args?.add_anti_patterns) {
    guide.anti_patterns = [...(guide.anti_patterns || []), ...args.add_anti_patterns];
  }
  if (args?.add_pitfalls) {
    guide.known_pitfalls = [...(guide.known_pitfalls || []), ...args.add_pitfalls];
  }
  if (args?.superseded_by) {
    guide.superseded_by = args.superseded_by;
  }
  if (args?.deprecated === true) {
    guide.deprecated = true;
  }

  const db = getDb();
  if (args?.new_name) {
    const oldName = guideName.toLowerCase().trim();
    const newName = args.new_name.toLowerCase().trim();
    if (oldName !== newName) {
      db.prepareCached("DELETE FROM guides WHERE guide = ? COLLATE NOCASE").run(oldName);
    }
  }
  guides.upsertGuideToDb(db, guide);

  if (args?.new_name && args.new_name.toLowerCase().trim() !== guideName.toLowerCase().trim()) {
    core.renameGuideInMemories(guideName, args.new_name);
  }

  logger.flow("guide_update", "complete", { guide: guideName, updated_fields: fieldsToUpdate });
  return {
    content: [{ type: "text", text: `Updated guide "${guide.guide}":\n${guides.formatGuideDetail(guide)}` }],
    structuredContent: { success: true, guide: guide.guide },
  };
}

export async function handleGuideForget(args?: GuideForgetArgs): Promise<ToolResult> {
  const guideName = args?.guide;

  logger.flow("guide_forget", "start", { guide: guideName });

  if (!guideName) {
    logger.warn("guide_forget validation failed", { reason: "missing guide name" });
    return {
      content: [{ type: "text", text: "Error: 'guide' parameter is required" }],
      isError: true,
    };
  }

  const existing = guides.getGuideFromDb(guideName);

  if (!existing) {
    logger.warn("guide_forget guide not_found", { guide: guideName });
    return {
      content: [{ type: "text", text: `Error: Guide "${guideName}" not found.` }],
      isError: true,
    };
  }

  const db = getDb();
  db.prepareCached("DELETE FROM guides WHERE guide = ? COLLATE NOCASE").run(guideName.toLowerCase().trim());

  core.removeGuideFromMemories(guideName.toLowerCase().trim());

  logger.flow("guide_forget", "complete", { guide: guideName });
  return {
    content: [{ type: "text", text: `Successfully forgot guide: ${guideName}` }],
    structuredContent: { success: true, guide: guideName },
  };
}

export async function handleGuideMerge(args?: GuideMergeArgs): Promise<ToolResult> {
  const guideNames = args?.guides;
  const newGuideName = args?.guide;
  const category = args?.category;
  const description = args?.description || "";
  let contexts: string[] | undefined = args?.contexts;
  let learnings: string[] | undefined = args?.learnings;

  logger.flow("guide_merge", "start", { guides: guideNames, new_guide: newGuideName, category });

  if (!guideNames || !Array.isArray(guideNames) || guideNames.length < 2) {
    logger.warn("guide_merge validation failed", { reason: "guides must be array with at least 2 elements" });
    return {
      content: [{ type: "text", text: "Error: 'guides' must be an array with at least 2 guide names" }],
      isError: true,
    };
  }

  if (!newGuideName || !category) {
    logger.warn("guide_merge validation failed", { reason: "missing guide name or category" });
    return {
      content: [{ type: "text", text: "Error: 'guide' and 'category' parameters are required" }],
      isError: true,
    };
  }

  const sourceGuides: any[] = [];
  const notFound: string[] = [];
  for (const name of guideNames) {
    const g = guides.getGuideFromDb(name);
    if (g) {
      sourceGuides.push(g);
    } else {
      notFound.push(name);
    }
  }

  if (notFound.length > 0) {
    logger.warn("guide_merge guides not_found", { missing: notFound });
    return {
      content: [{ type: "text", text: `Error: Guide(s) not found: ${notFound.join(", ")}` }],
      isError: true,
    };
  }

  if (!contexts) {
    contexts = [...new Set(sourceGuides.flatMap((g: any) => g.contexts))];
  }
  if (!learnings) {
    learnings = [...new Set(sourceGuides.flatMap((g: any) => g.learnings))];
  }

  const antiPatterns = [...new Set(sourceGuides.flatMap((g: any) => g.anti_patterns || []))];
  const pitfalls = [...new Set(sourceGuides.flatMap((g: any) => g.known_pitfalls || []))];

  const totalUsage = sourceGuides.reduce((sum: number, g: any) => sum + g.usage_count, 0);
  logger.flow("guide_merge", "source_stats", { source_count: sourceGuides.length, total_usage: totalUsage });

  const newGuide = guides.createGuide(newGuideName, category, description, contexts, learnings);
  newGuide.usage_count = totalUsage;
  newGuide.anti_patterns = antiPatterns;
  newGuide.known_pitfalls = pitfalls;
  newGuide.source_memories = [...new Set(sourceGuides.flatMap((g: any) => g.source_memories || []).filter(Boolean))];
  newGuide.validated_by = [...new Set(sourceGuides.flatMap((g: any) => g.validated_by || []).filter(Boolean))];

  for (const oldName of guideNames) {
    core.renameGuideInMemories(oldName, newGuideName);
    try {
      const db = getDb();
      db.prepareCached("DELETE FROM guides WHERE guide = ? COLLATE NOCASE").run(oldName.toLowerCase().trim());
    } catch {}
  }

  logger.data("guides", "save", { reason: "merge_guides", new_guide: newGuideName, removed: guideNames, total_usage: totalUsage });
  const db = getDb();
  guides.upsertGuideToDb(db, newGuide);

  let response = `Merged ${guideNames.length} guides into "${newGuide.guide}" (${newGuide.category})\n`;
  response += `Total usage: ${totalUsage}x | Contexts: ${contexts.length} | Learnings: ${learnings.length}\n`;
  response += `Removed: ${guideNames.join(", ")}`;

  const mergeHookSuggestions: string[] = [];
  if (antiPatterns.length > 0) mergeHookSuggestions.push(`Anti-patterns inherited: ${antiPatterns.length}`);
  if (pitfalls.length > 0) mergeHookSuggestions.push(`Pitfalls inherited: ${pitfalls.length}`);
  const allSourceMemories = sourceGuides.flatMap((g: any) => g.source_memories || []).filter(Boolean);
  if (allSourceMemories.length > 0) mergeHookSuggestions.push(`Source memories linked: ${allSourceMemories.length} fragment(s)`);
  const allValidatedBy = sourceGuides.flatMap((g: any) => g.validated_by || []).filter(Boolean);
  if (allValidatedBy.length > 0) mergeHookSuggestions.push(`Validated by: ${allValidatedBy.length} fragment(s)`);
  response += buildHookBlock(mergeHookSuggestions);

  logger.flow("guide_merge", "complete", { new_guide: newGuideName, merged_count: guideNames.length, total_usage: totalUsage });
  return {
    content: [{ type: "text", text: response }],
    structuredContent: { success: true, guide: newGuideName, merged: guideNames },
  };
}

export async function handleMemoryStats(args?: MemoryStatsArgs): Promise<ToolResult> {
  const project = args?.project || null;
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  logger.flow("memory_stats", "start", { project });

  logger.data("memory", "load");
  const db = getDb();
  const stats = store.getMemoryStats(db, project);

  logger.flow("memory_stats", "complete", { project, total: stats.total, avg_confidence: stats.avg_confidence?.toFixed(2) });
  return buildResult({ text: core.formatStats(stats), data: stats, format: responseFormat });
}

export async function handleMemoryAudit(args?: { response_format?: "markdown" | "json" }): Promise<ToolResult> {
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";
  logger.flow("memory_audit", "start");

  logger.data("memory", "load");
  const memory = core.loadMemory();
  const result = core.auditMemory(memory);

  logger.flow("memory_audit", "complete", { issues_count: result.issues?.length || 0 });
  return buildResult({ text: core.formatAuditReport(result), data: result, format: responseFormat });
}

export async function handleSessionStats(args?: SessionStatsArgs): Promise<ToolResult> {
  const count = args?.count || 10;
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  logger.flow("session_stats", "start", { count });

  const recentSessions = virtualSession.getRecentSessions(count);
  const current = virtualSession.getCurrentVirtualSession();

  logger.debug("session_stats data", { requested: count, recent_count: recentSessions.length, has_current: !!current });

  let output = `## Session Stats\n`;

  if (current) {
    output += `Active session: ${current.tool_calls.length} tool calls\n`;
    if (current.technologies_seen.size > 0) {
      output += `Technologies: ${[...current.technologies_seen].join(", ")}\n`;
    }
    if (current.guides_used.size > 0) {
      output += `Guides used: ${[...current.guides_used].join(", ")}\n`;
    }
    output += `\n`;
  }

  if (recentSessions.length > 0) {
    output += `Recent sessions (${recentSessions.length}):\n`;
    for (const s of recentSessions.slice(0, 5)) {
      const techs = s.technologies?.length > 0 ? ` [${s.technologies.join(", ")}]` : "";
      output += `  ${s.id}: ${s.duration_tool_calls} calls${techs}\n`;
    }
  } else {
    output += `No past sessions recorded yet.\n`;
  }

  logger.flow("session_stats", "complete", { count, recent_count: recentSessions.length, has_current: !!current });
  const data = {
    active_session: current ? {
      tool_calls: current.tool_calls.length,
      technologies: [...current.technologies_seen],
      guides_used: [...current.guides_used],
    } : null,
    recent_sessions: recentSessions.slice(0, 5),
  };
  return buildResult({ text: output, data, format: responseFormat });
}

export async function handleMemoryLibrary(args?: MemoryLibraryArgs): Promise<ToolResult> {
  const project = args?.project ?? null;
  const focus = args?.focus ?? "full";
  const limit = Math.min(Math.max(args?.limit ?? 50, 1), 200);
  const offset = Math.max(0, args?.offset ?? 0);
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  logger.flow("memory_library", "start", { project, focus, limit, offset });

  const db = getDb();

  const snapshot = collectLibrarySnapshot(db, { project, focus });

  // Page the fragments list — the snapshot is otherwise a full-DB view.
  const fragTotal = Array.isArray((snapshot as any).fragments) ? (snapshot as any).fragments.length : 0;
  const page = paginationMeta(fragTotal, limit, offset);
  const snapshotData = {
    ...snapshot,
    fragments: Array.isArray((snapshot as any).fragments)
      ? (snapshot as any).fragments.slice(offset, offset + limit)
      : (snapshot as any).fragments,
    fragments_total: fragTotal,
    has_more: page.has_more,
    next_offset: page.next_offset,
  };

  const formatted = formatLibrarySnapshot(snapshot, focus);
  let text = formatted;
  if (page.has_more) {
    text += `\n\nShowing ${(snapshotData as any).fragments.length} of ${fragTotal} fragments (offset ${offset}). Pass offset=${page.next_offset} for the next page.`;
  }

  logger.flow("memory_library", "complete", {
    total_memories: (snapshot as any).total_memories,
    total_guides: (snapshot as any).total_guides,
    suggestions: (snapshot as any).suggestions?.length ?? 0,
    fragments_shown: (snapshotData as any).fragments.length,
  });

  return buildResult({ text, data: snapshotData, format: responseFormat });
}

export async function handleConflictScan(args?: { project?: string; response_format?: "markdown" | "json" }): Promise<ToolResult> {
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";
  logger.flow("conflict_scan", "start", { project: args?.project });

  const memory = core.loadMemory();
  const filtered = args?.project
    ? core.filterByProject(memory, args.project)
    : memory;

  const conflicts = intel.scanForConflicts(filtered);

  logger.flow("conflict_scan", "complete", { conflicts: conflicts.length });
  return buildResult({ text: intel.formatConflictResults(conflicts), data: { count: conflicts.length, conflicts }, format: responseFormat });
}

export async function handleProactiveAnalysis(args?: { project?: string; response_format?: "markdown" | "json" }): Promise<ToolResult> {
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";
  logger.flow("proactive_analysis", "start", { project: args?.project });

  const memory = core.loadMemory();
  const allGuides = guides.loadGuides();

  const filtered = args?.project
    ? core.filterByProject(memory, args.project)
    : memory;

  const suggestions = intel.runFullAnalysis(filtered, allGuides);

  const conflicts = intel.scanForConflicts(filtered);
  if (conflicts.length > 0) {
    suggestions.push({
      type: "conflict",
      priority: "high",
      message: `${conflicts.length} conflicting memory pair(s) detected. Run conflict_scan for details.`,
    });
  }

  let output = `=== PROACTIVE ANALYSIS ===\n`;
  output += `Analyzed ${filtered.length} memories and ${allGuides.length} guides.\n\n`;
  output += intel.formatSuggestions(suggestions);

  if (suggestions.length === 0) {
    output = `=== PROACTIVE ANALYSIS ===\nNo issues detected. Knowledge base looks healthy.`;
  }

  logger.flow("proactive_analysis", "complete", { suggestions: suggestions.length });
  return buildResult({ text: output, data: { count: suggestions.length, analyzed_memories: filtered.length, analyzed_guides: allGuides.length, suggestions }, format: responseFormat });
}

export async function handleProjectAnalytics(args?: { project?: string; response_format?: "markdown" | "json" }): Promise<ToolResult> {
  const project = args?.project || null;
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  if (!project) {
    logger.flow("project_analytics", "all_projects");
    const db = getDb();
    const allProgress = intel.getAllProjectsAnalytics(db);
    if (allProgress.length === 0) {
      return buildResult({
        text: "No projects found with session or memory data.",
        data: { project: null, health_score: null, recent_insights: [], count: 0, projects: [] },
        format: responseFormat,
      });
    }
    let output = `=== ALL PROJECTS OVERVIEW ===\n\n`;
    for (const p of allProgress) {
      output += `${p.project}: ${p.total_sessions} sessions, ${p.total_memories} memories, health ${(p.health_score * 100).toFixed(0)}%\n`;
    }
    return buildResult({
      text: output,
      data: { project: null, health_score: null, recent_insights: [], count: allProgress.length, projects: allProgress },
      format: responseFormat,
    });
  }

  logger.flow("project_analytics", "start", { project });
  const db = getDb();
  const progress = intel.getProjectAnalytics(db, project);
  const formatted = intel.formatProjectProgress(progress);

  logger.flow("project_analytics", "complete", { project, health: progress.health_score });
  return buildResult({ text: formatted, data: { ...progress, project, count: null, projects: [] }, format: responseFormat });
}

export async function handleSemanticSearch(args?: { query?: string; project?: string; topK?: number; offset?: number; response_format?: "markdown" | "json" }): Promise<ToolResult> {
  const query = args?.query;
  const project = args?.project || null;
  const topK = args?.topK || 10;
  const offset = Math.max(0, args?.offset ?? 0);
  const responseFormat = args?.response_format === "json" ? "json" : "markdown";

  logger.flow("semantic_search", "start", { query: query?.slice(0, 50), project, topK, offset });

  if (!query || typeof query !== "string") {
    return {
      content: [{ type: "text", text: "Error: 'query' parameter is required" }],
      isError: true,
    };
  }

  const db = getDb();
  // Fetch a superset so offset pagination has room; topK still bounds the page size.
  const cappedK = Math.min(Math.max(topK, 1), 30);
  const fetchK = cappedK + offset;
  const allResults = intel.semanticSearch(db, query, { project, topK: fetchK });
  const total = allResults.length;
  const results = allResults.slice(offset, offset + cappedK);
  const page = paginationMeta(total, cappedK, offset);

  if (results.length === 0) {
    const empty = { count: 0, total, results: [], has_more: page.has_more, next_offset: page.next_offset };
    return buildResult({ text: `No semantically similar memories found for: "${query}"`, data: empty, format: responseFormat });
  }

  let output = `=== SEMANTIC SEARCH RESULTS ===\nQuery: "${query}"\nFound ${results.length} similar memories:\n\n`;
  for (const r of results) {
    output += `  [${(r.score * 100).toFixed(0)}%] [${r.memory_id}] "${r.title}"\n`;
    output += `      ${r.fragment.substring(0, 100)}...\n`;
  }
  if (page.has_more) {
    output += `\nMore results available. Pass offset=${page.next_offset} for the next page.`;
  }

  logger.flow("semantic_search", "complete", { results: results.length, has_more: page.has_more });

  const structured = {
    count: results.length,
    total,
    results: results.map((r: any) => ({
      id: r.memory_id,
      title: r.title,
      score: r.score,
      fragment_preview: r.fragment.substring(0, 200),
    })),
    has_more: page.has_more,
    next_offset: page.next_offset,
  };

  return buildResult({ text: output, data: structured, format: responseFormat });
}

export async function handleCallTool(request: ToolCallRequest): Promise<ToolResult> {
  const { name, arguments: args } = request.params;

  logger.request(name, args as Record<string, unknown>);
  const startTime = Date.now();

  try {
    switch (name) {
      case "session_start": {
        const result = await handleSessionStart(args as SessionStartArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "session_end": {
        const result = await handleSessionEnd(args as SessionEndArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "session_attempt": {
        const result = await handleSessionAttempt(args as SessionAttemptArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "suggestion_respond": {
        const result = await handleSuggestionRespond(args as SuggestionRespondArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_read": {
        const result = await handleMemoryRead(args as MemoryReadArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_add": {
        const result = await handleMemoryAdd(args as MemoryAddArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_update": {
        const result = await handleMemoryUpdate(args as MemoryUpdateArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_forget": {
        const result = await handleMemoryForget(args as MemoryForgetArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_feedback": {
        const result = await handleMemoryFeedback(args as MemoryFeedbackArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_merge": {
        const result = await handleMemoryMerge(args as MemoryMergeArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_relate": {
        const result = await handleMemoryRelate(args as MemoryRelateArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_stats": {
        const result = await handleMemoryStats(args as MemoryStatsArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_audit": {
        const result = await handleMemoryAudit(args as { response_format?: "markdown" | "json" });
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_get": {
        const result = await handleGuideGet(args as GuideGetArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_practice": {
        const result = await handleGuidePractice(args as GuidePracticeArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_create": {
        const result = await handleGuideCreate(args as GuideCreateArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_distill": {
        const result = await handleGuideDistill(args as GuideDistillArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_update": {
        const result = await handleGuideUpdate(args as GuideUpdateArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_forget": {
        const result = await handleGuideForget(args as GuideForgetArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "guide_merge": {
        const result = await handleGuideMerge(args as GuideMergeArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "session_stats": {
        const result = await handleSessionStats(args as SessionStatsArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "memory_library": {
        const result = await handleMemoryLibrary(args as MemoryLibraryArgs);
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "conflict_scan": {
        const result = await handleConflictScan(args as { project?: string; response_format?: "markdown" | "json" });
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "proactive_analysis": {
        const result = await handleProactiveAnalysis(args as { project?: string; response_format?: "markdown" | "json" });
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "project_analytics": {
        const result = await handleProjectAnalytics(args as { project?: string; response_format?: "markdown" | "json" });
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      case "semantic_search": {
        const result = await handleSemanticSearch(args as { query?: string; project?: string; topK?: number; offset?: number; response_format?: "markdown" | "json" });
        logger.response(name, !!result.isError, Date.now() - startTime);
        return result;
      }
      default: {
        logger.warn("handleCallTool unknown_tool", { tool: name });
        const result: ToolResult = {
          content: [{ type: "text", text: `Error: Unknown tool '${name}'` }],
          isError: true,
        };
        logger.response(name, true, Date.now() - startTime);
        return result;
      }
    }
  } catch (error) {
    const err = error as Error;
    logger.error("handleCallTool exception", { tool: name, error: err.message });
    logger.response(name, true, Date.now() - startTime, { error: err.message });
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}
