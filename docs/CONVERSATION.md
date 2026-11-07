# phonelink — design conversation, 2026-11-05

Condensed record of the session that produced this project. Numbers are real, measured or
quoted from vendor docs on that date. Evidence issue:
https://github.com/codewarnab/homelab-docs/issues/124

## 1. Starting point

We already run Android emulators in GitHub Codespaces: `~/.agents/skills/android-emu`,
`standardLinux32gb` slots (4 vCPU / 16 GB), AVD API 36, KVM, headless, ws-scrcpy for humans,
adb over an SSH tunnel on `localhost:15555`. Cold boot ~100 s, snapshot resume ~15 s.

Question: can this be sold as a service?

## 2. What the market charges

| Service | Price |
|---|---|
| Genymotion SaaS (virtual Android) | $0.06/min = $3.60/h |
| Phonebox (cloud phone, keeps state, $0.06/min billed per second) | $3.60/h |
| Firebase Test Lab virtual / physical | $1/h / $5/h |
| BrowserStack / Sauce Labs / LambdaTest | ~$199 per parallel per month |
| AWS Device Farm (physical) | $0.17/min = $10.20/h |
| boat.dev `large` (8 vCPU / 16 GB raw VM, `/dev/kvm`) | $0.072/h |
| Codespaces over quota (4 vCPU / 16 GB) | ~$0.29/h |

Lesson: raw compute is a commodity at ~$0.07/h. Finished emulator products sell at $1–3.60/h.
The gap is the product: screen, boot, wipe, support, API.

## 3. Cost model (measured / documented)

- GitHub Pro: 180 core-hours + 20 GB-month storage per month.
- 4-core slot burns 4 core-hours per wall hour → **45 free hours per Pro account**.
- Storage: ready emulator slot ~26 GB vs 20 GB allowance → ~$0.42/mo overage per account.
- Codespaces hard-kills a machine after 12 h regardless of idle timeout.
- Default idle timeout 30 min (5–240 configurable).

## 4. Capacity measurement (the stress test)

Slot `damp-cape-wr7pp95x7qqpcqrv`, 4 vCPU / 15993 MB. Three `-read-only` instances of AVD
`t`, `-memory 2560 -cores 1 -gpu swiftshader_indirect -no-window`. Sequential start, 60 s
settle, measure all running phones.

| Phones | qemu CPU (of 400%) | Headroom/phone | MemAvailable | Boot (resume) |
|---|---|---|---|---|
| 1 | 180% | 100% | 11541 MB | 40 s |
| 2 | 306% | 85% | 8415 MB | 56 s |
| 3 | 394% | 73% | 5456 MB | 64 s |

Findings:

- CPU saturates before RAM. 3 phones = 98.5% of 4 vCPU; a 4th queues.
- ~3.0 GB RAM per phone, ~180% → 131% CPU per phone.
- 1→2 costs ~15% efficiency, 2→3 another ~14%.
- Boot from snapshot stays cheap (40 → 64 s), so staggered starts are fine.
- Latency numbers (screencap, tap) were too noisy to publish; CPU/RAM/boot only.

Product rule: **2 phones per 16 GB slot** (safe), 3 max (light work), 4+ needs 8 vCPU / 32 GB.

## 5. Business model exploration (rejected ideas)

- Sell Codespaces access directly: forbidden by GitHub terms. Rejected.
- Undercut boat.dev per hour: at $0.06/h, 45 free hours = $2.70/account/month. Needs 37 Pro
  accounts to reach $100/mo. Rejected — price is the lever, not undercutting.
- 4 accounts, target $20–23/mo: needs $0.13/h if all 180 hours sell; fragile if half sells.
- Working model chosen: **BYO Codespace, free product**, users spend their own quota.
  No compute cost to us, no resale, no billing.

## 6. Auth design (settled)

`gh auth login` cannot request only `codespace` — its device flow hardcodes `repo`,
`read:org`, `gist`. Also, agent-created codespaces assume the user has `gh` locally, which
hosted agents do not.

| Option | Codespaces support | Verdict |
|---|---|---|
| `gh` device flow | yes, but broad scopes | no |
| Fine-grained PAT | no — Codespaces endpoints require classic/OAuth `codespace` | dead end |
| GitHub App user token (`ghu_`) | reported broken for codespaces (cli/cli#8622) | risky |
| **Own OAuth app, `scope=codespace`** | yes, one scope, no client secret for device flow | **chosen** |

Flow:

1. "Connect GitHub" → GitHub shows one line: "Act on your behalf: Codespaces".
2. Token `gho_...` with one scope. Verify: `x-oauth-scopes: codespace` on `GET /user`.
3. Backend runs with `GH_TOKEN`: `POST /user/codespaces` (blank template,
   `standardLinux32gb`) → wait `Available` → `gh codespace ssh` → run `install.sh`.
4. Return `https://{id}.phonelink.dev`.

Storage: encrypt at rest, enable expiring user tokens, add revoke via
`DELETE /applications/{client_id}/token`. Leak blast radius: create/delete codespaces only.

## 7. Product shape (agent-native)

- Landing page: one button, "Copy prompt for agent" (here.now pattern).
- `skill.md` teaches the agent: `POST /v1/phones` → `adb connect` → install → screenshot →
  `DELETE /v1/phones/{id}`.
- Relay on our VM dials out? No: the codespace dials out to the relay. No inbound ports, no
  stored GitHub credentials in the stream path.
- UX: agent drives, human watches. "Take over" pauses the agent; "Hand back" resumes after a
  screenshot. One controller at a time.
- Free tier: 1 phone, 30-min sessions, no saved state.

## 8. Open questions

1. Relay bandwidth per viewer at usable quality — likely the first real cost.
2. Does the codespace outbound tunnel survive sleep/resume for a stable URL?
3. Disk headroom for 3 AVDs + SDK inside a 32 GB slot.
4. redroid in Docker (~1–1.5 GB/phone, no render cost) as a cheap mass mode for CI/scraping.
5. GitHub acceptable-use review before any money changes hands.

## 9. Reproduce the benchmark

```sh
cd ~/.agents/skills/android-emu
B64=$(base64 -w0 bench-multi-emu-v2.sh)
./scripts/ghctx.sh ssh <slot> -- "echo $B64 | base64 -d > /tmp/bench2.sh; \
  nohup bash /tmp/bench2.sh > /tmp/bench2.log 2>&1 &"
./scripts/ghctx.sh ssh <slot> -- 'cat /tmp/bench2.log'
./scripts/ghctx.sh run <slot> -- codespace stop -c <slot>
```

Cost of one full run: about $0.10. Slot used: `sutanukaa` / `damp-cape`.
