# The app's server

> Read this file only if the app on the phone calls a server. If not, stop reading now, and do not read the
> other files in this folder.

Read this before you test an app on the phone. Most apps call a server, such as an API, a
websocket or the Metro bundler. The phone runs in a codespace. It cannot open a connection to the user's laptop.
On the phone, `localhost` is the phone itself, not the laptop.

A **link** fixes this. A link is a tunnel for one TCP port from the phone to the laptop. The
laptop opens the connection outward, so the user's router permits it. After the link starts,
the app calls `localhost:<port>` or `10.0.2.2:<port>`.

A link is raw TCP. HTTP, websocket, gRPC and Metro on 8081 work. UDP does not work.

## 1. Use the shortest path

Use a link only when the server needs one.

| Where the server is | What you do | Address in the app |
| --- | --- | --- |
| Public internet | Nothing | The public URL |
| Inside the codespace | Nothing | `10.0.2.2:<port>` |
| Laptop localhost | `emuly link <phone> <port>` | `localhost:<port>` |
| A machine the laptop can reach (LAN, VM, Tailscale) | `emuly link <phone> <port> --to <host>:<port>` | `localhost:<port>` |

Run `emuly link` on the machine that can reach the server. If you run on a remote VM and the
server runs on that VM, run it on the VM.

## 2. Check before the test

Do this before you test any app, even when the user does not mention a server. Do not wait
for the app to fail.

### Find the server address

Most apps keep the server address in an env file or in the build config. Look in this order:

| Where | What to look for |
| --- | --- |
| Env files | `.env`, `.env.local`, `.env.development`, `.env.*` |
| Expo | `EXPO_PUBLIC_*` names, `app.json` or `app.config.*` (`extra`), `eas.json` (`env`) |
| React Native | `react-native-config` and its `.env` files, `Config.<NAME>` in the code |
| Android native | `buildConfigField` in `build.gradle*`, `local.properties`, `gradle.properties`, `res/values/*.xml` |
| Flutter | `--dart-define` and `--dart-define-from-file` in launch configs and scripts, `flutter_dotenv` files |
| The code | Names such as `API_URL`, `BASE_URL`, `BACKEND_URL`, `SERVER_URL`, `WS_URL` |

Also read the scripts that start the backend (`package.json`, `docker-compose.yml`). They give
the port when the env has no full URL.

### Use the install result

`POST <base>/v1/phones/<id>/app-installs` reads the APK before it installs it. The finished
operation has `serverUrls`, the server URLs inside the APK that need a link, for example:

```json
"serverUrls": [{ "url": "http://localhost:3000", "host": "localhost", "port": 3000 }]
```

This works when there is no source code. An empty or missing `serverUrls` does not prove that
the app needs no link, because the app can build the URL at run time. Still check the env files.

### Test each address

1. Ignore public addresses. They need nothing.
2. For each other address, call `GET <base>/v1/phones/<id>/net-check?target=<host>:<port>`.
   The runner tests the address from inside the emulator. The reply has `reachable`, `class`
   and `fix`. `reachable: true` means a server replied, or kept the connection open. A link
   with no server behind it is `reachable: false` and `linked: true`. Then the `fix` tells you
   to start the server on the laptop. Do not create the link again.
3. If `reachable` is false, run the `fix` command. It starts a link, or tells you what to change.
4. Tell the user in one line what you found and what you did.

### The build fixes the address

A mobile app reads its env when it is built, not when it runs. If you change an env file to
`localhost:<port>`, build the app again before the install. For an Expo or React Native dev
build, restart Metro instead.

### After a failure

If the app still cannot connect, call `GET <base>/v1/phones/<id>/net-check` with no target.
It reads recent logcat lines for connection errors (`ECONNREFUSED`, `UnknownHostException`,
blocked cleartext HTTP) and gives a hint for each.

Example reply:

```json
{ "target": "localhost:3000", "reachable": false, "class": "laptop-loopback",
  "fix": "emuly link phone-quiet-falcon 3000", "logcat": [] }
```

The app must call `localhost` or `10.0.2.2`, not the real host name of the laptop. If the
app's dev config has a LAN address or a `.ts.net` name, change the dev config to
`localhost:<port>`.

## 3. Start a link

There are two ways. Use the first that the user permits.

### A. `emuly link` (one file, no install)

The Emuly server gives its own CLI. It is one Node file with no dependencies, and it always
matches the server. Nothing is installed: no npm package, no global command.

```sh
mkdir -p ~/.config/emuly
curl -fsSL "$EMULY_BASE_URL/v1/cli" -o ~/.config/emuly/emuly.mjs
node ~/.config/emuly/emuly.mjs link <phone> 3000 8081
# {"ok":true,"verified":true,"phone":"...","route":"ssh","ports":[3000,8081],...}
```

