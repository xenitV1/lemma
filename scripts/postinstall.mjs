// Postinstall bootstrap: writes Lemma's SKILL.md to ~/.agents/skills/lemma/ so
// skill-format clients (Codex, Claude Code) load Lemma's usage rules.
//
// Guarded: no-op when dist/ is absent — e.g. cloning the source repo (where
// dist/ is gitignored) or running `npm ci` before `npm run build` in CI.
// Published packages always ship dist/, so real consumers always run this.
//
// Never throws: a side-effect skill file must not fail the install.
import fs from "node:fs";

try {
  if (fs.existsSync("dist/server/install-skill.js")) {
    const { installSkill } = await import("../dist/server/install-skill.js");
    const result = installSkill();
    if (result.installed) {
      console.log(`[lemma] skill: ${result.reason} -> ${result.path}`);
    }
  }
} catch {
  // Swallow — never fail the install over a skill file.
}
