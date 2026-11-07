# Plan: boot Android and show a live phone screen

Status: phases 0-5 implemented locally, 2026-11-07. Real Codespace and browser acceptance checks are pending.
See [the implementation report](live-screen-report.md) for delivered work, checks, and remaining risks.

## 1. Where we are now

- Setup works. The runner in the codespace answers on `127.0.0.1:8790`.
- The runner already has `POST /boot`, `GET /screenshot`, `POST /tap`, `POST /swipe` and `POST /text` (`phone/runner/runner.mjs`).
- phonelink never calls `/boot`, so Android stays off. The stage shows "Waiting for the screen".
- phonelink reaches the codespace only through `codespaceExec` (`lib/codespace-tunnel.ts`). Each call opens a new tunnel and takes 20–40 s. That is good for setup, but too slow for a screen.

## 2. What T3 Code does

T3 Code has a "Device panel" with a live Android emulator (`apps/web/src/components/device/DeviceStreamView.tsx`, `packages/client-runtime/src/device/stream.ts`).

- On the device host, a hub (expo-device-hub, "serve-emu") encodes the screen as H.264.
- One WebSocket carries the video frames to the browser. Each frame has a small header with a keyframe flag.
- The browser decodes with WebCodecs `VideoDecoder` (`optimizeForLatency: true`).
- Input goes back on the same WebSocket as JSON: touch, key, text, back.
- Only a visible tab streams. On a decode error, the client asks for a new keyframe.
- The server proxy accepts only known routes and checks a short-lived ticket for each WebSocket.

We copy this design, but we use scrcpy for the encoder. scrcpy runs on the emulator and needs no ffmpeg.

## 3. Options for the screen

| Option | Delay | Frames per second | Input | Work |
|---|---|---|---|---|
| A. PNG screenshot every second | 0.5–1 s | 1–2 | Separate tap requests | Very small |
| **B. scrcpy H.264 + WebCodecs** | **50–150 ms + tunnel** | **30–60** | **Same socket: touch, keys, text, scroll** | **Medium** |
| C. Emulator gRPC / WebRTC | Low | 30–60 | gRPC | Large. WebRTC needs UDP, and the tunnel has only TCP |
| D. `adb screenrecord` | High | Changes | None | Small, but it stops after 3 min |

**Decision: B is the target.** It gives the best UX and the smallest bandwidth (1–4 Mbps). It is also the design that T3 Code uses.
**A is the fallback.** It shows the screen in Phase 2 before the stream is ready. It also helps when the browser has no WebCodecs.

## 4. The connection problem (solve this first)

A live screen needs a connection that stays open. There are two ways:

1. **Keep one tunnel open for each phone that someone watches.** The server already has the tunnel code. A new `PhoneLink` keeps the tunnel and the SSH session open, and forwards port 8790. It closes after 2 minutes with no viewers.
2. **Use the codespace's forwarded-port URL** (`https://<codespace>-8790.app.github.dev`). The port stays private, and the server sends the owner's token in the `X-Github-Token` header. This is simpler, but we must test that a GitHub App user token works there.

**Decision:** test option 2 first in a short spike, because it is less code. If it fails, use option 1.

In both options, the browser never talks to the codespace. It talks to phonelink, and phonelink adds the token. The token never goes to the browser.

## 5. Phases

### Phase 0. Spike (half a day)
- Test the forwarded-port URL with `X-Github-Token` for HTTP and WebSocket.
- Measure: the time to the first byte, and the round-trip time of `/health`.
- Check how Next.js 16 handles a WebSocket upgrade (read `node_modules/next/dist/docs/`). If a route handler cannot do it, run a small WebSocket proxy next to Next.js.
- **Done when:** we know the connection path, and it gives a round trip under 300 ms.

### Phase 1. Boot Android automatically (1 day)
- After "Phone ready", phonelink calls `POST /boot` with `resume`.
- New events in the log: "Android starting" and then "Android ready (took 98 s)".
- The stage shows "Starting Android…" with the elapsed minutes. The first boot takes about 100 s, and a resume takes about 15 s.
- If the boot fails, the stage shows the reason and a **Retry boot** button. This is also the "retry one step" that you asked for.
- **Stop** calls `POST /stop` first, so the snapshot is saved and the next start takes 15 s.
- **Done when:** a new phone goes from "create" to "Android ready" with no clicks.

### Phase 2. First screen: screenshots (1 day)
- A server route `GET /app/phones/[id]/screen.png` gets `/screenshot` through the connection from section 4.
- The stage shows the image and loads a new one every second while the tab is visible.
- A click on the image sends `POST /tap` at the matching point on the phone.
- Home, Back and Screenshot buttons work.
- **Done when:** you can see the phone and open an app with clicks.

### Phase 3. Live stream with scrcpy (2–3 days)
- Setup also installs `scrcpy-server` (one jar file, pinned version with its sha256).
- The runner gets `GET /stream` (WebSocket). It starts scrcpy with `video_codec=h264`, `max_size=1080`, `max_fps=30`, and sends each frame with a small header (keyframe flag, time).
- phonelink proxies the WebSocket. It checks the user's session and a ticket that is good for 60 s.
- The browser decodes with WebCodecs and draws on a `<canvas>`. Library: `@yume-chan/scrcpy` with `@yume-chan/scrcpy-decoder-webcodecs`.
- The stream pauses when the tab is hidden, and it starts again with a fresh keyframe.
- If the stream drops, the client tries again after 1 s, 2 s, then 5 s, and shows the last screenshot during that time.
- **Done when:** the screen moves smoothly, and the delay from a click to a change is under 300 ms.

### Phase 4. Full input (1–2 days)
- Touch: down, move and up, so swipes and scrolls feel natural. The mouse wheel scrolls.
- Keyboard: when the screen has focus, keys and text go to the phone. Ctrl+V pastes text.
- Buttons: Home, Back, Recent apps, Rotate, Volume, Screenshot (saves a PNG).
- **Done when:** you can use the phone with the mouse and keyboard only.

### Phase 5. Polish (1 day)
- A small badge shows the frames per second and the delay.
- A quality setting: Auto, Sharp (1080p) or Saver (720p, 15 fps).
- When the phone stops, phonelink keeps the last frame. The stage shows it dimmed with "Resting".
- **Done when:** the stage never shows an empty box.

## 6. UX states of the stage

| Phone state | Stage shows | Main action |
|---|---|---|
| Codespace starting | "Starting the codespace" and minutes passed | Stop |
| Setup running | "Installing Android" and minutes passed | Stop |
| Setup failed | The reason | Retry setup |
| Android booting | "Starting Android" and minutes passed | Stop |
| Boot failed | The reason | Retry boot |
| Live | The screen and the controls | Stop |
| Stream lost | The last frame dimmed, "Reconnecting…" | Retry |
| Resting | The last frame dimmed | Wake |

## 7. Risks

- **The tunnel may add too much delay.** The Phase 0 spike measures it before we build the stream.
- **WebCodecs needs HTTPS or localhost.** Local development uses localhost, so it works. Production must use HTTPS.
- **The emulator uses software graphics (swiftshader).** scrcpy encoding takes CPU. If the 4-core machine is too slow, we use 720p and 24 fps.
- **Cost:** each open stream keeps the codespace busy, so the idle stop does not happen while someone watches. That is correct.

## 8. Total work

About 7–9 working days for Phases 0–5. Phases 1 and 2 (3 days) already give a phone that you can see and use.
