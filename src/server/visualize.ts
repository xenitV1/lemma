import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { initDatabase, getDb } from "../db/index.js";
import * as memoryStore from "../db/memory-store.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "visualizer.html");
const DEFAULT_PORT = 3456;

// CORS allow-list: populated by startVisualizeServer once the bound port is known.
// Kept at module scope so the module-level helpers (jsonResponse, OPTIONS preflight)
// can call corsOrigin without depending on server-local state.
let allowedOrigins: string[] = [];

function corsOrigin(req: http.IncomingMessage): string | undefined {
  const o = req.headers.origin;
  return o && allowedOrigins.includes(o) ? o : undefined;
}

/**
 * Verify the per-startup token on an incoming request. Accepts either the
 * `x-lemma-token` header (used by the SPA's fetch calls) or a `?token=` query
 * parameter (used by `window.open('/api/export', ...)`, which cannot set custom
 * headers). Pure / DB-free so it can be unit tested in isolation.
 */
export function verifyToken(
  req: http.IncomingMessage,
  url: URL,
  token: string,
): boolean {
  if (req.headers["x-lemma-token"] === token) return true;
  const q = url.searchParams.get("token");
  return q === token;
}

function getHTML(): string {
  return fs.readFileSync(HTML_PATH, "utf-8");
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  const headers: http.OutgoingHttpHeaders = { "Content-Type": "application/json" };
  const origin = corsOrigin(req);
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (process.platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}" 2>/dev/null || true`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.error(`[Lemma Visualizer] Could not open browser: ${err.message}`);
      console.error(`[Lemma Visualizer] Open manually: ${url}`);
    }
  });
}

