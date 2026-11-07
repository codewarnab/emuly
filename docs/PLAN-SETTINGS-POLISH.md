# Settings polish plan

Goal: Settings feels fast and quiet. Less text, no Save button, keyboard first, and webhooks that are easy to test.

Scope: `app/(app)/app/settings/**`, `components/hours-settings.tsx`, `components/webhook-settings.tsx`,
`components/keyboard-tools.tsx`, `lib/keyboard.ts`, `components/console.module.css`, `app/actions/settings.ts`,
`app/v1/webhooks/**`, `lib/webhooks.ts`. Do not touch phone setup, the codespace tunnel, or billing math.

Rules for every change:
- Read `node_modules/next/dist/docs/` before Next code (see AGENTS.md). This Next version differs from training data.
- Copy is short. One line of hint at most per control. Write in plain, active English.
- Keep the existing CSS tokens (`--accent`, `--panel`, `--panel2`, `--line`, `--dim`, `--text`, `--danger`). Must work in light and dark.
- Accessible: real buttons and labels, `role="switch"` on switches, visible focus rings, `aria-live` for save status.
- Respect `prefers-reduced-motion`.
- No new dependencies.
- Do not commit. Leave changes in the working tree.

## 1. Auto-save on Hours (remove the Save button)

Current: `components/hours-settings.tsx` is one form with a Save button. It posts to `saveHours` in `app/actions/settings.ts`.

Change:
1. Split `saveHours` into one server action per field, or one action that accepts a partial patch:
   `saveHoursField(field: "idle" | "autoStop" | "autoKeep" | "plan", value)`. Validate each field the same way as today
   (`updateSettings`, `choosePlan`). Return `{ ok: boolean; message: string }`.
2. Client: each control saves on change.
   - Idle preset chips and plan chips: save on click.
   - Switches: save on toggle. Update optimistically (`useOptimistic`); roll back and show the error on failure.
   - Custom number fields (idle minutes, custom core-hours): save on blur or Enter, debounce 500 ms, skip if unchanged or invalid.
3. Save status: one small line under the page tabs, `aria-live="polite"`: "Saving…" → "Saved" (fades after 1.5 s) or the error.
   Do not use a toast for each save.
4. Remove the Save button.
5. Revalidate `/app` and `/app/settings/hours` after each save.

Done when: changing any control persists after reload, errors roll the control back, and there is no Save button.

## 2. Keyboard shortcuts

Current: `components/keyboard-tools.tsx` handles `g p`, `g 1…9`, `1–4` tabs on a phone page, `t`, `?` and Ctrl K.
It only works when `phones` is passed, and the settings layout does not render it.

Change:
1. Render `<KeyboardTools phones={...} />` in `app/(app)/app/settings/layout.tsx` (load the phone list on the server like the dashboard does).
2. Add global shortcuts:
   - `g s` → `/app/settings/hours`
   - `g w` → `/app/settings/webhooks`
3. On settings pages only:
   - `1` → Hours tab, `2` → Webhooks tab.
   - `n` on Webhooks → focus the Endpoint URL field.
4. Command menu (Ctrl K) entries: "Go to Settings: Hours" (`g s`), "Go to Settings: Webhooks" (`g w`),
   "Toggle auto-stop", "Toggle keep stopped phones", "Send test to <webhook url>" for each enabled webhook
   (the menu needs that list: pass it from the webhooks page, or fetch `/v1/webhooks` when the menu opens on settings).
5. Update the `?` shortcuts sheet with the new keys. Keep `lib/keyboard.ts` as the single source of key labels.
6. Shortcuts must not fire while typing in an input, textarea or select (check the existing `useShortcuts`).
7. Show the key hint on the tabs: a small `kbd` "1" and "2" next to Hours and Webhooks, dim, hidden under 680 px.

Done when: every new key works, the sheet lists them, and typing in a field does not trigger them.

## 3. Webhooks polish

Current: `components/webhook-settings.tsx` has a full-width form, a long sentence per endpoint, a row of 5 buttons,
and a 7-column delivery table behind "Refresh deliveries". Test only queues a delivery; the outbox sends within 60 s.

Change:
1. Add form:
   - URL field and an "Add" button on one row. Event chips under it, collapsed behind "Events: all (11)" until clicked.
   - Check the URL while typing: must be `https://`, show the error under the field. The server still checks SSRF.
   - `n` focuses the field (from section 2).
2. Secret reveal: a compact panel with the secret in mono, a Copy button (`copyText` from `components/ui-provider`),
   and "Shown once." Hide on Done.
3. Endpoint card:
   - Header row: URL (mono, truncated with title), a status dot (green enabled, grey disabled, red failing), and a `…` menu
     with Edit, Roll secret, Disable/Re-enable, Remove. Remove asks for confirmation inline (not `window.confirm`).
   - Primary action visible: **Send test**.
   - Remove the long "Delivery runs every 60 seconds…" paragraph.
4. Send test with a live result:
   - Add `POST /v1/webhooks/{id}/test?wait=1` (or a new route) that queues the test delivery and then attempts it now,
     using the same signed delivery code as the outbox (`lib/webhooks.ts`). Same SSRF guard and timeout.
     It returns the delivery `{ state, status, duration_ms }`. Keep rate limiting: at most 1 test per webhook every 5 s.
   - The button shows "Sending…", then an inline result next to it: `200 · 142 ms` in green, or `Failed · <reason>` in red.
     The result stays until the next test.
5. Recent deliveries: load the last 5 with the card (no "Refresh" button). Show them as small dots (green ok, red failed,
   grey pending) with a tooltip (`type · status · time`). Clicking a dot opens a small panel with time, event, HTTP status,
   duration, attempts and a Resend button. "View all" opens the existing full table.
6. Empty state: one line "No webhooks yet." The add form is right above it.

Done when: Send test shows a real result within a few seconds, the card has one primary button, and nothing scrolls sideways at 390 px.

## 4. Tests and checks

- Add unit tests for the new server action validation and for the synchronous test delivery (use the existing test style in `lib/*.test.ts`, with a fake fetch).
- Run `pnpm test`, `npx tsc --noEmit -p .` and `npx next build`. All must pass.
- At the end, write a short summary of what changed, with file paths, and anything left undone.
