/** The Windows user environment variable that holds the agent key. No file path is needed. */
export const AGENT_KEY_ENV = "EMULY_KEY";

/** Reads the user-scoped value in a new shell, without restarting the terminal or the agent. */
export const AGENT_KEY_READ_POWERSHELL = `[Environment]::GetEnvironmentVariable('${AGENT_KEY_ENV}','User')`;

/** Git Bash cannot read Windows user variables directly, so it asks PowerShell once per shell. */
export const AGENT_KEY_READ_BASH =
  `powershell.exe -NoProfile -Command "${AGENT_KEY_READ_POWERSHELL}" | tr -d '\\r'`;

const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/** Ready-to-run commands that store, read and remove the key in the user environment. */
export function agentKeyCommands(key: string) {
  if (!SAFE_KEY.test(key)) throw new Error("The agent key contains characters that are not safe for a shell command.");
  return {
    save: `setx ${AGENT_KEY_ENV} "${key}"`,
    read: AGENT_KEY_READ_POWERSHELL,
    clear: `setx ${AGENT_KEY_ENV} ""`,
  };
}
