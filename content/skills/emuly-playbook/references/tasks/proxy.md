# Phone traffic through the user's computer (`emuly proxy`)

Use this when the user wants the phone's traffic to leave from their computer, their network,
their VPN, or a proxy that they name. Examples: "test from my IP", "use my office network",
"route the phone through this proxy", or a site that blocks cloud IPs.

All TCP of the phone then goes through the computer. DNS goes there too. Other UDP is blocked,
so apps use TCP (QUIC falls back to TCP). Nothing goes direct while the proxy is on.

## Start

Get the CLI first if you do not have it (see `references/tasks/local-servers.md`). Then run it in
the background. It runs until it is stopped.

```
emuly proxy <phone>
```

The first stdout line is JSON:

```
{"ok":true,"phone":"…","mode":"laptop","route":"ssh","via":"this computer","exit_ip":"…","check":"passed","dns":"laptop","udp":"blocked","lock":false,"lan":"blocked"}
```

- `exit_ip` is the address that sites see. Tell the user in one line. Do not log it or write it to a file.
- `check` is not `passed`: read the error lines on stderr, then see "Errors" below.
- `udp` is `open`: TCP still goes through the computer, but other UDP leaves from the codespace. Tell the user.
- `dns` is `codespace`: lookups use the codespace resolver. Tell the user.

## Options

| Option | Use when |
|---|---|
| `--via http://host:port` or `--via socks5://host:port` | The user names an upstream proxy. Add `user:pass@` before the host if it needs a login. |
| `--lock` | The user wants no traffic at all when the proxy stops (fail closed). |
| `--allow-lan` | The app on the phone must reach a server on the user's LAN or on `localhost` of the computer. Ask first. |
| `--route relay` | `gh` does not work. The relay is slower. |

- A password is a secret. Ask the user to set it in `EMULY_PROXY_VIA` in their own shell, so you
  never see it, and it does not go into shell history. Never put it in a command that you show,
  a log or a file. The CLI keeps it on the computer and never sends it to Emuly.
- By default the CLI refuses the computer's loopback and LAN addresses, so an app on the phone
  cannot scan the user's network. `--allow-lan` turns that off. Ask the user before you use it.
- For a server on the computer's `localhost`, a link (`emuly link`) is the better fix.

## Stop

- Stop the process (Ctrl-C). Without `--lock`, the phone goes back to its own network within 2 s.
- With `--lock`, the phone stays offline until: `emuly proxy <phone> off`
- `emuly proxy <phone> status` prints the mode. `"laptop_connected": false` in `laptop` mode means
  the phone has no internet now.

## API (when you cannot run the CLI)

- `GET /v1/phones/<id>/proxy`: the mode, `laptop_connected`, `dns`, `udp` and counters.
- `DELETE /v1/phones/<id>/proxy`: back to direct. Use it to undo a `--lock`.
- `POST /v1/phones/<id>/proxy/check`: the exit IP through the current path.
- `POST /v1/phones/<id>/proxy` with `{"mode":"laptop","port":18792}` needs a link on that port
  to a CONNECT proxy. The CLI does this for you. Do not build it by hand.

## Errors

| Error | Do this |
|---|---|
| `via_auth` | The upstream proxy refused the login. Ask the user to check the user name and password. |
| `via_unreachable` | The upstream proxy does not answer from this computer. Check the host and port. |
| `runner_update_required` | The phone runs an old runner. Stop and start the phone, then try again. |
| `check` is `timeout` or `refused` | The link is up, but the computer cannot reach the internet, or the proxy refused. Check the computer's network. |
