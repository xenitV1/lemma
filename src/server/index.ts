#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as core from "../memory/index.js";
import * as guides from "../guides/index.js";
import * as virtualSession from "../sessions/virtual.js";
import { BASE_SYSTEM_PROMPT, buildInstructions, buildInjectedTools } from "./system-prompt.js";
import { TOOLS } from "./tools.js";
import { handleCallTool, autoStartSession, autoEndSession } from "./handlers.js";
import { installSkill } from "./install-skill.js";
import { triggerHook, HookTypes } from "./hooks.js";
import * as core_config from "../memory/config.js";
import { initDatabase, getDb } from "../db/index.js";
import { collectLibrarySnapshot, formatLibrarySnapshot } from "../db/library-store.js";
import { setNotifyChange } from "./handlers.js";
import { logger, initLogger } from "../logger.js";
import * as traffic from "./traffic-log.js";
import * as agentsMd from "./agents-md.js";
import { VERSION } from "../version.js";

export let detectedProject: string | null = null;
let server: Server | null = null;
let serverKeepAlive: ReturnType<typeof setInterval> | null = null;
let stdinEndHandlerAttached = false;

export function setDetectedProject(p: string | null): void {
  detectedProject = p;
}

function createServer(instructions: string): Server {
  const instance = new Server(
    {
      name: "lemma",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: true,
        },
      },
      instructions,
    }
  );

instance.setRequestHandler(ListToolsRequestSchema, async () => {
  traffic.logIncoming({ method: "tools/list", params: null });
  const tools = await buildInjectedTools(detectedProject);
  return { tools };
});

instance.setRequestHandler(ListResourcesRequestSchema, async () => {
  traffic.logIncoming({ method: "resources/list", params: null });
  const resources = [
    {
      uri: "lemma://system-prompt",
      name: "Lemma System Prompt",
      description: "System prompt for LLM clients using Lemma memory",
      mimeType: "text/markdown",
    },
  ];

  logger.flow("resources/list", "responded", { count: resources.length });

  return { resources };
});

instance.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  traffic.logIncoming({ method: "resources/read", params: request.params ?? {} });
  const { uri } = request.params as { uri: string };

  logger.flow("resources/read", "requested", { uri });

  if (uri === "lemma://system-prompt") {
    logger.flow("resources/read", "system-prompt", { uri });
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: BASE_SYSTEM_PROMPT,
        },
      ],
    };
  }

  if (uri.startsWith("lemma://memory/")) {
    const id = uri.replace("lemma://memory/", "");
    logger.flow("resources/read", "memory/id", { uri, memory_id: id });
    const memory: any[] = core.loadMemory();
    const fragment = memory.find((f: any) => f.id === id);

    if (!fragment) {
      throw new Error(`Memory fragment not found: ${id}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(fragment, null, 2),
        },
      ],
    };
  }

  if (uri.startsWith("lemma://guides/")) {
    const guideName = uri.replace("lemma://guides/", "").toLowerCase();
    logger.flow("resources/read", "guides/name", { uri, guide: guideName });
    const allGuides: any[] = guides.loadGuides();
    const guide = allGuides.find((g: any) => g.guide === guideName);

    if (!guide) {
      throw new Error(`Guide not found: ${guideName}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(guide, null, 2),
        },
      ],
    };
  }

  logger.flow("resources/read", "unknown", { uri });
  throw new Error(`Unknown resource: ${uri}`);
});

