/** Client-safe. The prompt behind "Install the skill" on the home page: it installs only the
    emuly-playbook skill, with no key setup. Paths come from the vercel-labs/skills agent list
    and the vendors' docs (checked 2026-11-14). The prompt tells the agent to trust its own docs first. */
const BASE = "https://emuly.vercel.app";
const SKILL = "emuly-playbook";

export type SkillAgent = { name: string; id?: string; path?: string; docs?: string; note?: string; light: string; dark: string };

export const SKILL_AGENTS: SkillAgent[] = [
  { name: "Claude Code", light: "claude-ai-icon", dark: "claude-ai-icon", id: "claude-code", path: "~/.claude/skills/", docs: "https://code.claude.com/docs/en/skills" },
  { name: "Codex", light: "openai", dark: "openai_dark", id: "codex", path: "~/.agents/skills/", docs: "https://developers.openai.com/codex/skills" },
  { name: "Cursor", light: "cursor_light", dark: "cursor_dark", id: "cursor", path: "~/.cursor/skills/", docs: "https://cursor.com/docs/context/skills" },
  { name: "OpenCode", light: "opencode", dark: "opencode-dark", id: "opencode", path: "~/.config/opencode/skills/", docs: "https://opencode.ai/docs/skills" },
  { name: "Pi", light: "pi-light", dark: "pi-dark", id: "pi", path: "~/.agents/skills/", docs: "https://pi.dev" },
  { name: "Amp", light: "amp", dark: "amp", id: "amp", path: "~/.config/agents/skills/", docs: "https://ampcode.com/manual" },
  { name: "Devin", light: "devin", dark: "devin", id: "devin", path: "~/.config/devin/skills/", docs: "https://docs.devin.ai" },
  { name: "Cline", light: "cline", dark: "cline-dark", id: "cline", path: "~/.agents/skills/", docs: "https://docs.cline.bot" },
  { name: "Roo Code", light: "roocode", dark: "roocode-dark", id: "roo", path: "~/.roo/skills/", docs: "https://docs.roocode.com" },
  { name: "Kiro", light: "kiro", dark: "kiro", id: "kiro-cli", path: "~/.kiro/skills/", docs: "https://kiro.dev/docs" },
  { name: "Goose", light: "goose", dark: "goose-dark", id: "goose", path: "~/.config/goose/skills/", docs: "https://block.github.io/goose/" },
  { name: "OpenHands", light: "openhands", dark: "openhands", id: "openhands", path: "~/.openhands/skills/", docs: "https://docs.openhands.dev" },
  { name: "Trae", light: "trae", dark: "trae", id: "trae", path: "~/.trae/skills/", docs: "https://docs.trae.ai" },
  { name: "OpenClaw", light: "openclaw", dark: "openclaw", id: "openclaw", path: "~/.openclaw/skills/", docs: "https://docs.openclaw.ai" },
  { name: "Hermes Agent", light: "hermes.png", dark: "hermes.png", id: "hermes-agent", path: "~/.hermes/skills/", docs: "https://github.com/NousResearch/hermes-agent" },
  { name: "Gemini CLI", light: "gemini", dark: "gemini", id: "gemini-cli", path: "~/.gemini/skills/", docs: "https://geminicli.com/docs/cli/skills" },
  { name: "GitHub Copilot", light: "copilot", dark: "copilot_dark", id: "github-copilot", path: "~/.copilot/skills/", docs: "https://docs.github.com/en/copilot/concepts/agents/about-agent-skills" },
  { name: "Windsurf", light: "windsurf-light", dark: "windsurf-dark", id: "windsurf", path: "~/.codeium/windsurf/skills/", docs: "https://docs.windsurf.com/windsurf/cascade/skills" },
  { name: "Antigravity", light: "antigravity", dark: "antigravity", id: "antigravity", path: "~/.gemini/config/skills/", docs: "https://antigravity.google/docs/skills" },
  { name: "Kilo Code", light: "kilocode-light", dark: "kilocode-dark", id: "kilo", path: "~/.kilo/skills/", docs: "https://kilo.ai/docs" },
  { name: "Qwen Code", light: "qwen_light", dark: "qwen_dark", id: "qwen-code", path: "~/.qwen/skills/", docs: "https://qwenlm.github.io/qwen-code-docs/" },
  { name: "Zed", light: "zed-logo", dark: "zed-logo_dark", id: "zed", path: "~/.agents/skills/", docs: "https://zed.dev/docs/ai" },
  { name: "Warp", light: "warp", dark: "warp", id: "warp", path: "~/.agents/skills/", docs: "https://docs.warp.dev" },
  { name: "JetBrains Junie", light: "jetbrains", dark: "jetbrains", id: "junie", path: "~/.junie/skills/", docs: "https://junie.jetbrains.com/docs" },
  { name: "Replit", light: "replit", dark: "replit", id: "replit", path: "~/.config/agents/skills/", docs: "https://docs.replit.com" },
  { name: "T3 Code", light: "t3-dark", dark: "t3-light", note: "Uses the folder of the agent it runs (Codex or Claude Code)." },
];

export function skillInstallPrompt() {
  const table = SKILL_AGENTS.map(a => a.path
    ? `- ${a.name} (id \`${a.id}\`): \`${a.path}${SKILL}/\`. Docs: ${a.docs}`
    : `- ${a.name}: ${a.note}`).join("\n");
  return `Install the ${SKILL} skill for Emuly (Android emulators in my GitHub Codespaces).
Install only the skill. Do not set up a key or start a phone now.

1. Know which agent you are. Find your user-level (global) skills folder in your official docs.
   If your docs and this list differ, your docs win. Known folders:
${table}
   If you do not support skills, say so in one line. Then add one line to your global memory
   file (for example AGENTS.md) that says: "For Emuly phones, fetch ${BASE}/.well-known/skills/${SKILL}/SKILL.md and follow it."
2. Ask me once: "Install the ${SKILL} skill into <folder>?" Install nothing without my yes.
3. With Node.js: \`npx skills add ${BASE} -g -a <your id> -y\`.
   Without Node.js: read ${BASE}/.well-known/skills/index.json. Download each file in \`files\`
   from ${BASE}/.well-known/skills/${SKILL}/<file> into \`<folder>/${SKILL}/\`. Keep the paths.
4. Read the installed SKILL.md. Tell me in one line where it is, and that I may need a new session to load it.

Keep messages short. Ask only for decisions.`;
}
