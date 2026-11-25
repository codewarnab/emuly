# Phone traffic through the laptop (`emuly proxy`)

Status: built and live-tested (2026-11-25). See "Live tests in a codespace" for the results.

## Goal

One command sends all of a phone's internet traffic out through the user's laptop, or through
a proxy that the laptop can reach. It is for scraping and geo tests from the user's own IP.

- **UX:** one command, nothing to set up on the phone, and it works for every app.
- **Security:** no leaks of the codespace IP, fail closed, no DNS leak, proxy passwords stay on the laptop.
- **Speed:** small overhead when the proxy is off. Measure before and after.

## Options we checked

| Option | Covers all apps | Fail closed | Needs | Verdict |
|---|---|---|---|---|
| Android `http_proxy` setting | No. Flutter and custom stacks skip it. | No | adb | Reject |
| VPN app on the phone (tun2socks) | Yes, with UDP | Yes (always-on + lockdown) | An extra app on each phone, a consent step | Fallback only |
| `iptables` in the codespace + redirector | Yes | Yes | `NET_ADMIN`. Our devcontainer has no `runArgs`, and Codespaces support is not confirmed. | Reject for now |
| LD_PRELOAD or ptrace on qemu | Partly | No | Nothing | Reject: fragile |
| **Emulator `-http-proxy` to a gateway in the runner** | Yes. The emulator's qemu (slirp) proxies all guest TCP, so app settings do not matter. | Yes, in the gateway | A boot flag change | **Use this** |

Source: https://developer.android.com/studio/run/emulator-networking-proxy

## Design

```
app on phone ─TCP─▶ qemu slirp ─CONNECT─▶ runner gateway 127.0.0.1:8792
                                              │ mode "direct": connect out from the codespace
                                              │ mode "laptop": CONNECT to 127.0.0.1:<link port>
                                              ▼
                     gh codespace ssh -R (or relay) ─▶ emuly proxy on the laptop
                                              ─▶ the internet, or an upstream HTTP/SOCKS5 proxy
```

### 1. Boot: the emulator always uses the gateway

- `phone/scripts/boot.sh` adds `-http-proxy http://127.0.0.1:8792`.
- Then the mode can change at run time, with no emulator restart.
- In `direct` mode the gateway only pipes bytes. The budget is under 5 ms extra at p50. Phase 0 measures it.
- Reserve port 8792 in `links-protocol.mjs`.

### 2. The runner gateway (`phone/runner/egress.mjs`)

- It is a CONNECT server on `127.0.0.1:8792` only.
- `direct` mode connects to the target. It refuses loopback, the codespace's private ranges and link-local addresses, so a phone app cannot reach the runner or other codespace ports through it. (`10.0.2.2` links do not use this path, because they go through `adb reverse`.)
- `laptop` mode sends the same CONNECT to the link port. If the link is down, the gateway **refuses the connection**. It never falls back to direct.
- The mode is saved in `/workspaces/.emuly/egress.json`, because `/tmp` is lost on stop. Boot and runner restart load it again.
- The gateway counts connections, bytes, refusals and the latency to the upstream.
- New runner routes: `GET /egress`, `POST /egress` (`{mode, port, lock}`) and `POST /egress/check`, which gets the exit IP through the current path.

### 3. DNS and UDP (no leaks)

- The guest resolves names through slirp, which uses the codespace's resolver. The IP does not leak, but the lookup location does, and CDNs then pick servers near the codespace.
- Fix: the emulator gets `-dns-server 127.0.0.77` (127.0.0.53 is taken by systemd-resolved). The runner runs a small DNS forwarder there. A setcap copy of node binds port 53 (Phase 0 check 5).
- In `laptop` mode, the forwarder sends each query as DNS over TCP, inside a CONNECT to the resolver on the laptop side (by default `1.1.1.1:53`, or as the user sets it). With an upstream proxy, DNS also leaves from the upstream proxy.
- UDP other than DNS cannot go through CONNECT. In `laptop` mode, the runner drops it inside the guest: `adb root` (allowed on the `google_apis` image; runner use only, the user passthrough still blocks `root`), then `iptables` and `ip6tables` `OUTPUT` drop UDP except to the slirp DNS address. QUIC then falls back to TCP.
- IPv6: drop it in `laptop` mode, unless Phase 0 shows that slirp sends IPv6 through the proxy.
- The rules come back on each boot while the mode is `laptop`.

