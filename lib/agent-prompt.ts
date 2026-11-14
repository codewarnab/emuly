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

## 0. Where you run

Find out, without asking me, where you run and where I sit. On Linux or macOS run:

\`\`\`sh
uname -s; echo "ssh=\${SSH_CONNECTION:-none} display=\${DISPLAY:-}\${WAYLAND_DISPLAY:-}"
command -v tailscale >/dev/null && tailscale status --self --peers=false
\`\`\`

On Windows, run this in PowerShell:

\`\`\`powershell
"ssh=$(if ($env:SSH_CONNECTION) { $env:SSH_CONNECTION } else { 'none' }) session=$env:SESSIONNAME"
if (Get-Command tailscale -ErrorAction SilentlyContinue) { tailscale status --self --peers=false }
\`\`\`

- **Local:** no SSH connection. Links open on this computer.
- **Remote:** \`SSH_CONNECTION\` is set, or there is no display. On Windows, no display
  means \`SESSIONNAME\` is empty or \`Services\`; \`Console\` and \`RDP-Tcp#N\` have one. I sit at another computer, so
  every link is for me to open there, and nothing here can open a window for me.
- **Over Tailscale:** remote, and the first address in \`SSH_CONNECTION\` is a Tailscale
  address (100.64.0.0/10). \`tailscale whois <that address>\` names my computer.

If your sandbox blocks the network (Codex does by default), ask me to approve network
access for your first Emuly \`curl\` instead of reporting an error.

Tell me in one line what you found, for example "You are on a remote Linux machine over
Tailscale from <computer>, so I will give you links to open there." The skill uses this.

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
  the paths. Claude Code: \`~/.claude/skills/${SKILL_NAME}/\`. Codex: \`~/.agents/skills/${SKILL_NAME}/\`. Cursor: \`~/.cursor/skills/${SKILL_NAME}/\`.
  For another agent, use its documented skills folder.
- **No:** do not install anything. Fetch ${skillUrl(base)} and follow it for this session only.

Install nothing without my yes. After an install, read the installed \`SKILL.md\`.

## 3. Do the task

Follow the skill to choose or start a phone. When Android is ready, always offer me both ways
to see it, even if scrcpy is not installed: the browser link first, then a scrcpy window. Use
the "Two ways to see the phone" text in the skill. Install nothing for scrcpy without my yes.

---

${setupShared(base)}`;
}

/** A fresh setup code is filled in when the user clicks Copy prompt. */
export function buildAgentPrompt(baseUrl: string, setupCode: string) {
  return prompt(baseUrl, `Setup code: ${setupCode} (works once, expires in 1 hour)`);
}

/** Signed-out users copy this. The setup steps start the RFC 8628 device flow instead. */
export function buildDevicePrompt(baseUrl: string) {
  return prompt(baseUrl, "Setup code: none. Start the device sign-in flow and give me the link to approve.");
}
