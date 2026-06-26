/**
 * Installs Lemma's SKILL.md to `~/.agents/skills/lemma/SKILL.md`.
 *
 * Used in two places:
 *  - npm `postinstall` (and `lemma --install-skill`): writes on install/upgrade.
 *  - Server startup (runtime safety net): re-checks every launch so the file
 *    stays current even for users who run via `npx` or never reinstall.
 *
 * Idempotent + version-aware: if the installed file's version stamp already
 * matches the running VERSION, it is left untouched. On upgrade the stamp
 * diverges and the file is overwritten. Errors are swallowed (warned) — this
 * is a side effect and must never break the MCP server or CLI flow.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { buildSkillContent, parseSkillVersion } from "./skill-content.js";
import { VERSION } from "../version.js";

export const SKILL_DIR = path.join(os.homedir(), ".agents", "skills", "lemma");
export const SKILL_FILE = path.join(SKILL_DIR, "SKILL.md");

export interface InstallSkillResult {
  /** True if the file was written/updated during this call. */
  installed: boolean;
  /** True if no write was needed (already current, or skipped on error). */
  skipped: boolean;
  path: string;
  reason?: string;
}

export function getSkillPath(): string {
  return SKILL_FILE;
}

/**
 * Write the SKILL.md unless it is already current.
 *
 * @param opts.skillDir Override the target directory (used by tests to sandbox
 *   writes away from the real `~/.agents/skills/lemma/`). Defaults to SKILL_DIR.
 */
export function installSkill(opts?: { skillDir?: string }): InstallSkillResult {
  const skillDir = opts?.skillDir ?? SKILL_DIR;
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    const content = buildSkillContent();

    // Idempotent + version-aware: skip if the current version is already installed.
    if (fs.existsSync(skillFile)) {
      try {
        const existing = fs.readFileSync(skillFile, "utf-8");
        const installedVersion = parseSkillVersion(existing);
        if (installedVersion === VERSION) {
          return { installed: false, skipped: true, path: skillFile, reason: `up to date (v${VERSION})` };
        }
      } catch {
        // unreadable/unparseable → fall through and overwrite below
      }
    }

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }
    fs.writeFileSync(skillFile, content, "utf-8");
    return { installed: true, skipped: false, path: skillFile, reason: `installed v${VERSION}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lemma] skill install skipped: ${msg}`);
    return { installed: false, skipped: true, path: skillFile, reason: `error: ${msg}` };
  }
}

// CLI entry point: `node dist/server/install-skill.js` (postinstall) or `lemma --install-skill`.
const invokedAs = process.argv[1];
const isMain = !!invokedAs && import.meta.url === pathToFileURL(invokedAs).href;
if (isMain) {
  const result = installSkill();
  const tag = result.installed ? "skill installed" : "skill";
  console.log(`[lemma] ${tag}: ${result.reason ?? "skipped"} -> ${result.path}`);
  process.exit(0);
}
