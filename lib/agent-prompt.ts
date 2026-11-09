// The agent reads this prompt and calls Emuly over HTTP (see issue #17).
// Future idea, not planned now: a remote MCP server at /mcp with OAuth.
// Claude Code would then do login, token storage, and refresh itself,
// and the agent would call tools like list_phones instead of a runbook.

/** Fallback text when a fresh setup code cannot be minted. Real copies use buildAgentPrompt. */
export const AGENT_PROMPT = `Set me up with an Android phone using Emuly.
Read and follow <base>/agent.md?os=windows&agent=claude-code
Setup code: emuly_sc_... (works once, expires in 1 hour)`;

/** A fresh setup code is filled in only when the user clicks Copy prompt. */
export function buildAgentPrompt(baseUrl: string, setupCode: string) {
  return `Set me up with an Android phone using Emuly.
Read and follow ${baseUrl.replace(/\/$/, "")}/agent.md?os=windows&agent=claude-code
Setup code: ${setupCode} (works once, expires in 1 hour)`;
}

/** Signed-out users copy this. The runbook starts the RFC 8628 device flow instead of exchanging a code. */
export function buildDevicePrompt(baseUrl: string) {
  return `Set me up with an Android phone using Emuly.
Read and follow ${baseUrl.replace(/\/$/, "")}/agent.md?os=windows&agent=claude-code
No setup code is needed. Start the device sign-in flow and give me the link to approve.`;
}
