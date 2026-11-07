# phonelink

Run an Android emulator in the cloud, for free.

An Android emulator service built for agents and humans. Users bring their own GitHub
Codespace (included hours: about 30/month free, 45/month Pro, at 4 cores),
we provide the stream, the prompt, and the API.

Status: design + landing page. The "keep the phone" capability shipped in the
`android-emu` skill (`keep.sh`), not as a separate service.

## Layout

```
docs/
  CONVERSATION.md    full design discussion, measurements, decisions (2026-11-05)
  issue-124.md       copy of the homelab-docs issue
site/
  index.html         landing page (static, no build step)
preview/
  desktop-full.png   full-page render, 1440 wide
  mobile-full.png    full-page render, 430 wide
  hero.png           cropped hero, for chat embeds
```

## Decisions in one screen

- BYO Codespace. Never resell GitHub access.
- OAuth app with `scope=codespace` only. No `repo`, never `gh` device flow.
- Agent-native: copy-prompt page; the actual instructions are the `android-emu` skill.
- Capacity: 1 phone per slot default, 2 max, 3 only light mode.
- Stop is safe: the phone (disk + snapshot) persists; only deleting the Codespace wipes it.
- Named backups (`keep.sh`) are opt-in; two generations kept by default.

## Related

- Measurements issue: https://github.com/codewarnab/homelab-docs/issues/124
- Emulator rig skill: `~/.agents/skills/android-emu`

## Preview the landing page

```sh
python3 -m http.server 8080 -d site
```

Regenerate screenshots (headless Chromium already on this box):

```sh
CH=~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell
"$CH" --no-sandbox --hide-scrollbars --window-size=1440,4200 \
  --screenshot=preview/desktop-full.png "file://$PWD/site/index.html"
"$CH" --no-sandbox --hide-scrollbars --window-size=430,7000 \
  --screenshot=preview/mobile-full.png "file://$PWD/site/index.html"
```
