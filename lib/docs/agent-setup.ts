/** Setup steps for each coding agent, per operating system.
    One source feeds the human docs page and the plain Markdown that agents fetch. */

export const OPERATING_SYSTEMS = [
  { id: "windows", name: "Windows", ready: true },
  { id: "linux", name: "Linux", ready: true },
  { id: "remote", name: "Remote Linux (SSH)", ready: true },
  { id: "macos", name: "macOS", ready: false },
] as const;
export type OsId = (typeof OPERATING_SYSTEMS)[number]["id"];

export type Step = { title: string; text?: string; code?: string };
/** icon names point to /public/agents/<name>.svg, the same files the landing page uses. */
export type AgentDoc = { id: string; name: string; icon: { light: string; dark: string }; summary: string; steps: Partial<Record<OsId, Step[]>> };

const PASTE: Step = { title: "Paste the Emuly prompt", text: "Copy the prompt from the Emuly home page. Paste it into the agent. The agent sets up the phone and gives you a link." };

/** The agent runs on a Linux VM; the user sits at another computer and reaches it over SSH or Tailscale. */
const CONNECT: Step = { title: "Connect to the machine", text: "From Windows, macOS or Linux, open a terminal and SSH into the Linux machine. Over Tailscale, use its Tailscale name. Run every command below on that machine.", code: "ssh <user>@<machine>" };
const PASTE_REMOTE: Step = { title: "Paste the Emuly prompt", text: "Copy the prompt from the Emuly home page and paste it into the agent. It notices it runs remotely, says so, and gives you links to open on your own computer. Over Tailscale it can also send screenshots to your computer and open scrcpy there." };
const remote = (linux: Step[]) => [CONNECT, ...linux.slice(0, -1), PASTE_REMOTE];

export const AGENT_DOCS: AgentDoc[] = [
  {
    id: "claude-code", name: "Claude Code", icon: { light: "claude-ai-icon", dark: "claude-ai-icon" }, summary: "The Anthropic coding agent for the terminal.",
    steps: {
      windows: [
        { title: "Install Claude Code", text: "Open PowerShell and run this command.", code: "irm https://claude.ai/install.ps1 | iex" },
        { title: "Start it in a folder", text: "Open a new terminal. Go to any folder and start the agent. Sign in when it asks.", code: "claude" },
        PASTE,
      ],
      linux: [
        { title: "Install Claude Code", text: "Open a terminal and run this command.", code: "curl -fsSL https://claude.ai/install.sh | bash" },
        { title: "Start it in a folder", text: "Open a new terminal. Go to any folder and start the agent. Sign in when it asks.", code: "claude" },
        PASTE,
      ],
    },
  },
  {
    id: "codex", name: "Codex", icon: { light: "openai", dark: "openai_dark" }, summary: "The OpenAI coding agent for the terminal.",
    steps: {
      windows: [
        { title: "Install Node.js", text: "Install Node.js 20 or later from nodejs.org. Codex installs with npm." },
        { title: "Install Codex", text: "Open PowerShell and run this command.", code: "npm install -g @openai/codex" },
        { title: "Start it in a folder", text: "Go to any folder and start the agent. Sign in with your ChatGPT account when it asks.", code: "codex" },
        PASTE,
      ],
      linux: [
        { title: "Install Node.js", text: "Install Node.js 20 or later. Codex installs with npm." },
        { title: "Install Codex", text: "Open a terminal and run this command.", code: "npm install -g @openai/codex" },
        { title: "Start it in a folder", text: "Go to any folder and start the agent. Sign in with your ChatGPT account when it asks.", code: "codex" },
        PASTE,
      ],
    },
  },
  {
    id: "opencode", name: "OpenCode", icon: { light: "opencode", dark: "opencode-dark" }, summary: "An open source coding agent for the terminal.",
    steps: {
      windows: [
        { title: "Install Node.js", text: "Install Node.js 20 or later from nodejs.org. OpenCode installs with npm on Windows." },
        { title: "Install OpenCode", text: "Open PowerShell and run this command.", code: "npm install -g opencode-ai" },
        { title: "Start it in a folder", text: "Go to any folder and start the agent. Connect a model provider when it asks.", code: "opencode" },
        PASTE,
      ],
      linux: [
        { title: "Install OpenCode", text: "Open a terminal and run this command.", code: "curl -fsSL https://opencode.ai/install | bash" },
        { title: "Start it in a folder", text: "Open a new terminal. Go to any folder and start the agent. Connect a model provider when it asks.", code: "opencode" },
        PASTE,
      ],
    },
  },
];

// Remote Linux is the Linux install, run over SSH, with a remote-aware last step.
for (const agent of AGENT_DOCS) if (agent.steps.linux) agent.steps.remote = remote(agent.steps.linux);

export function findAgent(id: string | null | undefined) {
  return AGENT_DOCS.find(agent => agent.id === id);
}

function stepsMarkdown(steps: Step[]) {
  return steps.map((step, index) => [
    `${index + 1}. ${step.title}.${step.text ? ` ${step.text}` : ""}`,
    step.code ? `\n   \`\`\`\n   ${step.code}\n   \`\`\`` : "",
  ].join("")).join("\n");
}

/** Plain Markdown for agents. Pass an agent and an OS to get one section only. */
export function setupMarkdown(agentId?: string | null, osId?: string | null) {
  const agents = agentId ? AGENT_DOCS.filter(agent => agent.id === agentId) : AGENT_DOCS;
  const systems = OPERATING_SYSTEMS.filter(os => !osId || os.id === osId);
  const head = [
    "# Emuly: set up a coding agent",
    "",
    "Find the user's operating system first. On Windows, run `$env:OS` in PowerShell. On Linux or macOS, run `uname -s`.",
    "On Linux with `SSH_CONNECTION` set, use the Remote Linux section: the user sits at another computer.",
    "Then follow only the section for your agent and that operating system.",
    "Fetch one section: /docs/setup.md?agent=<claude-code|codex|opencode>&os=<windows|linux|remote>",
  ].join("\n");
  const body = agents.flatMap(agent => systems.map(os => {
    const steps = agent.steps[os.id];
    return `## ${agent.name} on ${os.name}\n\n${steps ? stepsMarkdown(steps) : "Steps for this system are not ready yet."}`;
  }));
  return [head, ...body].join("\n\n") + "\n";
}