### 4. The laptop side (`emuly proxy` in `bin/emuly.mjs`)

```
emuly proxy <phone> [--via http://user:pass@host:port | socks5://...] [--lock] [--allow-lan]
emuly proxy <phone> off
emuly proxy <phone> status
```

- It starts a CONNECT server in this process, on a random `127.0.0.1` port. It uses only Node, with no dependencies.
- It opens the link with the existing code (ssh route first, then the relay). Then it calls `POST /v1/phones/<id>/proxy`.
- It prints one JSON line: `{"ok":true,"mode":"laptop","exit_ip":"…","dns":"…","udp":"blocked"}`.
- `--via` chains to an upstream proxy. The password stays in this process. It is never sent to Emuly or written to disk, and never logged. `EMULY_PROXY_VIA` works too, so it is not left in shell history.
- By default it refuses targets on the laptop's loopback and LAN, so phone apps cannot scan the user's network. `--allow-lan` turns that off.
- Ctrl-C: without `--lock`, the phone goes back to `direct`. With `--lock`, the phone stays fail closed (no internet) until `emuly proxy <phone> off`.
- Reconnects use the same backoff as `emuly link`.

### 5. API and dashboard

- `GET`, `POST` and `DELETE /v1/phones/<id>/proxy` in `lib/phone/phone-agent-api.ts`, through the runner.
- The dashboard shows a badge on the phone: "Traffic: via laptop (exit 1.2.3.4)" or "Traffic: blocked, proxy offline". There is no setup form. The CLI does the setup (rule 3).
- The skill gets `references/tasks/proxy.md`. Raise `AGENT_RUNBOOK_VERSION`.
- Raise `RUNNER_VERSION` in `lib/phone/phone-setup.ts` and in `runner.mjs` `/health` together.

## Phase 0: spike in a live codespace (before any build)

Each item gets a yes or a no with proof. A "no" changes the design.

1. `-http-proxy` sends all guest TCP, including ports other than 80 and 443, as CONNECT.
2. When the proxy refuses, the guest connection fails. It does not go direct.
3. The `10.0.2.2` and `adb reverse` links still work with `-http-proxy` on.
4. Overhead in `direct` mode: page load and a 50 MB download, with and without the flag.
5. `-dns-server` with our forwarder works, and the forwarder can bind port 53.
6. `adb root` plus `iptables` UDP drop works on the API 36 `google_apis` image.
7. What IPv6 does with the flag on.
8. Can the mode change without an emulator restart. (Yes by design, because only the gateway changes.)

If 1 or 2 fail, use the VPN app option for `laptop` mode.

### Phase 0 results (2026-11-25, codespace `phone-bright-fox`, emulator 37.3.10, API 36)

A test gateway (Node, ~20 lines) ran on `127.0.0.1:8792`. It logged each request and could
allow or refuse. All 8 checks pass. The design stays.

| # | Result | Proof |
|---|---|---|
| 1 | Yes | The gateway log shows `CONNECT 140.82.112.4:443`, `:22` and `:8080`. Port 80 comes as a plain proxy request (`GET http://example.com/ HTTP/1.0`), not as CONNECT. The gateway must handle both forms. |
| 2 | Yes | In refuse mode, port 80 gets `403 Forbidden` and CONNECT gets a closed socket. With the gateway process stopped, every guest connect gets `Connection refused`. Nothing went direct. |
| 3 | Yes, with one change | `adb reverse` works (`HTTP/1.1 200 OK`). `10.0.2.2:3998` also works, but it reaches the gateway as `CONNECT 127.0.0.1:3998`. So the gateway must pass `127.0.0.1` targets to the codespace loopback in every mode, as before. A guest app cannot name the host loopback in another way. |
| 4 | Faster with the flag | See the table below. |
| 5 | Yes, on another address | `127.0.0.53:53` is taken by systemd-resolved. A forwarder on `127.0.0.77:53` works: `sudo setcap cap_net_bind_service=+ep` on a copy of node, then `-dns-server 127.0.0.77`. The forwarder logged every guest lookup. Lookups never go through the gateway. |
| 6 | Yes | `adb root` gives uid 0. `iptables -A OUTPUT -p udp ! -d 10.0.2.3 -j DROP` and the `ip6tables` rule apply. UDP send gets `Operation not permitted`. DNS still works. `adb unroot` gives uid 2000 again. |
| 7 | No IPv6 egress | The guest has only `fec0::` slirp addresses. A connect to `2606:4700:4700::1111` gets `Connection refused`. No leak. |
| 8 | Yes | The mode file changed between allow and refuse with no restart. The next connection used the new mode. |

