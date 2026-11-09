// The agent reads this prompt and calls Emuly over HTTP (see issue #17).
// Future idea, not planned now: a remote MCP server at /mcp with OAuth.
// Claude Code would then do login, token storage, and refresh itself,
// and the agent would call tools like list_phones instead of a runbook.
export const AGENT_PROMPT =`Set me up with a free Android emulator using Emuly.
Read and follow https://github.com/codewarnab/agent-skills/tree/main/android-emu
(SKILL.md). It runs in my own GitHub Codespace on my included hours, so it costs nothing.
Ask me before anything that needs my approval, like signing in to GitHub.
When the phone is up, give me the link to watch it in my browser.

Running phones share my included hours. Choose a 30-minute or 4-hour idle timeout
when creating a phone. Thinking without terminal or editor activity counts as idle
to GitHub. The runner keeps the codespace awake only while actively driving the
phone with tap, type, or install calls. Stopping keeps the phone.

To be notified instead of polling, ask me for a webhook URL and register it with
POST /v1/webhooks. Polling is still an option.`;
