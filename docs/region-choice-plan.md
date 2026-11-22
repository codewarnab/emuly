# Plan: create each phone in the best region

Status: plan only. No code has changed. Written 2026-11-22.

## Goal

Each phone runs in the GitHub region that is closest to the person or agent that uses it most.
Touch, video and agent calls then have the smallest delay.

## What we found (checked 2026-11-22)

### 1. Prebuilds are ready in all 5 regions

`GET repos/codewarnab/emuly/codespaces/machines?location=<region>&ref=main&devcontainer_path=.devcontainer/phone/devcontainer.json`, machine `standardLinux32gb`:

| Region | Prebuild |
|---|---|
| CentralIndia | ready |
| SouthEastAsia | ready |
| EastUs | ready |
| WestUs2 | ready |
| WestEurope | ready |

### 2. Every phone is still created in CentralIndia

- `gh api user/codespaces` shows 4 phones. All 4 are in `CentralIndia`.
- The create body (`CreateCodespace`, `lib/github/github.ts:64`) has no `geo`, no `location` and no `client_ip`.
- With no region in the body, GitHub uses the IP of the caller.
- The caller is the Vercel function in `bom1` (Mumbai). So a user in the US also gets `CentralIndia`.
- The prebuilds outside India are never used.
- PR #42 lists "Region choice" in its description, but its diff has no region code.

### 3. Where phones are created

All 3 entry points go to `create()` in `lib/phone/phone-mutations.ts:704`:

| Entry point | File | Who calls it |
|---|---|---|
| Dashboard button | `app/actions/phones.ts:39` (server action) | A person in the browser |
| Agent API | `app/v1/phones/route.ts` → `lib/phone/phone-agent-api.ts` | The `emuly` CLI or any agent with a key |
| WebMCP tool | `lib/webmcp/tools.ts:119` → `POST /v1/phones` | A browser agent, from the user's browser |

`clientIp(request)` in `lib/auth/agent.ts:23` already reads the real client IP on Vercel.

### 4. GitHub API rules for the region

- `client_ip`: "IP for location auto-detection when proxying a request." GitHub picks the region closest to that IP.
- `geo`: one of `EuropeWest`, `SoutheastAsia`, `UsEast`, `UsWest`. **India is not a value.**
- `location`: the old field. It is deprecated, but it still takes names such as `CentralIndia`.
- A codespace cannot move to another region. A new region needs a new codespace.

Source: <https://docs.github.com/en/rest/codespaces/codespaces?apiVersion=2022-11-28#create-a-codespace-for-the-authenticated-user>

## The cases

| Case | Who creates | Who uses the phone | Best region |
|---|---|---|---|
| A. Person in the browser | Person | Person | Near the person |
| B. Agent on the person's laptop (`emuly` CLI) | Agent | Agent, person watches | Near the laptop (same place) |
| C. Agent in a cloud sandbox (for example US) for a person in India | Agent | Agent only | Near the agent |
| D. Cloud agent, and the person watches the video live | Agent | Both | Near the person (video needs it most) |
| E. Browser agent (WebMCP) | Agent, from the browser | Person and agent | Near the person |
| F. Person travels, or uses a VPN | Person | Person | Near the IP now; the person can change it |
| G. Self-host, or localhost dev | Anyone | Anyone | No IP from Vercel; GitHub default |
| H. Prebuild missing in the chosen region | Anyone | Anyone | The nearest region that has a ready prebuild |

The rule for all cases: **the default is the IP of the caller that creates the phone. The caller can always name a region.**
This gives cases A, B, C, E and F with no setting. Case D needs the person or agent to name a region.

## The plan

### Step 1. Send the region on create (automatic, all cases)

1. Add `client_ip?: string`, `geo?: string` and `location?: string` to `CreateCodespace` (`lib/github/github.ts:64`).
2. Add `clientIp?: string` and `region?: Region` to the `create()` input (`lib/phone/phone-mutations.ts:704`).
3. Pass the IP from all 3 entry points:
   - `app/actions/phones.ts`: read the IP with `ipAddress()` from `@vercel/functions` and `headers()`.
   - `lib/phone/phone-agent-api.ts`: use `clientIp(request)`.
   - WebMCP calls `/v1/phones` from the user's browser, so the agent API path covers it.
