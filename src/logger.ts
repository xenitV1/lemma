import os from "os";
import { redactSecrets } from "./memory/privacy.js";
import path from "path";
import fs from "fs";

const LOG_DIR = path.join(os.homedir(), ".lemma", "logs");
const MAX_LOG_FILES = 7;

let _logDir: string | null = null;
let _disabled = false;

export function setLogDir(dir: string): void {
  _logDir = dir;
}

export function disableLogger(): void {
  _disabled = true;
}

export function enableLogger(): void {
  _disabled = false;
}

function getLogDir(): string {
  return _logDir || LOG_DIR;
}

function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(getLogDir(), `lemma-${date}.log`);
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function rotateLogs(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) return;

  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("lemma-") && f.endsWith(".log"))
      .sort();

    while (files.length > MAX_LOG_FILES) {
      const toDelete = files.shift();
      if (toDelete) {
        fs.unlinkSync(path.join(dir, toDelete));
      }
    }
  } catch {}
}

function formatMessage(level: string, message: string, meta?: unknown): string {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level}] ${message}`;
  if (meta !== undefined) {
    line += " " + (typeof meta === "string" ? meta : JSON.stringify(meta));
  }
  return line;
}

function write(level: string, message: string, meta?: unknown): void {
  if (_disabled) return;
  try {
    ensureLogDir();
    const line = redactSecrets(formatMessage(level, message, meta)).redacted;
    fs.appendFileSync(getLogFilePath(), line + "\n", "utf-8");

    const mirrorToStderr = process.env.LEMMA_LOG_STDERR === "1" || process.env.LEMMA_DEBUG === "1";
    if (level === "ERROR" || mirrorToStderr) {
      console.error(`[Lemma] ${line}`);
    }
  } catch {}
}

// Preserve structure while redacting whole values before summaries truncate them.
function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value).redacted;
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLogValue(item)]));
  }
  return value;
}

function truncateStrings(obj: Record<string, unknown>, maxLen: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > maxLen) {
      result[k] = v.substring(0, maxLen) + "...";
    } else {
      result[k] = v;
    }
  }
  return result;
}

export const logger = {
  info(message: string, meta?: unknown): void {
    write("INFO", message, meta);
  },

  warn(message: string, meta?: unknown): void {
    write("WARN", message, meta);
  },

  error(message: string, meta?: unknown): void {
    write("ERROR", message, meta);
  },

  debug(message: string, meta?: unknown): void {
    write("DEBUG", message, meta);
  },

  toolCall(tool: string, args?: Record<string, unknown>, durationMs?: number): void {
    const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";
    const argSummary: Record<string, unknown> = {};
    if (args) {
      for (const [k, v] of Object.entries(redactLogValue(args) as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 80) {
          argSummary[k] = v.substring(0, 80) + "...";
        } else {
          argSummary[k] = v;
        }
      }
    }
    write("TOOL", `${tool}${duration}`, Object.keys(argSummary).length > 0 ? argSummary : undefined);
  },

  flow(flowName: string, step: string, meta?: unknown): void {
    write("INFO", `[FLOW] [${flowName}] ${step}`, meta);
  },

  request(method: string, params?: Record<string, unknown>): void {
    let filtered: Record<string, unknown> | undefined;
    if (params) {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(redactLogValue(params) as Record<string, unknown>)) {
        if (k !== "_meta") {
          cleaned[k] = v;
        }
      }
      if (Object.keys(cleaned).length > 0) {
        filtered = truncateStrings(cleaned, 100);
      }
    }
    write("DEBUG", `[REQ] ${method}`, filtered);
  },

  response(method: string, isError: boolean, durationMs: number, meta?: unknown): void {
    const status = isError ? "error" : "ok";
    const level = isError ? "WARN" : "INFO";
    write(level, `[RES] ${method} (${durationMs}ms) ${status}`, meta);
  },

  notify(method: string, status: "sending" | "debounced" | "failed", meta?: unknown): void {
    const level = status === "failed" ? "ERROR" : "INFO";
    write(level, `[NOTIFY] ${method} ${status}`, meta);
  },

  data(fileName: string, operation: string, meta?: unknown): void {
    write("DEBUG", `[DATA] ${fileName} ${operation}`, meta);
  },

  inject(target: string, tokens: number, count: number, meta?: unknown): void {
    write("INFO", `[INJECT] ${target} — ${tokens} tokens, ${count} items`, meta);
  },
};

export function initLogger(): void {
  ensureLogDir();
  rotateLogs();
  logger.info("Lemma MCP server starting");
}
