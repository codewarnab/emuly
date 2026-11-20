import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gridOptions, gridPage, makeGrid, scalePng, screenshotScale } from "../../phone/runner/grid.mjs";

const params = (query: string) => new URLSearchParams(query);

test("grid options use defaults and name the limits of a bad value", () => {
  assert.deepEqual(gridOptions(params("")), { fps: 2, cols: 6, width: 200, count: 36, page: 0 });
  assert.equal((gridOptions(params("fps=0.5&page=3")) as unknown as { fps: number }).fps, 0.5);
  assert.throws(() => gridOptions(params("fps=50")), /fps must be a number from 0.1 to 10/);
  assert.throws(() => gridOptions(params("cols=2.5")), /cols must be a whole number/);
  assert.throws(() => gridOptions(params("page=-1")), /page must be a whole number/);
});

test("a grid page covers its part of the recording and the last page is short", () => {
  // 25 s at 2 fps is 50 frames: page 0 has 36, page 1 has 14 from 18 s.
  const options = { fps: 2, cols: 6, count: 36, width: 200 };
  assert.deepEqual(gridPage(25_000, { ...options, page: 0 }), { startS: 0, frames: 36, pages: 2, cols: 6, rows: 6 });
  assert.deepEqual(gridPage(25_000, { ...options, page: 1 }), { startS: 18, frames: 14, pages: 2, cols: 6, rows: 3 });
  assert.throws(() => gridPage(25_000, { ...options, page: 2 }), (error: { code: string }) => error.code === "grid_page_out_of_range");
  // A 1-frame recording still gives one narrow sheet, not 6 empty columns.
  assert.deepEqual(gridPage(100, { ...options, page: 0 }), { startS: 0, frames: 1, pages: 1, cols: 1, rows: 1 });
});

test("screenshot scale accepts 0.1 to 1 and treats 1 as full size", () => {
  assert.equal(screenshotScale(params("")), null);
  assert.equal(screenshotScale(params("scale=1")), null);
  assert.equal(screenshotScale(params("scale=0.5")), 0.5);
  assert.throws(() => screenshotScale(params("scale=2")), /scale must be a number from 0.1 to 1/);
});

test("a missing ffmpeg gets ffmpeg_missing", async () => {
  await assert.rejects(scalePng(Buffer.from("x"), 0.5, { ffmpeg: "emuly-no-such-ffmpeg" }),
    (error: { code: string; status: number }) => error.code === "ffmpeg_missing" && error.status === 503);
});

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }

test("ffmpeg makes a JPEG sheet and a smaller PNG", { skip: !ffmpeg && "ffmpeg is not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "emuly-grid-"));
  try {
    const video = join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x640:rate=30:duration=3", "-pix_fmt", "yuv420p", video]);
    const { jpeg, layout } = await makeGrid({ path: video, durationMs: 3000, options: { fps: 2, cols: 3, width: 100, count: 36, page: 0 } });
    assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(layout.frames, 6);
    const png = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=400x800", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
    const small = await scalePng(png, 0.5);
    assert.equal(small.subarray(1, 4).toString(), "PNG");
    assert.equal(small.readUInt32BE(16), 200);
    assert.equal(small.readUInt32BE(20), 400);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
