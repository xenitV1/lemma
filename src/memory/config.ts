import os from "os";
import path from "path";
import fs from "fs";
import type { LemmaConfig } from "../types.js";
import { logger } from "../logger.js";

const CONFIG_PATH = path.join(os.homedir(), ".lemma", "config.json");

const DEFAULT_CONFIG: LemmaConfig = {
  token_budget: {
    full_content: 5000,
    summary_index: 1000,
    guides_detail: 1000,
    instructions: 1500,
    continuity: 800,
  },
  injection: {
    max_full_content_fragments: 15,
    max_summary_fragments: 30,
    max_guides: 20,
    max_guide_detail: 3,
  },
  virtual_session: {
    timeout_minutes: 30,
    idle_timeout_seconds: 120,
  },
  eviction: {
    // Off by default (unbounded, today's behavior). A high threshold applies
    // only once enabled; eviction archives the coldest fragments, never deletes.
    enabled: false,
    max_fragments: 10000,
  },
  decay: {
    // Default keeps today's exact behavior (flat linear); the ebbinghaus curve
    // is opt-in until validated on real data (roadmap B5).
    model: "linear",
    half_life_days: {
      pattern: 180,
      context: 120,
      lesson: 90,
      fact: 60,
      warning: 30,
    },
  },
};

let _config: LemmaConfig | null = null;
let _configDir: string | null = null;

export function setConfigDir(dir: string): void {
  _configDir = dir;
}

function getConfigPath(): string {
  return _configDir ? path.join(_configDir, "config.json") : CONFIG_PATH;
}

export function loadConfig(): LemmaConfig {
  if (_config) return _config;

  logger.data("config.json", "load_start");

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const userConfig = JSON.parse(raw);
      _config = deepMerge(DEFAULT_CONFIG, userConfig);
      logger.data("config.json", "loaded", { hasCustom: true });
    } else {
      _config = { ...DEFAULT_CONFIG };
      fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
      logger.data("config.json", "created_with_defaults");
    }
  } catch {
    _config = { ...DEFAULT_CONFIG };
    logger.data("config.json", "using_defaults");
  }

  return _config;
}

export function resetConfig(): void {
  _config = null;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target: LemmaConfig, source: Record<string, unknown>): LemmaConfig {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const srcVal = (source as Record<string, unknown>)[key];
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal)) {
      result[key] = deepMerge((result[key] || {}) as LemmaConfig, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result as unknown as LemmaConfig;
}

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}
