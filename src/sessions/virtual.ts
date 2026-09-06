import os from "os";
import path from "path";
import fs from "fs";
import { logger } from "../logger.js";
import * as guides from "../guides/index.js";
import type { VirtualSession, ToolCallEntry } from "../types.js";

let _autoStartFn: ((project: string | null) => void) | null = null;
let _autoEndFn: ((vs: FinalizedVirtualSession) => void) | null = null;
let _findMissingGuidesFn: ((techs: string[]) => string[]) | null = null;

export function setAutoStartSession(fn: (project: string | null) => void): void {
  _autoStartFn = fn;
}

export function setAutoEndSession(fn: (vs: FinalizedVirtualSession) => void): void {
  _autoEndFn = fn;
}

export function setFindMissingGuides(fn: (techs: string[]) => string[]): void {
  _findMissingGuidesFn = fn;
}

interface FinalizedVirtualSession {
  id: string;
  started_at: string;
  tool_calls: ToolCallEntry[];
  project: string | null;
  guides_used: string[];
  memories_accessed: string[];
  memories_created: string[];
  ended_at: string;
  duration_tool_calls: number;
  technologies: string[];
}

const SESSION_LOG_DIR = path.join(os.homedir(), ".lemma", "sessions");
let _logDir: string | null = null;

export function setSessionLogDir(dir: string): void {
  _logDir = dir;
}

function getLogDir(): string {
  return _logDir || SESSION_LOG_DIR;
}