- In a clone of the Emuly repo, `node bin/emuly.mjs link ...` is the same file.
- The response header `X-Emuly-Cli-Sha256` is the SHA-256 of the file. When the server has a
  newer copy, the CLI downloads it, checks it and replaces itself. It needs no help.
- Start it in the background. It runs until you stop it, and it prints one line of JSON on
  stdout when the link works.
- One process can hold several ports. Do not start one process for each port.
- `"verified": false` means the tunnel runs, but the runner does not see the port yet.
- `listening_here: false` on a target means nothing listens on that port of this computer.
  Start the server. The link waits for it.
- `"ok": false` has an `error` and a `message`. Read the message and act on it.
- Messages for people go to stderr.
- To stop the link, stop the process (Ctrl-C). It removes its ports from the phone.
- `links <phone>` lists the links. `unlink <phone> [port]` removes them.

### B. No Emuly CLI (the user does not permit it)

Do not download the CLI when the user said no. Use the API and `gh` directly. This is
Route A only: it needs `gh`, logged in with the account in `github_login`.

1. `POST /v1/phones/<id>/links` with `{"ports":[3000]}`. The answer has `ssh` (the command
   as an array), `codespace_name` and `github_login`.
2. Run the `ssh` command in the background. If the active gh account is not `github_login`,
   give it that account's token for this process only:

   ```sh
   GH_TOKEN="$(gh auth token -h github.com -u <github_login>)" gh codespace ssh -c <codespace_name> -- -N -o ExitOnForwardFailure=yes -R 3000:127.0.0.1:3000
   ```

3. `GET /v1/phones/<id>/links` until the port shows `listening: true`.
4. Check it from the phone: `GET /v1/phones/<id>/net-check?target=localhost:3000`.
5. At the end, stop the ssh process and `DELETE /v1/phones/<id>/links?port=3000`.

If `gh` is not installed either, there is no link. Tell the user that the app cannot reach
the laptop server, and ask how to continue. Do not install anything without a yes.

### Links end by themselves

When the tunnel goes, for example the process was killed, the runner removes the link after
60 s. A link that never gets a tunnel goes after 120 s. Create it again when you need it.

A link stops when the phone stops. After the user starts the phone again, start the link again.

## 4. Which route emuly link uses

`emuly link` selects the route. Do not select it yourself, unless a route fails.

| Check | Result | Route |
| --- | --- | --- |
| `gh auth status` | Logged in, with the codespace scope | Route A: SSH tunnel through GitHub. Faster. |
| `gh auth status` | Installed, not logged in | Route B: relay through Emuly. Tell the user that `gh auth login -s codespace` makes links faster. |
| `gh auth status` | Logged in, no codespace scope | Route B. Tell the user about `gh auth refresh -h github.com -s codespace`. |
| `gh --version` | Not installed | Route B. Do not install gh. |
| `node --version` | Older than 22, and gh is not ready | No route works. See below. |

`--route ssh` or `--route relay` forces a route. If Route A fails before it works (for example,
the gh account does not own the codespace), `emuly link` uses Route B and prints the reason.

### When no route works

Ask the user one question: "Can I install the GitHub CLI?" Install nothing before a yes.

1. Windows: `winget install --id GitHub.cli`. macOS: `brew install gh`. Linux: follow
   https://github.com/cli/cli/blob/trunk/docs/install_linux.md
2. Run `gh auth login --web -s codespace`. The user approves one time in the browser.
3. Run `emuly link` again. It now uses Route A.

The GitHub account in gh must own the codespace of the phone.

## 5. Route A by hand

Use this only when you cannot run `emuly link`.

1. `POST <base>/v1/phones/<id>/links` with `{"ports":[3000]}`. The reply has
   `codespace_name` and `ssh`, the full command.
2. Run the `ssh` command in the background, for example:
   `gh codespace ssh -c <codespace_name> -- -N -o ExitOnForwardFailure=yes -R 3000:127.0.0.1:3000`
3. `GET <base>/v1/phones/<id>/links` shows `"listening": true` for the port when it works.
4. When you are done, stop the ssh process and call `DELETE <base>/v1/phones/<id>/links?port=3000`.

Route B needs `emuly link`. It has no manual steps.

## 6. Safety

- Each end binds to loopback only. The codespace port never becomes public.
- A link opens one port. It does not open the full network of the laptop.
- Ask the user before you link a target that is not localhost (`--to`). Also ask before
  you link a database port.
- Each app on the phone can reach a linked port. Link only the ports the app needs.
- Stop the link when the task ends.
