# Phase 0 — spike results

Date: 2026-11-06. Tester: user's own shell on `free-vm-vcn`, account `sutanukaa`,
classic PAT scoped to **only** `codespace` (7-day expiry, supplied via `.env.spike`,
never read by the agent).

## Spike 1 — can a `codespace`-only token create a codespace?

**PASS.** `POST /user/codespaces` with `repository_id` of the public repo
`sutanukaa/validators`, machine `standardLinux32gb`, returned a codespace in
`Provisioning`. Sparse verification headers also confirmed the token carries exactly
`X-OAuth-Scopes: codespace`. The created codespace was deleted immediately
(delete returned **202** = accepted, async; `gh codespace list` afterwards showed it gone).
So the product model — users authorize with one `codespace` scope, we never hold `repo` —
works exactly as planned. No fallback (GitHub App / per-repo install) is needed.

## Spike 2 — does `gh codespace ssh` work with an OAuth token in `GITHUB_TOKEN`?

**PASS.** With the same `codespace`-only PAT exported as `GITHUB_TOKEN`,
`gh codespace ssh -c <name> -- 'echo ok'` connected to the fresh codespace and printed
`ok`. The tunnel plan (and Phase 5 screen relay) is unblocked. No device-flow key needed.

## Machine types (free/pool account `sutanukaa`)

- `GET /user/codespaces/machines` → **404** on this account. GitHub quirk; do not rely on it.
- `GET /repos/{owner}/{repo}/codespaces/machines` → works. Available machines for
  `sutanukaa`: `basicLinux32gb` (2 vCPU / 8 GB) and `standardLinux32gb`
  (4 vCPU / 16 GB). **The preferred 4-vCPU rig is offered.** Use the per-repo endpoint in
  `lib/github.ts`, pick `standardLinux32gb` if present, else fall back to the largest
  listed machine.

## Design adjustment discovered during the spike

GitHub **auto-generates** the codespace identifier (`automatic-spoon-xqjpvpxxv9jcw7g`).
The POST body's `name` field only sets the *display name*; the identifier cannot be
controlled. Implications:

1. The `phones-*` / `emuly-*` prefix cannot be enforced on the GitHub identifier. The
   safety invariant in `lib/github.ts` keeps its DB rule: a codespace is touchable only if
   its identifier is in our `phones` table *for that user*. Prefix matching is removed as a
   filter; display names we create will still be labeled `phone-….`
2. `phones.codespace_name` stores GitHub's generated identifier; display name is cosmetic.
3. Likewise, delete-by-name must use the identifier (`automatic-spoon-…`), which the DB
   knows, never a user-supplied string.

## Cleanup

- Spike codespace `automatic-spoon-xqjpvpxxv9jcw7g`: deleted and confirmed gone from
  `gh codespace list`. It was the only codespace created; no others touched.
- `sutanukaa`'s two pre-existing codespaces (`damp-cape-…`, `hallowed-spooky-…`) untouched.
- The spike PAT still exists and expires in 7 days. Safe to revoke now at
  github.com/settings/tokens — Phase 2 uses an OAuth App instead.

## Cost

One small codespace, blank container, alive ~15 minutes. Idle stop was 30 min,
retention was 2 h as a backstop. Fractions of one included hour.