function ensureLogDir(): string {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

let currentVirtualSession: VirtualSession | null = null;
let sessionTimeout: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleSince: number | null = null;
const IDLE_THRESHOLD_MS = 2 * 60_000;
const IDLE_MARK_MS = 30_000;
let config: { timeout_minutes: number } = { timeout_minutes: 30 };

let _pendingSessionEndMessage: string | null = null;
let _pendingSessionStartMessage: string | null = null;

export function setVirtualSessionConfig(cfg: { timeout_minutes: number; idle_timeout_seconds?: number } | null): void {
  if (cfg) {
    config = {
      timeout_minutes: cfg.timeout_minutes,
    };
  }
}

export function recordToolCall(toolName: string, args: any, result: any, detectedProject?: string | null): VirtualSession {
  logger.flow("virtual_session", "record_tool", { tool: toolName });

  if (currentVirtualSession && idleSince !== null) {
    const idleMs = Date.now() - idleSince;
    if (idleMs >= IDLE_THRESHOLD_MS) {
      logger.flow("virtual_session", "finalize_on_next_call", {
        sessionId: currentVirtualSession.id,
        idleMs,
        toolCalls: currentVirtualSession.tool_calls.length,
      });
      finalizeVirtualSession();
    } else {
      idleSince = null;
      logger.flow("virtual_session", "continue_session", {
        sessionId: currentVirtualSession.id,
        idleMs,
      });
    }
  }

  const entry: ToolCallEntry = {
    tool: toolName,
    timestamp: new Date().toISOString(),
    args_summary: summarizeArgs(toolName, args),
    result_summary: summarizeResult(result),
  };

  if (!currentVirtualSession) {
    currentVirtualSession = {
      id: "vs_" + Date.now().toString(36),
      started_at: new Date().toISOString(),
      tool_calls: [],
      project: detectedProject || null,
      technologies_seen: new Set(),
      guides_used: new Set(),
      memories_accessed: [],
      memories_created: [],
    };
    idleSince = null;
    logger.flow("virtual_session", "created", { id: currentVirtualSession.id });

    if (_autoStartFn) {
      logger.flow("virtual_session", "auto_start_calling", { fn: "set" });
      try {
        _autoStartFn(currentVirtualSession.project);
        logger.flow("virtual_session", "auto_start_completed");
      } catch (e) {
        logger.error("auto_start_session failed", (e as Error).message);
        logger.flow("virtual_session", "auto_start_failed", { error: (e as Error).message });
      }
    } else {
      logger.flow("virtual_session", "auto_start_skipped", { reason: "fn_not_set" });
    }

    _pendingSessionStartMessage = `\n\n---\n**[Lemma] Session started** (${currentVirtualSession.id}). When you finish this task, call session_end with outcome and lessons. Use memory_add to persist insights, guide_practice to track skill usage.`;
  }

  currentVirtualSession.tool_calls.push(entry);
  logger.flow("virtual_session", "recorded", { tool: toolName, entryCount: currentVirtualSession.tool_calls.length });

  extractSessionData(toolName, args, result, currentVirtualSession);

  const detectedTechs = detectTechnologies(toolName, args);
  for (const tech of detectedTechs) {
    currentVirtualSession.technologies_seen.add(tech);
  }

  resetIdleTimer();
  resetTimeout();

  return currentVirtualSession;
}

export function shouldRemindSave(): boolean {
  if (!currentVirtualSession) return false;
  const tc = currentVirtualSession.tool_calls.length;
  const saved = currentVirtualSession.memories_created.length;
  return tc >= 5 && saved === 0 && tc % 5 === 0;
}

export function shouldRemindGuide(): boolean {
  if (!currentVirtualSession) return false;
  const tc = currentVirtualSession.tool_calls.length;
  const practiced = [...currentVirtualSession.guides_used].length;
  return tc >= 4 && practiced === 0 && tc % 6 === 0;
}

export function getReminderText(): string {
  const parts: string[] = [];
  if (shouldRemindSave()) {
    parts.push("[Lemma] You've made several tool calls without saving. If you've learned something worth persisting (pattern, decision, bug fix, architectural insight), call memory_add before this conversation ends.");
  }
  if (shouldRemindGuide() && currentVirtualSession) {
    const techs = [...currentVirtualSession.technologies_seen];
    if (techs.length > 0) {
      const missing: string[] = _findMissingGuidesFn ? _findMissingGuidesFn(techs) : [];
      if (missing.length > 0) {
        parts.push(`[Lemma] No guides found for: ${missing.join(", ")}. If you've developed a reusable approach, call guide_create to capture it. For existing guides, call guide_practice to track experience.`);
      } else {
        parts.push(`[Lemma] Technologies detected: ${techs.join(", ")}. Call guide_practice to track your experience and build competence over time.`);
      }
    }
  }
  return parts.length > 0 ? "\n\n" + parts.join("\n") : "";
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleSince = null;
  idleTimer = setTimeout(() => {
    if (currentVirtualSession && currentVirtualSession.tool_calls.length > 0) {
      idleSince = Date.now();
      logger.flow("virtual_session", "marked_idle", {
        sessionId: currentVirtualSession.id,
        toolCalls: currentVirtualSession.tool_calls.length,
      });
    }
  }, IDLE_MARK_MS);
  idleTimer.unref();
}

function resetTimeout(): void {
  logger.flow("virtual_session", "timeout_reset", { minutes: config.timeout_minutes });
  if (sessionTimeout) clearTimeout(sessionTimeout);
  sessionTimeout = setTimeout(() => {
    logger.flow("virtual_session", "absolute_timeout", {});
    finalizeVirtualSession();
  }, config.timeout_minutes * 60 * 1000);
  sessionTimeout.unref();
}

function summarizeArgs(tool: string, args: any): string | null {
  if (!args) return null;
  switch (tool) {
    case "memory_read":
      return args.id ? `id=${args.id}` : args.query ? `query=${args.query}` : "list";
    case "memory_add":
      return args.title || args.fragment?.slice(0, 50);
    case "guide_practice":
      return args.guide;
    case "memory_feedback":
      return `${args.id} useful=${args.useful}`;
    default:
      return null;
  }
}

function summarizeResult(result: any): string | null {
  if (!result?.content?.[0]?.text) return null;
  const text: string = result.content[0].text;
  if (text.length > 100) return text.slice(0, 100) + "...";
  return text;
}

function extractSessionData(tool: string, args: any, result: any, session: VirtualSession): void {
  switch (tool) {
    case "memory_read":
      if (args?.id) session.memories_accessed.push(args.id);
      if (args?.ids) {
        for (const id of args.ids) session.memories_accessed.push(id);
      }
      break;
    case "memory_add":
      if (args?.project) session.project = args.project;
      const addedId = result?.content?.[0]?.text?.match(/\[(m[0-9a-f]+)\]/)?.[1];
      if (addedId) session.memories_created.push(addedId);
      break;
    case "guide_practice":
      if (args?.guide) session.guides_used.add(args.guide.toLowerCase());
      if (args?.contexts) {
        for (const c of args.contexts) session.technologies_seen.add(c.toLowerCase());
      }
      break;
    case "memory_feedback":
      break;
  }
}

export function finalizeVirtualSession(): FinalizedVirtualSession | null {
  logger.flow("virtual_session", "finalize_start");
  if (!currentVirtualSession || currentVirtualSession.tool_calls.length === 0) {
    logger.flow("virtual_session", "finalize_skipped", { reason: "empty" });
    currentVirtualSession = null;
    return null;
  }

  const session: any = {
    ...currentVirtualSession,
    ended_at: new Date().toISOString(),
    duration_tool_calls: currentVirtualSession.tool_calls.length,
    technologies: [...currentVirtualSession.technologies_seen],
    guides_used: [...currentVirtualSession.guides_used],
  };

  delete session.technologies_seen;

  ensureLogDir();
  const filePath = path.join(getLogDir(), `${session.id}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
    logger.flow("virtual_session", "finalize_complete", { id: session.id, toolCalls: session.duration_tool_calls });
  } catch (error: any) {
    logger.error("Failed to write virtual session file:", { error: error.message, id: session.id });
  }

  try {
    const allGuides = guides.loadGuides();
    let autoTracked = 0;
    for (const tech of session.technologies || []) {
      const guide = guides.findGuide(allGuides, tech);
      if (guide) {
        guide.auto_usage_count = (guide.auto_usage_count || 0) + 1;
        guide.last_used = new Date().toISOString();
        autoTracked++;
      }
    }
    if (autoTracked > 0) {
      guides.saveGuides(allGuides);
      logger.flow("virtual_session", "auto_practice", { count: autoTracked });
    }
  } catch (error) {
    logger.error("Auto-practice failed", (error as Error).message);
  }

  currentVirtualSession = null;
  idleSince = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (sessionTimeout) {
    clearTimeout(sessionTimeout);
    sessionTimeout = null;
  }

  if (_autoEndFn) {
    try {
      _autoEndFn(session as FinalizedVirtualSession);
    } catch (e) {
      logger.error("auto_end_session failed", (e as Error).message);
    }
  }

  const techs = session.technologies || [];
  const toolCount = session.duration_tool_calls || 0;
  const memCreated = session.memories_created || [];
  const guidesUsed = session.guides_used || [];
  const project = session.project || "unknown";

  if (toolCount >= 1) {
    const parts: string[] = [
      `\n\n---`,
      `**[Lemma] Session ended** (${session.id})`,
      `Project: ${project} | Tool calls: ${toolCount}`,
    ];
    if (techs.length > 0) parts.push(`Technologies: ${techs.join(", ")}`);
    if (memCreated.length > 0) parts.push(`Memories created: ${memCreated.length}`);
    if (guidesUsed.length > 0) parts.push(`Guides: ${guidesUsed.join(", ")}`);
    parts.push(``);
    parts.push(`Synthesize this conversation: call memory_add with a concise summary of what was discussed, decided, or accomplished. Use type "context" and project "${project}".`);
    _pendingSessionEndMessage = parts.join("\n");
  } else {
    _pendingSessionEndMessage = null;
  }
  logger.flow("virtual_session", "finalize_done", { id: session.id, hasEndMessage: !!_pendingSessionEndMessage });

  return session as FinalizedVirtualSession;
}

export function getCurrentVirtualSession(): VirtualSession | null {
  return currentVirtualSession;
}

/** After restore, old callbacks must not write the prior session into new data. */
export function discardVirtualSession(): void {
  if (sessionTimeout) clearTimeout(sessionTimeout);
  if (idleTimer) clearTimeout(idleTimer);
  currentVirtualSession = null;
  sessionTimeout = null;
  idleTimer = null;
  idleSince = null;
  _pendingSessionEndMessage = null;
  _pendingSessionStartMessage = null;
}

export function consumeSessionEndMessage(): string | null {
  const msg = _pendingSessionEndMessage;
  _pendingSessionEndMessage = null;
  logger.debug("consumeSessionEndMessage", { hasMessage: !!msg });
  return msg;
}

export function consumeSessionStartMessage(): string | null {
  const msg = _pendingSessionStartMessage;
  _pendingSessionStartMessage = null;
  logger.debug("consumeSessionStartMessage", { hasMessage: !!msg });
  return msg;
}

export function getRecentSessions(count: number = 10): FinalizedVirtualSession[] {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) return [];

  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith("vs_") && f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, count);

    return files.map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as FinalizedVirtualSession;
      } catch { return null; }
    }).filter(Boolean) as FinalizedVirtualSession[];
  } catch {
    return [];
  }
}

export function detectTechnologies(tool: string, args: any): string[] {
  const techs: string[] = [];

  if (args?.contexts) {
    for (const c of args.contexts) techs.push(String(c).toLowerCase());
  }
  if (args?.technologies) {
    for (const t of args.technologies) techs.push(String(t).toLowerCase());
  }

  const text = [args?.fragment, args?.query, args?.description, args?.guide]
    .filter(Boolean)
    .join(" ");

  if (text) {
    const patterns: [string, RegExp][] = [
      ["react", /\breact\b/i],
      ["vue", /\bvue\b/i],
      ["angular", /\bangular\b/i],
      ["nextjs", /\bnext\.?js\b/i],
      ["sveltekit", /\bsveltekit\b/i],
      ["svelte", /\bsvelte\b/i],
      ["typescript", /\btypescript\b/i],
      ["python", /\bpython\b/i],
      ["nodejs", /\bnode\.?js\b|\bexpress\b/i],
      ["prisma", /\bprisma\b/i],
      ["supabase", /\bsupabase\b/i],
      ["docker", /\bdocker\b/i],
      ["jest", /\bjest\b/i],
      ["vitest", /\bvitest\b/i],
      ["seo", /\bseo\b|\bsitemap\b/i],
      ["git", /\bgit\b(?!hub)/i],
      ["astro", /\bastro\b/i],
      ["remix", /\bremix\b/i],
      ["hugo", /\bhugo\b/i],
    ];

    for (const [tech, pattern] of patterns) {
      if (pattern.test(text)) techs.push(tech);
    }
  }

  return [...new Set(techs)];
}