Other findings:

- Android Private DNS sends `CONNECT 10.0.2.3:853` (DNS over TLS to the slirp DNS address). In `laptop` mode, refuse it. Android then uses port 53, which goes to the forwarder.
- The gateway sockets must use `allowHalfOpen: true`. Without it, a client that closes its send side cuts the download (2.8 MB of 50 MB arrived).
- Boot with `-http-proxy` took 36.6 s, the same as before.

Speed inside the guest (10 ms clock, 20 runs, phone idle):

| Test | No flag | With flag, `direct` |
|---|---|---|
| TCP connect to `1.1.1.1:443` | 10-20 ms | 10-20 ms |
| HTTP GET `example.com` (port 80) | ~520 ms | 30-40 ms |
| 50 MB from a codespace TCP source via `10.0.2.2` | 6,330-7,190 ms (~7 MB/s) | 910-930 ms (~54 MB/s) |

The gateway hop costs less than the 10 ms clock can show. Throughput is about 7 times higher,
because the host side of each connection is a real kernel socket and not slirp's TCP.

## Test plan

### Unit tests (`lib/phone/*.test.ts`, `node --test`)

- Gateway: CONNECT parsing, `direct` vs `laptop` mode, refusal when the link is down, the blocked address ranges, the mode file after a restart, counters.
- DNS forwarder: UDP to TCP framing, timeouts, refusal when the link is down in `laptop` mode.
- Laptop proxy: CONNECT pass-through, `--via` HTTP and SOCKS5 with auth (against test servers in the test), LAN refusal, `--allow-lan`, no password in output or errors.
- CLI: arguments, Ctrl-C with and without `--lock`, reconnect.
- API: auth, input validation, runner errors.

### Live tests in a codespace

| Test | Pass when |
|---|---|
| Exit IP | An IP echo site on the phone shows the laptop's IP (and the upstream's IP with `--via`). |
| All apps | A Flutter app and Chrome both show the laptop IP. |
| DNS | A DNS leak test site shows no codespace resolver. |
| UDP | A UDP request fails. Chrome still loads pages over TCP. |
| Fail closed | Kill the CLI with `--lock`: pages fail and nothing goes direct. |
| Back to direct | Ctrl-C without `--lock`: the internet works again within 2 s. |
| Persistence | Restart the runner, then stop and start the phone: the mode and rules come back. |
| Reconnect | Drop the laptop network for 30 s: traffic resumes after the reconnect. |
| Speed | Record page load and throughput in direct mode before and after, and in laptop mode. |

#### Results (2026-11-25, 12:00-12:50 IST, `phone-bright-fox`, runner 23 from this branch)

The real runner and `boot.sh` ran in the codespace. A local fake API passed the `/v1` link and
proxy calls to the runner. The CLI ran on Windows 11 with the ssh route. A probe in Android
compared the exit IP with the laptop and codespace IPs, without printing them.

| Test | Result |
|---|---|
| Boot flags | Pass. `-http-proxy http://127.0.0.1:8792` and `-dns-server 127.0.0.77` are on. The setcap node copy binds port 53. |
| Exit IP (direct) | Pass. The codespace IP. HTTP GET 490-530 ms. |
| Exit IP (laptop) | Pass. The laptop IP, in Android and in `check`. HTTP GET 600-1,200 ms. The first JSON line comes in about 10 s. |
| DNS (laptop) | Pass. `"dns":"laptop"`. With the proxy killed and `--lock`, a new name fails (`unknown host`). |
| UDP | Pass. `"udp":"blocked"`. The `emuly_udp` chain has its DROP rule, and a UDP send gets `not permitted`. `su 0` works, so adbd does not restart. Direct mode flushes the chain. |
| Back to direct | Pass. Ctrl-C without `--lock` gives `"mode":"direct"` at once. The next probe shows the codespace IP. |
| Fail closed | Pass. Hard kill with `--lock`: no exit IP, TCP 443 fails, DNS fails, `laptop_connected:false`. `emuly proxy <phone> off` gives direct again. |
| Killed without `--lock` | Pass. The runner goes back to direct after 91 s (the 90 s limit). |
| Speed, 1 MB over HTTP | Direct 0.41-0.67 s. Laptop 2.2 s (~0.47 MB/s; the laptop upload is ~0.42 MB/s). |

