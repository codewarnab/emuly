# Long-running scheduler (replaces the 60 s /api/cron call)

`scripts/scheduler.ts` runs Emuly's scheduled work in one Node process on the VM:

| Loop | Interval | Work |
| --- | --- | --- |
| fast | 5 s | Webhook delivery |
| sync | 5 s check | GitHub sync per user: 10 s while a phone changes state, 60 s while a phone runs, 30 min when all are stopped |
| minute | 60 s | Idle warning (`phone.idle_warning`) and idle stop, budget, diagnostics, heartbeat for `/api/health` |
| runner | 60 s | In-place runner update of quiet running phones (`lib/phone/runner-update.ts`) |
| hourly | 1 h | Retention warnings and auto-keep |

Users run in parallel (`EMULY_SCHEDULER_PARALLEL`, default 8). Boots run in this
process, so the VM holds the long `/boot` call and Vercel spends no CPU on it.
The process holds the `scheduled:reconcile` lease. While it runs, `/api/cron`
answers 409, so the old timer is a safe fallback. A second copy stands by.

## In-place runner update

After a deploy changes `RUNNER_VERSION` or a file in `phone/`, a running phone gets the
new runner without a phone stop. The runner loop updates a phone only when all are true:

- The phone is `running` and Android is `ready` (no boot or stop in progress).
- No agent or browser use for 5 min (`last_activity_at`), and no Android input for 5 min.
- Runner `/health` `busy`: no viewers (a recording counts), no links, no work in
  progress, and no request in the last 30 s. A runner older than 17 has no `busy`.
- The user lease `phones:<user>` is free, so a start or stop never overlaps.

The update runs the normal setup script. It stops only the runner, writes the new files,
and starts the runner again; `boot.sh` joins the running emulator. Then it waits up to
90 s for `/health` to show the new version. At most 2 phones update at a time. A failure
waits 5, 15, then 60 min. Measured 2026-11-20: 16 -> 17 in 8 s, Android kept running.

The scheduler runs the code in its own copy, so redeploy the VM after each runner change.

## Needs

Node 24 or later, pnpm, a copy of this repository in `~/emuly`,
and the Vercel app's server env vars in `~/.config/emuly-scheduler/env`
(mode 0600): `EMULY_DATABASE_URL`, `EMULY_DATABASE_AUTH_TOKEN`, `EMULY_TOKEN_KEY`
(and `EMULY_TOKEN_KEY_OLD` during a rotation), `EMULY_GITHUB_CLIENT_ID`,
`EMULY_GITHUB_CLIENT_SECRET`, `EMULY_BASE_URL`, `EMULY_DIRECT_SECRET`,
`WEBHOOK_SECRET` when set on Vercel. The VM then holds full app secrets: keep
it private.

## Install (user unit, no root)

```sh
# From a laptop checkout (the repository is private, so the VM has no clone):
#   git archive HEAD | ssh <vm> 'rm -rf ~/emuly.new && mkdir ~/emuly.new && tar -x -C ~/emuly.new'
# On the VM:
cd ~/emuly.new && pnpm install --prod --frozen-lockfile && rm -rf ~/emuly && mv ~/emuly.new ~/emuly && cd ~/emuly
install -d -m 0700 ~/.config/emuly-scheduler && install -m 0600 /dev/null ~/.config/emuly-scheduler/env  # then fill it
install -D -m 0644 deploy/vm/emuly-scheduler.service ~/.config/systemd/user/emuly-scheduler.service
systemctl --user daemon-reload && systemctl --user enable --now emuly-scheduler
journalctl --user -u emuly-scheduler -n 20 --no-pager   # expect "lease held; loops start"
```

Update: copy the new tree the same way, then `systemctl --user restart emuly-scheduler`.
Run production migrations before an update that needs them.

## Cut over and roll back

After the scheduler runs well, turn off the old timer:
`sudo systemctl disable --now emuly-cron.timer`. Then `/api/cron` gets no calls.
If the scheduler stops for more than 5 min, `/api/health` answers 503.
To roll back, `systemctl --user disable --now emuly-scheduler` and
`sudo systemctl enable --now emuly-cron.timer`. `EMULY_CRON_OFF=1` on Vercel
turns the `/api/cron` work off even when something still calls it.
