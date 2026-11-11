# Working from a remote machine

Read this when you run on a machine the user reaches over SSH or Tailscale, for example a
Linux VM. The user sits at another computer (Windows, macOS or Linux). Everything else in
the playbook still applies; this file changes only what the user sees and where things run.

## 1. Know where you are

Check once per session, without asking the user:

```sh
echo "ssh=${SSH_CONNECTION:-none} display=${DISPLAY:-}${WAYLAND_DISPLAY:-}"
command -v tailscale >/dev/null && tailscale status --self --peers=false
```

- **Remote:** `SSH_CONNECTION` is set, or there is no display.
- **Over Tailscale:** the first address in `SSH_CONNECTION` is in 100.64.0.0/10. Then:
  - `tailscale whois <that address>` gives the user's computer name (first label of
    `Name`, for example `my-pc`).
  - `tailscale status --json` gives its `OS` (look up the peer by that address), and this
    machine's name in `Self.DNSName` (drop the trailing dot), for example
    `my-vm.tail1234.ts.net`.
- **Remote without Tailscale:** you know the user's address but not their computer. For
  commands they run, use `<user>@<this machine>` with `whoami`, and ask once which host name
  they use to SSH in only when a step needs it.

Say what you found in one line, once, for example: "You are on a remote Linux machine over
Tailscale from my-pc (Windows), so I will give you links to open there."

## 2. Links

The browser link is the best way to see the phone from a remote machine. It needs nothing
on either computer. Every link is for the user's own computer:

"Open this on your computer to view the phone now: <browser_url>"

Never try to open a browser on the remote machine.

## 3. Installs run here, not on the user's computer

agent-device, Node and gh install on this machine, because this is where you run. They may
need `sudo`: ask first, and never type a password for the user. Prefer a user-level install
(nvm, fnm, `npm install -g` with a user prefix) so no `sudo` is needed.

## 4. scrcpy from a remote machine

There is no screen here, so a scrcpy window can never open here. In the scrcpy offer in
`references/phones.md`, change option 2 to:

```text
2. scrcpy window on your computer (<computer name>)
   + Smoother, with less delay.
   - You install scrcpy on <computer name> once, and run one command I give you.
```

After a yes, you run the tunnel here, and the user runs scrcpy there. Follow
`references/native-adb.md` steps 1 to 2 on this machine (only `gh` is needed here, not adb
or scrcpy), then pick the path below. Give the user exactly one command to run, in a code
block, with the install line for their OS only if they do not have scrcpy yet:

- Windows: `winget install --id Genymobile.scrcpy -e --source winget`
- macOS: `brew install scrcpy`
- Linux: `sudo apt install scrcpy`

### Over Tailscale (best)

Bind the tunnel to this machine's Tailscale address, so only the user's tailnet can reach
it. Start it in the background:

```sh
ts_ip=$(tailscale ip -4 | head -n1)
gh codespace ssh -c <codespace-name> -- -N -o GatewayPorts=yes -L "$ts_ip:<port>:127.0.0.1:5555"
```

Check that `ss -ltn` lists `$ts_ip:<port>`. Then the user runs, on their computer:

```sh
scrcpy --tcpip=<this machine's Tailscale name>:<port>
```

Tell them in one line: "Only devices in your tailnet can reach this port. I close it when
you are done."

### Plain SSH

Keep the tunnel on loopback here, exactly as in `references/native-adb.md` step 3. The user
forwards it to their computer and starts scrcpy there, in one terminal:

```sh
ssh -N -L <port>:127.0.0.1:<port> <user>@<host>
```

and in a second terminal:

```sh
scrcpy --tcpip=127.0.0.1:<port>
```

### Close it

When the user is done, stop the background tunnel here. Never leave the port open after
the task.

## 5. Screenshots and files

The user cannot open a path on this machine. Use the first way that works:

1. A send-file tool in your chat (for example `SendUserFile`). This works in remote and SSH
   sessions too.
2. **Over Tailscale:** offer Taildrop once: "Send screenshots straight to <computer name>
   with Taildrop?" On a yes, run `tailscale file cp <file> <computer name>:` and say "Sent
   to <computer name>; it is in your Downloads." If it fails (Taildrop off, or not allowed),
   fall back to 3.
3. Give one command the user runs on their own computer, for example:
   `scp <user>@<host>:<full path> .`

Pulled device files and bugreports follow the same rule.