function resolveNumericId(db: ReturnType<typeof getDb>, legacyId: string): number | null {
  const row = db
    .prepareCached("SELECT id FROM memories WHERE legacy_id = ?")
    .get(legacyId) as { id: number } | undefined;
  return row?.id ?? null;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: ReturnType<typeof getDb>,
  html: string,
  token: string,
): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost`);

  if (req.method === "OPTIONS") {
    const h: http.OutgoingHttpHeaders = {
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Lemma-Token",
    };
    const origin = corsOrigin(req);
    if (origin) h["Access-Control-Allow-Origin"] = origin;
    res.writeHead(204, h);
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/api/health") {
    jsonResponse(req, res, { status: "ok" });
    return;
  }

  // All /api/* endpoints require the startup token (header), except /api/export which
  // also accepts ?token= (window.open cannot send custom headers).
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/export") {
    if (!verifyToken(req, url, token)) {
      jsonResponse(req, res, { error: "Unauthorized" }, 401);
      return;
    }
  }

  if (url.pathname === "/api/data" && req.method === "GET") {
    const fragments = memoryStore.searchMemories(db, "", { all: true, topK: 100000 });
    jsonResponse(req, res, fragments);
    return;
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const stats = memoryStore.getMemoryStats(db);
    const relationCount = (
      db.prepareCached("SELECT COUNT(*) as c FROM relations").get() as { c: number }
    ).c;
    const projects = (
      db.prepareCached(
        "SELECT DISTINCT COALESCE(project, '(global)') as p FROM memories"
      ).all() as { p: string }[]
    ).map((r) => r.p);
    jsonResponse(req, res, {
      total: stats.total,
      projects,
      relations: relationCount,
      avgConfidence: stats.avg_confidence,
    });
    return;
  }

  if (url.pathname.startsWith("/api/fragments/") && req.method === "PATCH") {
    const legacyId = url.pathname.replace("/api/fragments/", "");
    const body = JSON.parse(await parseBody(req));
    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.fragment !== undefined) updates.fragment = body.fragment;
    if (body.confidence !== undefined) updates.confidence = Number(body.confidence);
    if (body.type !== undefined) updates.type = body.type;
    if (body.project !== undefined) updates.project = body.project || null;
    const ok = memoryStore.updateMemory(db, legacyId, updates);
    jsonResponse(req, res, ok ? { ok: true } : { ok: false, error: "Not found" }, ok ? 200 : 404);
    return;
  }

  if (url.pathname.startsWith("/api/fragments/") && req.method === "DELETE") {
    const legacyId = decodeURIComponent(url.pathname.replace("/api/fragments/", ""));
    const ok = memoryStore.deleteMemory(db, legacyId);
    jsonResponse(req, res, ok ? { ok: true } : { ok: false, error: "Not found" }, ok ? 200 : 404);
    return;
  }

  if (url.pathname === "/api/relations" && req.method === "POST") {
    const body = JSON.parse(await parseBody(req));
    const sourceLegacy = body.source as string;
    const targetLegacy = body.target as string;
    const type = body.type as string;

    const sourceId = resolveNumericId(db, sourceLegacy);
    const targetId = resolveNumericId(db, targetLegacy);

    if (!sourceId || !targetId) {
      jsonResponse(req, res, { ok: false, error: "Source or target not found" }, 404);
      return;
    }

    const ok = memoryStore.addRelation(db, sourceId, targetId, type, body.note);
    jsonResponse(req, res, ok ? { ok: true } : { ok: false, error: "Failed" });
    return;
  }

  if (url.pathname === "/api/relations" && req.method === "DELETE") {
    const body = JSON.parse(await parseBody(req));
    const sourceLegacy = body.source as string;
    const targetLegacy = body.target as string;
    const type = body.type as string;

    const sourceId = resolveNumericId(db, sourceLegacy);
    const targetId = resolveNumericId(db, targetLegacy);

    if (!sourceId || !targetId) {
      jsonResponse(req, res, { ok: false, error: "Not found" }, 404);
      return;
    }

    const result = db
      .prepareCached(
        "DELETE FROM relations WHERE source_id = ? AND target_id = ? AND type = ?"
      )
      .run(sourceId, targetId, type);

    const reverseResult = db
      .prepareCached(
        "DELETE FROM relations WHERE source_id = ? AND target_id = ?"
      )
      .run(targetId, sourceId);

    const deleted = result.changes + reverseResult.changes;
    jsonResponse(req, res, { ok: deleted > 0, deleted });
    return;
  }

  if (url.pathname === "/api/export" && req.method === "GET") {
    // Export is triggered via window.open() which cannot set custom headers,
    // so accept the token via query param in addition to the header.
    if (req.headers["x-lemma-token"] !== token && url.searchParams.get("token") !== token) {
      jsonResponse(req, res, { error: "Unauthorized" }, 401);
      return;
    }
    const fragments = memoryStore.searchMemories(db, "", { all: true, topK: 100000 });
    const lines = fragments.map((f) => JSON.stringify(f)).join("\n");
    res.writeHead(200, {
      "Content-Type": "application/x-jsonlines",
      "Content-Disposition": "attachment; filename=memory-export.jsonl",
    });
    res.end(lines);
    return;
  }

  jsonResponse(req, res, { error: "Not found" }, 404);
}

export function startVisualizeServer(portArg?: number): Promise<void> {
  initDatabase();
  const db = getDb();
  const html = getHTML();
  const port = portArg || DEFAULT_PORT;
  allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  // Per-startup token: injected into the served HTML so the SPA can read it from
  // a <meta> tag and send it back as the X-Lemma-Token header on every API call.
  // Not persisted, not logged — valid only for this process lifetime.
  const token = crypto.randomUUID();
  const safeHtml = html.replace("__LEMMA_TOKEN__", token);

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, db, safeHtml, token).catch((err) => {
        logger.error("Visualizer request error", (err as Error).message);
        jsonResponse(req, res, { error: "Internal server error" }, 500);
      });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Lemma Visualizer] Port ${port} is already in use.`);
        console.error(`[Lemma Visualizer] Try: lemma -vis -p ${port + 1}`);
        process.exit(1);
      } else {
        console.error(`[Lemma Visualizer] Server error: ${err.message}`);
        process.exit(1);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const url = `http://localhost:${port}`;
      console.error(``);
      console.error(`  ┌──────────────────────────────────────────┐`);
      console.error(`  │  Lemma Memory Visualizer                  │`);
      console.error(`  │  ${url.padEnd(42)}│`);
      console.error(`  │  Press Ctrl+C to stop                     │`);
      console.error(`  └──────────────────────────────────────────┘`);
      console.error(``);
      openBrowser(url);
      resolve();
    });

    const shutdown = () => {
      console.error(`\n[Lemma Visualizer] Shutting down...`);
      server.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
