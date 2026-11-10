# Emuly with Claude Code

These notes apply only to Claude Code. The rest of the playbook still applies.

- **Shell:** your Bash tool runs Git Bash on Windows. Each call starts a new shell, so read
  `EMULY_KEY` again and set `base`, `auth` and `id` at the start of each call. PowerShell
  works too if your session has a PowerShell tool.
- **Never echo the key.** Do not `echo $key`, do not print the token response, and do not put
  the key in a file in the repository.
- **Long waits:** boot polling and device sign-in can take minutes. Run long polling loops in
  the background when your tools allow it, and give the user a short progress line every
  30-60 seconds.
- **Links:** write each Emuly link as a plain URL on its own line so the user can click it.
- **Screenshots:** save `screen.png` to the scratchpad or a temporary folder, not to the
  user's repository, then read the image to see the phone screen. To show it to the user,
  follow `references/screenshots.md`. If you have a send-file tool (for example
  `SendUserFile`), use it; otherwise give the full path.
- **Permissions:** if the user denies a tool call, do not retry it the same way. Ask what
  they want instead.
