# Emuly with Codex

These notes apply only to OpenAI Codex (the CLI, the IDE extension, and the ChatGPT desktop
app). The rest of the playbook still applies.

- **Network sandbox:** by default Codex runs commands in a sandbox with no network, and it
  can write only in the workspace. Every Emuly call is a `curl`, so:
  - Run the first Emuly `curl` with an escalation request (ask for approval to use the
    network), with one short reason: "Emuly calls go over HTTPS to <base>."
  - If the user's mode cannot ask (for example `codex exec` with `--sandbox
    workspace-write`), stop and tell them in one line to allow network, then wait:
    "Run `/permissions` and pick a mode with network, or start Codex with
    `-c sandbox_workspace_write.network_access=true`."
  - Never call a network error an Emuly outage before you checked the sandbox.
- **Saving the key:** `~/.config/emuly/key` is outside the workspace, so saving it may need
  approval too. Ask for it with the reason "save the Emuly key outside your repository".
  Never save the key inside the workspace to avoid the prompt.
- **Environment:** Codex keeps `EMULY_KEY` in the shell by default. If the user set
  `shell_environment_policy.ignore_default_excludes = false`, it is removed; then read the
  key file instead.
- **Shell:** each command starts a new shell. Read the saved key again and set `base`,
  `auth` and `id` in every command.
- **Never echo the key.** Do not `echo $key`, do not print the token response, and do not put
  the key in a file in the repository.
- **Skills folder:** the user skills folder is `~/.agents/skills/` (Codex also reads
  `~/.codex/skills/`). The user can call this skill by name with `$emuly-playbook`.
- **Remote:** Codex often runs on a VM over SSH or Tailscale, or on an SSH host opened from
  the ChatGPT desktop app (Settings > Connections). In both cases the user sits at another
  computer: follow `references/remote.md`.
- **Screenshots:** Codex has no tool that sends a file to the user's computer. Save
  screenshots to a temporary folder, never the repository, and view them yourself with your
  image tool when you have one. To show one to the user:
  - Local: give the full path.
  - Remote: skip step 1 of `references/remote.md` section 5 and go to Taildrop or `scp`.
- **Long waits:** boot polling and device sign-in can take minutes. Poll in short loops of
  about 60 seconds and give the user a progress line after each loop, so a command timeout
  never kills the wait.
- **Links:** write each Emuly link as a plain URL on its own line.
- **Approvals:** if the user declines an approval, do not retry it the same way. Ask what
  they want instead.