4. Send `client_ip` only when it is a public IP. Do not send it for `unknown`, `127.0.0.1`, `::1` or private ranges (case G).
5. Do not save the IP in the database or in logs. It is personal data.

### Step 2. Let the caller name a region (cases D and F)

1. One list of regions in `lib/shared/regions.ts`:

   | Emuly id | Label | GitHub field |
   |---|---|---|
   | `auto` | Closest to you | `client_ip` |
   | `india` | India | `location: "CentralIndia"` |
   | `southeast-asia` | Southeast Asia | `geo: "SoutheastAsia"` |
   | `us-east` | US East | `geo: "UsEast"` |
   | `us-west` | US West | `geo: "UsWest"` |
   | `europe` | Europe West | `geo: "EuropeWest"` |

2. India has no `geo` value, so it uses `location`. If GitHub removes `location` later, India phones fall back to `client_ip`.
3. Dashboard: add a "Region" select to the create form. The default is `auto`.
4. Agent API: accept `"region"` in the `POST /v1/phones` body. Reject unknown values with a 400 that lists the valid values.
5. `emuly` CLI: add `--region <id>`.
6. WebMCP `createPhone`: add an optional `region` input.
7. Skill (`content/skills/emuly-playbook/SKILL.md`): tell agents to pass `region` only when the person watches from another place (case D).

### Step 3. Save a default region for each user

1. Add `default_region TEXT NOT NULL DEFAULT 'auto'` to `user_settings` (a new migration).
2. A person in India who uses a US cloud agent sets `india` one time. All later agent phones then go to India.
3. Order of choice: the `region` in the request, then `default_region`, then `auto`.

### Step 4. Check the prebuild before create (case H)

1. `create()` already calls `github.machines()`. Call it with the chosen `location`, and read `prebuild_availability`.
2. If it is not `ready`, use the nearest region that is `ready`, from a fixed order of neighbours.
3. Write an event: "No ready prebuild in US East. Created in US West." The person sees why.
4. Skip this check for `auto`, because the region is not known before create. Rely on Step 6 to watch it.

### Step 5. Save and show the region

1. Add `location TEXT` to `phones` (a new migration). Fill it from the `location` field of the codespace that GitHub returns.
2. Show the region on the phone card and on the phone screen, for example "US East".
3. Return `location` from `GET /v1/phones` and `GET /v1/phones/<id>`.
4. Backfill old phones from `listCodespaces()` on the next sync.

### Step 6. Keep prebuilds ready (no code)

1. In the GitHub prebuild settings for `codewarnab/emuly`, keep all 5 regions on.
2. Add a weekly check in the existing scheduler: call the machines API for each region. Write a warning event if a prebuild is not `ready`.

## What stays slow after this plan

- **Agent calls from far away still go through Mumbai.** Each `/v1` call goes to Vercel `bom1`, then to the phone. PR #42 measured 240 ms per call from the US.
  - Fix later: let agents use the direct path on port 8791, as the browser does now. This is a separate plan.
- **The direct video path is off by default.** `EMULY_DIRECT_STREAM` is `off`. Without it, video from a US phone to a US person still goes through Mumbai, and the new region gives little gain.
  - Turn it on (`all`) before or with this plan. Region choice and the direct path only help together.
- **Old phones stay in India.** A codespace cannot move. The person must delete it and create a new one.
- **Jio DNS block.** Some networks cannot reach `*.app.github.dev` in any region. The notice from PR #42 still applies.

## Order of work

1. Step 1 and Step 5 together. Small change, and it fixes cases A, B, C, E and F at once.
2. Turn on `EMULY_DIRECT_STREAM=all`.
3. Step 2 and Step 3 (case D).
4. Step 4 and Step 6 (case H).
5. Separate plan: direct path for agents.

## Tests

- `create()` sends `client_ip` for a public IP, and sends nothing for `unknown`, `127.0.0.1` and `10.0.0.5`.
- `region: "india"` sends `location: "CentralIndia"`. `region: "us-east"` sends `geo: "UsEast"`.
- An unknown `region` returns 400 and creates no phone.
- A request `region` wins over `default_region`.
- A missing prebuild moves the phone to the next region and writes an event.
- Live check: create one phone with each region, and confirm the region with `gh api user/codespaces --jq '.codespaces[].location'`.
