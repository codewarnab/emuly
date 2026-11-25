# `emuly dev <phone>`: hot reload with local tools

## Goal

One command connects the phone to adb on this computer. After it runs, `flutter run`,
`npx expo run:android`, `npx react-native run-android` and Android Studio see the phone.
Hot reload then works with no extra step.

## How it works

- `emuly dev` starts one `gh codespace ssh` process. It forwards a local port to the
  emulator's adbd (`-L 127.0.0.1:<port>:127.0.0.1:5555`). Extra ports go in the same
  process as reverse links (`-R`), as in `emuly link`.
- Then it runs `adb connect 127.0.0.1:<port>` and waits for the `device` state.
- Metro needs no link. Expo and the React Native CLI run `adb reverse tcp:8081` themselves,
  and that reverse goes through the adb connection. Flutter uses `adb forward` for its VM
  service, which also goes through it.
- The relay route cannot carry adb, because the relay only goes from the phone to the
  laptop. So `dev` needs gh with the account that owns the codespace.

Usage: `emuly dev <phone> [port...] [--adb-port N]`. It runs until Ctrl-C and prints one
line of JSON when adb is ready.

## Edge cases

### Where the toolchain runs

Rule: run `emuly dev` on the machine where `flutter` or `expo` runs. That machine needs
`adb` and `gh`.

| Setup | What `dev` does |
|---|---|
| Laptop: agent, editor and toolchain | Normal case. Tunnel to `127.0.0.1`. |
| Remote VM over SSH: agent and toolchain on the VM | Run `dev` on the VM. The user watches the phone in the browser link. |
| Toolchain on the VM, VS Code Remote-SSH from the laptop | Same as above. The editor's extensions run on the VM. |
| Agent on the VM, toolchain on the laptop | `dev` runs on the laptop. The agent gives the user one command. |
| Toolchain inside the phone's codespace | No tunnel. `dev` sees `CODESPACE_NAME` and uses the local emulator. |
| Toolchain in a dev container | A container has its own loopback. `dev` must run inside it. It says so. |
| WSL 2 with Windows Android Studio | Two adb servers. Run `dev` on the side whose adb the IDE uses. `dev` warns when both exist. |
| scrcpy on the laptop, toolchain on the VM | Out of scope. Keep the `remote.md` flow. |

### adb

- An adb server from another SDK version runs: `connect` fails. Print `adb kill-server` as
  the fix. Do not kill it, because that drops the user's other devices.
- More than one device: always print `-d <serial>` and `ANDROID_SERIAL=<serial>`.
- `unauthorized`: report it. Do not loop.
- `offline` after a reconnect: `adb disconnect`, then `connect` again.
- adb is not on PATH: look in `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the default SDK
  folders. If none exists, report `no_adb`. Install nothing.
- Port choice: start at 15555. A local emulator scans 5555–5585, so stay out of that range.
- Two `dev` runs for one phone: a lock file `~/.config/emuly/dev-<phone>.json` holds the port
  and PID. The second run reuses the port, connects adb and exits.

### Tunnel

- No gh, or no account that owns the codespace: `needs_gh` with the login command.
- No sshd in the codespace: a hard error with gh's last stderr line.
- The laptop sleeps or the network drops: the loop restarts ssh and runs `adb connect`
  again. Flutter loses its VM service, so `dev` says to run `flutter run` again.
- The phone stops: exit with `phone_not_running`. Never start the phone; that uses the
  user's hours.
- Codespace idle timeout: forwarded-port traffic may not count as activity. Test this. Add
  a keepalive only if it is needed.
- Slow installs: ssh compression (`-C`) is on. Measure it.

### Frameworks

- Expo Go needs the Expo Go app on the phone. A dev build does not.
- Compose Live Edit needs API 30+. `dev` reads the API level and warns when it is lower.
- A backend on the laptop: `emuly dev <phone> 3000` adds a reverse link in the same process.

### Security

- `-L` binds to `127.0.0.1` only. adb gives full control of the phone.
- On a remote VM, never expose the adb port to the network.
- The lock file holds no token.

## Measure

Before and after: time from the command to `device`, the first `flutter run` install time,
and one hot reload.
