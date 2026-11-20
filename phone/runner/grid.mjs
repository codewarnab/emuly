// Frame grid (contact sheet) from a finished recording: GET /recording/grid?fps=2.
// ffmpeg takes frames at a fixed rate and tiles them into one JPEG, each with its time.
// An agent sees short-lived toasts and snackbars in one image, without a video player.
// A long recording has more frames than one sheet holds: ?page=N returns the next sheet.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export const GRID_LIMITS = {
  fps: { min: 0.1, max: 10, default: 2 },
  cols: { min: 1, max: 10, default: 6 },
  width: { min: 80, max: 480, default: 200 },
  count: { min: 1, max: 100, default: 36 },
};
const MAX_JPEG_BYTES = 8 * 1024 * 1024;
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

export class GridError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Reads fps, cols, width, count and page from a query. A bad value gets a 400 that names the limits. */
export function gridOptions(params) {
  const options = {};
  for (const [name, limit] of Object.entries(GRID_LIMITS)) {
    const raw = params.get(name);
    const value = raw === null || raw === "" ? limit.default : Number(raw);
    if (!Number.isFinite(value) || value < limit.min || value > limit.max || (name !== "fps" && !Number.isInteger(value))) {
      throw new GridError(400, "invalid_input", `${name} must be ${name === "fps" ? "a number" : "a whole number"} from ${limit.min} to ${limit.max}.`);
    }
    options[name] = value;
  }
  const page = params.get("page") ?? "0";
  if (!/^\d{1,5}$/.test(page)) throw new GridError(400, "invalid_input", "page must be a whole number from 0.");
  options.page = Number(page);
  return options;
}

/** Which part of the recording a page covers. Pure, so tests can check it without ffmpeg. */
export function gridPage(durationMs, { fps, cols, count, page }) {
  const total = Math.max(1, Math.ceil((durationMs / 1000) * fps));
  const pages = Math.ceil(total / count);
  if (page >= pages) throw new GridError(404, "grid_page_out_of_range", `The recording has ${pages} page(s) at fps=${fps} and count=${count}. Use page 0 to ${pages - 1}.`);
  const frames = Math.min(count, total - page * count);
  return { startS: (page * count) / fps, frames, pages, cols: Math.min(cols, frames), rows: Math.ceil(frames / Math.min(cols, frames)) };
}

function filter(options, layout, font) {
  const parts = [`fps=${options.fps}`, `scale=${options.width}:-2`];
  // pts:hms:<offset> prints the time in the whole recording, not in the cut.
  if (font) parts.push(`drawtext=fontfile=${font}:text='%{pts\\:hms\\:${layout.startS}}':x=4:y=4:fontsize=${Math.max(10, Math.round(options.width / 14))}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`);
  parts.push(`tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=0x202020`);
  return parts.join(",");
}

/** Makes one JPEG sheet. Returns { jpeg, layout }. */
export async function makeGrid({ path, durationMs, options, ffmpeg = "ffmpeg", timeoutMs = 90_000 }) {
  const layout = gridPage(durationMs, options);
  const font = await access(FONT).then(() => FONT, () => null);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(layout.startS), "-i", path,
    "-t", String(layout.frames / options.fps), "-an", "-vf", filter(options, layout, font),
    "-frames:v", "1", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
  const jpeg = await runFfmpeg(ffmpeg, args, { timeoutMs, what: "the sheet" });
  return { jpeg, layout };
}

/**
 * Runs ffmpeg and returns its stdout. input (a Buffer) goes to stdin.
 * A missing ffmpeg gets a 503 ffmpeg_missing; an image over 8 MB gets a 413.
 */
export function runFfmpeg(ffmpeg, args, { input, timeoutMs = 90_000, what = "the image" } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(ffmpeg, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }); } catch (error) { return reject(error); }
    const chunks = []; let bytes = 0; let stderr = ""; let failed = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JPEG_BYTES) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { if (stderr.length < 2000) stderr += chunk; });
    if (input) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    child.on("error", error => { failed = true; clearTimeout(timer); reject(error.code === "ENOENT"
      ? new GridError(503, "ffmpeg_missing", "ffmpeg is not installed in this codespace. Restart the phone so setup installs it.") : error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed) return;
      if (bytes > MAX_JPEG_BYTES) return reject(new GridError(413, "image_too_large", `${what} is larger than 8 MB. Use smaller values.`));
      if (code !== 0 || !bytes) return reject(new GridError(500, "ffmpeg_failed", `ffmpeg could not make ${what}: ${stderr.trim().slice(0, 200) || `exit ${code}`}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Reads ?scale= for a screenshot: 0.1 to 1. Null means full size. */
export function screenshotScale(params) {
  const raw = params.get("scale");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.1 || value > 1) throw new GridError(400, "invalid_input", "scale must be a number from 0.1 to 1.");
  return value === 1 ? null : value;
}

/** Makes a PNG smaller. scale 0.5 gives half the width and height, so about a quarter of the image tokens. */
export function scalePng(png, scale, { ffmpeg = "ffmpeg" } = {}) {
  return runFfmpeg(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "png_pipe", "-i", "pipe:0",
    "-vf", `scale=trunc(iw*${scale}/2)*2:-2:flags=area`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
  { input: png, timeoutMs: 20_000, what: "the screenshot" });
}
