// The agent reads this prompt and calls Emuly over HTTP (see issue #17).
// Future idea, not planned now: a remote MCP server at /mcp with OAuth.
// Server only: this reads the Markdown files in content/.
// The prompt holds only key setup. Phone work lives in the emuly-playbook skill.
import { AGENT_RUNBOOK_VERSION, SKILL_NAME, setupOsIds, setupOsUrl, setupShared, skillUrl } from "./agent-runbook";

function prompt(baseUrl: string, keyLine: string) {
  const base = baseUrl.replace(/\/$/, "");
  const osLinks = setupOsIds().map(id => `  - ${id}: ${setupOsUrl(base, id)}`).join("\n");
  return `Set me up with an Android phone using Emuly.

- Emuly base URL: ${base}
- ${keyLine}
- Prompt version: ${AGENT_RUNBOOK_VERSION}

## 1. Get a key

Fetch the setup commands for the OS you run on. If none matches, adapt the closest one.

${osLinks}

Then follow the key steps at the end of this prompt.

## 2. Offer the ${SKILL_NAME} skill

The \`${SKILL_NAME}\` skill tells you how to start, drive and stop Emuly phones.
Ask me once: "Should I install the ${SKILL_NAME} skill so I can run Emuly phones in later sessions?"

- **Yes, with npx** (needs Node.js): \`npx skills add ${base} -g -a <your agent id> -y\`.
  Use your own agent id, for example \`claude-code\` or \`cursor\`.
- **Yes, without npx:** read ${base}/.well-known/skills/index.json and download each file
  in \`files\` from ${skillUrl(base, "<file>")} into your agent's user skills folder, keeping
  the paths. Claude Code: \`~/.claude/skills/${SKILL_NAME}/\`. Cursor: \`~/.cursor/skills/${SKILL_NAME}/\`.
  For another agent, use its documented skills folder.
- **No:** do not install anything. Fetch ${skillUrl(base)} and follow it for this session only.

Install nothing without my yes. After an install, read the installed \`SKILL.md\`.

## 3. Do the task

Follow the skill to choose or start a phone, then give me its browser link.

---

${setupShared()}`;
}

/** A fresh setup code is filled in when the user clicks Copy prompt. */
export function buildAgentPrompt(baseUrl: string, setupCode: string) {
  return prompt(baseUrl, `Setup code: ${setupCode} (works once, expires in 1 hour)`);
}

/** Signed-out users copy this. The setup steps start the RFC 8628 device flow instead. */
export function buildDevicePrompt(baseUrl: string) {
  return prompt(baseUrl, "Setup code: none. Start the device sign-in flow and give me the link to approve.");
}
