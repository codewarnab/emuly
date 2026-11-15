/** Client-safe. The prompt on the /self-host page. The agent does the setup; the human only
    approves and enters the GitHub device code. The steps follow docs/SELF-HOST.md. */
const REPO = "https://github.com/codewarnab/emuly";

export const SELF_HOST_SETUP_PROMPT = `Set up Emuly on this machine in self-host mode. Emuly runs Android emulators in my GitHub Codespaces.
Follow ${REPO}/blob/main/docs/SELF-HOST.md. If this prompt and that guide differ, the guide wins.

1. Check what this machine has: Docker or Podman with Compose, Node 26, pnpm, and gh (version 2.103 or newer).
   Tell me in one line what you found and which option you will use:
   - Option A (preferred): Docker. Use it when Docker with Compose works.
   - Option B: local with Node 26, pnpm and gh.
   Ask me before you install anything.
2. Clone ${REPO} into a folder I agree to. Skip this if a clone is already there.
3. Option A: in deploy/selfhost/, run \`docker compose build\`.
   Option B: run \`pnpm install\` in the repo root.
4. Sign in to GitHub with the device flow. I must do this part.
   Option A: \`docker compose run --rm emuly gh auth login -h github.com -s codespace\`
   Option B: \`gh auth refresh -h github.com -s codespace\` if gh is already signed in, else \`pnpm emuly login\`.
   Show me the one-time code and the link https://github.com/login/device. Then wait until I say I am done.
5. Start it.
   Option A: \`docker compose up -d\`
   Option B: \`pnpm emuly up\` (keep it running in the background).
6. Run the doctor and fix each failed check.
   Option A: \`docker compose run --rm emuly node emuly.mjs doctor\`
   Option B: \`pnpm emuly doctor\`
7. Point the Emuly skill at this server. Write one line, \`http://localhost:4321\`, to \`~/.config/emuly/base-url\`
   (on Windows, \`%USERPROFILE%\\.config\\emuly\\base-url\`). Option B's \`pnpm emuly up\` already writes it.
8. Install or update the emuly-playbook skill from this server: \`npx skills add http://localhost:4321 -g -a <your agent id> -y\`.
   If an older copy from https://emuly.vercel.app is installed, replace it.
9. Open http://localhost:4321/agent.md and follow it, so you can start and drive phones for me.
10. Tell me in two lines: the URL (http://localhost:4321) and how to stop it.

Rules:
- Do not set GH_TOKEN or GITHUB_TOKEN. Emuly refuses to start with them.
- Keep the port on localhost only. The self-host API has no login.
- If I open Emuly from another device over Tailscale (for example with Tailscale Serve), set the base URL to that address.
  Option A: in deploy/selfhost/compose.override.yaml, set \`services.emuly.environment.EMULY_BASE_URL\` to the tailnet URL
  (for example \`https://<machine>.<tailnet>.ts.net\`), then recreate the container. Option B: set \`EMULY_BASE_URL\` before \`pnpm emuly up\`.
  Otherwise Emuly rejects the tailnet address as a different origin. Use the same URL in \`~/.config/emuly/base-url\`.
  Keep Emuly bound to localhost. Tailscale Serve gives the HTTPS address.
- Do not start a phone until I ask.
- Use the default phone template, codewarnab/emuly. Do not ask me about it. It has a Codespaces prebuild, so phones boot fast.
  Only if I say I want my own fork, tell me in simple words: "A fork has no prebuild, so each new phone boots slowly.
  To fix it, set up a Codespaces prebuild in your fork. I recommend the default." Then let me choose.
Keep messages short. Ask only for decisions.`;