instance.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
  const toolName = (request.params as any).name as string;
  const start = Date.now();
  traffic.logIncoming({ method: "tools/call", params: request.params ?? {}, id: (request as any).id ?? null });

  const argsSummary: Record<string, unknown> = {};
  const rawArgs = (request.params as any).arguments;
  if (rawArgs) {
    for (const [k, v] of Object.entries(rawArgs)) {
      if (typeof v === "string" && (v as string).length > 80) {
        argsSummary[k] = (v as string).substring(0, 80) + "...";
      } else {
        argsSummary[k] = v;
      }
    }
  }
  logger.request("tools/call", { name: toolName, args_summary: argsSummary });

  try {
    const result = await handleCallTool(request);
    const duration = Date.now() - start;
    logger.toolCall(toolName, (request.params as any).arguments, duration);
    if (result.isError) {
      const text = result.content?.[0]?.text || "";
      logger.warn(`Tool ${toolName} returned error: ${text}`);
    }
    logger.response("tools/call", !!result.isError, duration, { tool: toolName });
    if (toolName !== "session_end") {
      try {
        virtualSession.recordToolCall(
          toolName,
          (request.params as any).arguments,
          result,
          detectedProject
        );
      } catch (e) {
        logger.debug("recordToolCall threw", { error: (e as Error).message });
      }
    }

    logger.debug("tool response", { tool: toolName, isError: !!result.isError, hasContent: !!result.content?.[0]?.text });

    if (
      !result.isError &&
      toolName !== "memory_add" &&
      toolName !== "memory_update" &&
      toolName !== "memory_feedback" &&
      toolName !== "guide_practice"
    ) {
      const reminder = virtualSession.getReminderText();
      if (reminder && result.content?.[0]?.text) {
        result.content[0].text += reminder;
        logger.debug("Reminder appended", { tool: toolName });
      }
    }

    const sessionEndMsg = virtualSession.consumeSessionEndMessage();
    logger.debug("sessionEndMsg consumed", { hasMessage: !!sessionEndMsg });
    if (sessionEndMsg && result.content?.[0]?.text) {
      result.content[0].text += sessionEndMsg;
      logger.debug("Session end message appended", { tool: toolName });
    } else if (sessionEndMsg) {
      logger.debug("Session end message set but no text content", { tool: toolName });
    }

    const sessionStartMsg = virtualSession.consumeSessionStartMessage();
    logger.debug("sessionStartMsg consumed", { hasMessage: !!sessionStartMsg });
    if (sessionStartMsg && result.content?.[0]?.text) {
      result.content[0].text += sessionStartMsg;
      logger.debug("Session start message appended", { tool: toolName });
    } else if (sessionStartMsg) {
      logger.debug("Session start message set but no text content", { tool: toolName });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error(`Tool ${toolName} threw after ${duration}ms: ${(error as Error).message}`);
    logger.response("tools/call", true, duration, { tool: toolName });
    throw error;
  }
}) as any);

  return instance;
}

export function getServer(): Server {
  if (!server) {
    server = createServer(buildInstructions(detectedProject));
  }
  return server;
}

async function initializeContext(): Promise<void> {
  initLogger();
  initDatabase();
  logger.flow("initialize_context", "entry");

  const cfg = core_config.loadConfig();
  logger.flow("initialize_context", "config_loaded", {
    token_budget_full: cfg.token_budget.full_content,
    virtual_session_timeout: cfg.virtual_session.timeout_minutes,
    max_full_content_fragments: cfg.injection.max_full_content_fragments,
  });

  virtualSession.setVirtualSessionConfig(cfg.virtual_session);
  virtualSession.setAutoStartSession(() => autoStartSession(detectedProject));
  virtualSession.setAutoEndSession((vs) => autoEndSession(vs));
  virtualSession.setFindMissingGuides((techs) => {
    const allGuides = guides.loadGuides();
    return techs.filter(t => !guides.findGuide(allGuides, t));
  });
  logger.flow("initialize_context", "virtual_session_config_set");

  const memory = core.loadMemory();
  const seedResult = core.seedMemory(memory);
  if (seedResult.seeded > 0) {
    core.saveMemory(memory);
    logger.flow("initialize_context", "seeded", seedResult);
  }

  const allGuidesForSeed = guides.loadGuides();
  const guideSeedResult = guides.seedGuides(allGuidesForSeed);
  if (guideSeedResult.seeded > 0) {
    guides.saveGuides(allGuidesForSeed);
    logger.flow("initialize_context", "guide_seeded", guideSeedResult);
  }

  const migrated = core.migrateConfidenceFloor();
  if (migrated > 0) {
    logger.info(`Migration: boosted ${migrated} fragments to 0.3 floor`);
    logger.flow("initialize_context", "migration", { migrated });
  } else {
    logger.flow("initialize_context", "migration", { migrated: 0 });
  }

  core.applySessionDecay();
  logger.flow("initialize_context", "decay_applied");

  // B1: capacity-driven Heat eviction (opt-in; no-op unless configured).
  const evicted = core.applyEviction();
  if (evicted > 0) {
    logger.info(`Eviction: archived ${evicted} cold fragment(s)`);
  }
  logger.flow("initialize_context", "eviction_applied", { evicted });

  detectedProject = core.detectProject();

  if (detectedProject) {
    logger.info(`Detected project: ${detectedProject}`);

    const memory: any[] = core.loadMemory();
    const projectFragments = core.filterByProject(memory, detectedProject);

    if (projectFragments.length > 0) {
      logger.info(`Found ${projectFragments.length} memory fragment(s) for this project`);
    } else {
      logger.info(`No saved memories for this project yet`);
    }

    const projectDir = process.cwd();
    if (projectDir) {
      try {
        const removed = agentsMd.removeAgentsMd(projectDir);
        if (removed) {
          logger.info("AGENTS.md: removed stale Lemma block (migration to MCP instructions)");
        }
      } catch (e) {
        logger.warn("Failed to clean AGENTS.md", (e as Error).message);
      }
    }
  } else {
    logger.info(`No project detected (running in global context)`);
  }

  logger.flow("initialize_context", "hook_trigger", { hook: HookTypes.ON_START });
  await triggerHook(HookTypes.ON_START, {
    project: detectedProject,
    timestamp: new Date().toISOString(),
  });
  logger.flow("initialize_context", "complete");
}

