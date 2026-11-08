# Outbound-only scheduler

This host sends an authenticated HTTPS request. All PhoneLink jobs run on Vercel.
It needs Python 3, systemd with `LoadCredential` support, DNS and outbound HTTPS.
No inbound ports, reverse tunnel, SSH integration, repository checkout, database
credentials or GitHub credentials are needed on this host.

## Private configuration

All paths below are generic installation paths, not details of any owner's host.
Keep actual addresses, usernames, IPs, keys and configuration outside Git.
Do not paste private configuration or journal output into public issues.

Create `/etc/phonelink-scheduler` as root with mode `0700`. Place two root-owned
files with mode `0600` inside it, using a private provisioning channel:

- `endpoint`: the app's exact `https://<deployment-domain>/api/cron` URL.
- `secret`: a random base64url token, 32–256 characters, matching Vercel's
  server-only `CRON_SECRET`. Never use a `NEXT_PUBLIC_` variable for it.

Do not put the secret in a shell command, unit file, repository or environment
file. systemd passes read-only credential files to a temporary unprivileged user.
The secret authorizes reconciliation only; it grants no access to this host.

## Install

Review these generic templates before installing. Copy only these three files;
do not clone the app or copy its `.env` onto the host.

```sh
sudo install -d -o root -g root -m 0755 /usr/local/lib/phonelink-scheduler
sudo install -o root -g root -m 0644 trigger.py /usr/local/lib/phonelink-scheduler/trigger.py
sudo install -o root -g root -m 0644 phonelink-cron.service phonelink-cron.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/phonelink-cron.service /etc/systemd/system/phonelink-cron.timer
sudo systemctl daemon-reload
sudo systemctl start phonelink-cron.service
sudo journalctl -u phonelink-cron.service -n 10 --no-pager
sudo systemctl enable --now phonelink-cron.timer
```

The first manual run should complete before enabling the timer. HTTP 409 means
another reconciliation owns the shared lease and counts as success. Other
statuses and network failures exit unsuccessfully with a generic message.
The helper ignores proxy environment variables, verifies TLS, rejects redirects,
never reads response bodies, and never prints exceptions or configuration.

A slow run cannot overlap itself. After completion the next timer event runs
when due. This monotonic timer does not replay missed minutes. `Persistent=true`
only catches up calendar timers, so it is deliberately absent here. Reconciliation
must recover from stored state on the next invocation after a restart.

## Deployment checks and rollback

Vercel must enable Fluid compute for the 300-second Hobby function limit.
The app pins functions to `bom1`; select a nearby supported database region.
No Vercel Cron configuration or paid upgrade is needed.

Verify the deployed endpoint, then pause the timer for ten minutes. Resume it
and confirm budget, retention and webhook work catches up. Monitor failures
privately. A stopped timer pauses these checks; it does not stop user actions.

Disable with `sudo systemctl disable --now phonelink-cron.timer`. Stop an active
request with `sudo systemctl stop phonelink-cron.service`. Rotate both copies of
the secret if exposed. No firewall changes are needed to undo this installation.

## Security boundary and limits

The service cannot write the host filesystem, read home directories, gain
privileges, use devices or listen for remote commands. The helper only sends
one fixed request. It does not download updates or execute a server response.
Generic logs omit payloads, credentials and endpoint addresses; the host's journal
still contains normal local metadata. Do not publish raw journals.

This is process hardening, not a guarantee against a kernel or Python/TLS flaw.
Use a dedicated minimal VM for stronger separation from valuable workloads.
Vercel and network providers can see the outbound source IP. They cannot trigger
an inbound VM connection through this scheduler. Public source contains no
owner-specific infrastructure values. No IP allowlist is embedded because app
addresses can change; use an external egress policy if your environment needs one.

Installation, real-data import, preview acceptance and production cutover are
separate steps. These templates do not perform any of them.