Bugs found live and fixed (each has a unit test):

- NAT64 addresses (`64:ff9b::/96`) from the laptop's DNS were refused as private. Now the IPv4 inside is checked.
- Direct mode now checks every address of a name, and uses IPv4 first (the codespace has no IPv6 route).
- Plain HTTP: some servers (api.ipify.org) drop a request when the client half-closes. The gateway
  no longer passes that half-close to the server for plain HTTP. CONNECT still passes it.

Not run: Chrome and a Flutter app on screen, a DNS leak site, a 30 s laptop network drop,
and `--via` against a real upstream proxy (the unit tests cover HTTP and SOCKS5 auth).

### Live tests for `emuly dev` (already built, not yet tested live)

| Test | Pass when |
|---|---|
| Tunnel | `adb devices` shows `127.0.0.1:15555 device` within 15 s. |
| Flutter | `flutter run -d <serial>` installs, and hot reload applies a change. Record the times. |
| Expo | `npx expo run:android --device <serial>` loads, and Fast Refresh works without a link. |
| Extra port | `emuly dev <phone> 3000` reaches a laptop server from the app. |
| Second run | A second `emuly dev` reuses the tunnel and exits. |
| Reconnect | Drop the network: adb comes back, and the message says to rerun `flutter run`. |
| Ctrl-C | adb disconnects, the links are removed and the lock file is gone. |
| Errors | No gh, the wrong gh account, no adb, and the phone stopped each give the right `error`. |
| Platforms | Windows, and Linux or macOS if available. |

#### Results (2026-11-25, Windows 11, `phone-bright-fox` on the ditipriya02 account)

A fake API on `127.0.0.1:4399` gave the codespace name, because the phone is in another Emuly
account. The tunnel, gh and adb parts were real.

| Test | Result |
|---|---|
| Tunnel | Pass. `127.0.0.1:15555 device` in 13.2 s. gh picked the owner account by itself. `adb shell echo` takes 140 ms. |
| Flutter | Not run. Flutter is not installed on this laptop. |
| Expo / Metro | Partly. `adb reverse tcp:8081` through the tunnel reached a laptop server (`METRO-LAPTOP /status`). A full Expo build was not run. |
| Extra port | Bug found and fixed: the ready line waited up to 30 s for the runner to confirm the extra port. Now adb is announced first (11 s), and the port check runs after. A full test needs the real runner. |
| Second run | Pass. It reused the tunnel and exited in 0.35 s (`route: "shared"`). |
| Reconnect | Pass. After the ssh process was killed, adb was back in 9 s, with the "run flutter run again" line. |
| Ctrl-C | Pass. adb disconnected, `DELETE /links?port=3000` was sent, and the lock file was removed. |
| Hard kill | The lock file and an `offline` adb entry stay. The next run recovers: the dead PID is ignored and the entry is replaced. |
| Errors | Pass: `phone_not_running`, `no_adb`, `needs_gh` (no gh, and the wrong owner with the right login hint), `unauthorized`. |
| Speed | `adb push` of 20 MB of random data: 0.2-0.6 MB/s. The laptop upload is 0.42 MB/s (Cloudflare test), so the uplink is the limit, not the tunnel. `-C` does not help random data. A 60 MB debug APK takes about 2.5 min on this link. Hot reload sends only small deltas. |

## Order of work

1. Phase 0 spike, with a written result in this file.
2. Runner gateway, DNS and UDP rules, with unit tests and a runner version bump.
3. CLI `emuly proxy`, with unit tests.
4. `/v1` API, the dashboard badge and the skill page.
5. Live tests for proxy and dev, with the results in this file.
6. `pnpm lint`, `pnpm test`, `pnpm build`, then merge.