export async function runLibMode(): Promise<void> {
  initLogger();
  initDatabase();

  const db = getDb();
  const snapshot = collectLibrarySnapshot(db, { project: null, focus: "full" });
  const formatted = formatLibrarySnapshot(snapshot, "full");

  process.stdout.write(formatted + "\n");
  process.exit(0);
}

export async function startServer(): Promise<void> {
  logger.flow("server", "starting");
  traffic.initTrafficLogger();

  const origStdoutWrite = process.stdout.write;

  (process.stdout as any).write = function (data: unknown, ...args: unknown[]): boolean {
    if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          traffic.logOutgoing(parsed);
        } catch {}
      }
    }
    return (origStdoutWrite as any).apply(process.stdout, [data, ...args]);
  };

  await initializeContext();

  // Runtime safety net: ensure the Lemma SKILL.md exists and is current for
  // skill-format clients (e.g. Codex, which does not inject MCP `instructions`
  // into the system prompt). Idempotent — a no-op when already up to date.
  try {
    const skillResult = installSkill();
    logger.flow("server", "skill_install", skillResult);
    if (skillResult.installed) {
      logger.info(`Skill installed: ${skillResult.path} (${skillResult.reason})`);
    }
  } catch (e) {
    logger.warn("Skill install failed", (e as Error).message);
  }

  const activeServer = createServer(buildInstructions(detectedProject));
  server = activeServer;

  logger.flow("server", "creating_transport");
  const transport = new StdioServerTransport();
  await activeServer.connect(transport);
  process.stdin.resume();
  if (!serverKeepAlive) {
    serverKeepAlive = setInterval(() => {}, 60 * 60 * 1000);
  }
  if (!stdinEndHandlerAttached) {
    process.stdin.on("end", () => gracefulShutdown("STDIN_END"));
    stdinEndHandlerAttached = true;
  }
  logger.info("Server connected via stdio transport");
  logger.flow("server", "connected");

  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  setNotifyChange(() => {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      logger.notify("notifications/tools/list_changed", "debounced");
      activeServer.notification({ method: "notifications/tools/list_changed" }).then(() => {
        logger.notify("notifications/tools/list_changed", "sending");
      }).catch((e) => {
        logger.notify("notifications/tools/list_changed", "failed", (e as Error).message);
      });
    }, 100);
  });

  logger.flow("server", "notify_callback_set");
}

function gracefulShutdown(signal: string): void {
  logger.flow("server", "shutdown_received", { signal });
  logger.flow("server", "shutdown", { signal });
  if (serverKeepAlive) {
    clearInterval(serverKeepAlive);
    serverKeepAlive = null;
  }

  const vs = virtualSession.getCurrentVirtualSession();
  if (vs && vs.tool_calls.length > 0) {
    const finalized = virtualSession.finalizeVirtualSession();
    if (finalized) {
      logger.flow("server", "virtual_session_finalized", { id: finalized.id });
    }
  } else {
    logger.flow("server", "virtual_session_finalize_skipped", { reason: "none" });
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
