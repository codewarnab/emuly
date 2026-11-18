import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DEVICE_PRESETS, deviceEnv, devicePreset } from "./device-presets.ts";

test("device presets have unique shell-safe ids and give boot.sh plain values", () => {
  assert.equal(new Set(DEVICE_PRESETS.map(p => p.id)).size, DEVICE_PRESETS.length);
  for (const preset of DEVICE_PRESETS) assert.match(preset.id, /^[a-z0-9_]+$/);
  assert.equal(devicePreset("galaxy_s23"), undefined);
  assert.equal(deviceEnv("generic"), "EMULY_PRESET=generic\nEMULY_DEVICE=\nEMULY_LCD_WIDTH=720\nEMULY_LCD_HEIGHT=1440\nEMULY_LCD_DENSITY=320\n");
  assert.match(deviceEnv("pixel_tablet"), /EMULY_DEVICE=pixel_tablet\nEMULY_LCD_WIDTH=2560\nEMULY_LCD_HEIGHT=1600\nEMULY_LCD_DENSITY=320/);
  // An unknown id falls back to generic, so nothing outside the list reaches the shell.
  assert.match(deviceEnv("x; rm -rf /"), /^EMULY_PRESET=generic\n/);
});

// The preset part of boot.sh, run on a fake config.ini. avdmanager writes 320x640 with no preset.
test("boot.sh sets a real screen for every phone, also without device.env", t => {
  const boot = readFileSync(new URL("../../phone/scripts/boot.sh", import.meta.url), "utf8");
  const block = boot.slice(boot.indexOf('DEVICE_ENV="$HOME/emuly/device.env"'), boot.indexOf("# 2 guest cores"));
  const home = mkdtempSync(join(tmpdir(), "emuly-boot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = join(home, "config.ini");
  const boot1 = (env: string | null, config: string) => {
    writeFileSync(cfg, config);
    rmSync(join(home, "emuly"), { recursive: true, force: true });
    if (env !== null) { mkdirSync(join(home, "emuly")); writeFileSync(join(home, "emuly", "device.env"), env); }
    const posix = home.replaceAll("\\", "/");
    execFileSync("bash", ["-c", `set -euo pipefail; HOME="$1"; avd_dir="$1"; ${block}`, "_", posix]);
    return Object.fromEntries(readFileSync(cfg, "utf8").trim().split("\n").map(line => line.split("=")));
  };
  const avdmanager = "hw.lcd.width=320\nhw.lcd.height=640\nhw.lcd.density=160\n";
  const oldGeneric = "EMULY_PRESET=generic\nEMULY_DEVICE=\nEMULY_LCD_WIDTH=\nEMULY_LCD_HEIGHT=\nEMULY_LCD_DENSITY=\n";
  for (const env of [null, oldGeneric, deviceEnv("generic")]) {
    assert.deepEqual(boot1(env, avdmanager), { "hw.lcd.width": "720", "hw.lcd.height": "1440", "hw.lcd.density": "320" });
  }
  const pixel = boot1(deviceEnv("pixel_9"), avdmanager);
  assert.deepEqual([pixel["hw.lcd.width"], pixel["hw.device.name"]], ["1080", "pixel_9"]);
  // Back to generic: the old device id goes.
  assert.equal(boot1(deviceEnv("generic"), readFileSync(cfg, "utf8"))["hw.device.name"], undefined);
});
