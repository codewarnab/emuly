import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_PRESETS, deviceEnv, devicePreset } from "./device-presets.ts";

test("device presets have unique shell-safe ids and give boot.sh plain values", () => {
  assert.equal(new Set(DEVICE_PRESETS.map(p => p.id)).size, DEVICE_PRESETS.length);
  for (const preset of DEVICE_PRESETS) assert.match(preset.id, /^[a-z0-9_]+$/);
  assert.equal(devicePreset("galaxy_s23"), undefined);
  assert.equal(deviceEnv("generic"), "EMULY_PRESET=generic\nEMULY_DEVICE=\nEMULY_LCD_WIDTH=\nEMULY_LCD_HEIGHT=\nEMULY_LCD_DENSITY=\n");
  assert.match(deviceEnv("pixel_tablet"), /EMULY_DEVICE=pixel_tablet\nEMULY_LCD_WIDTH=2560\nEMULY_LCD_HEIGHT=1600\nEMULY_LCD_DENSITY=320/);
  // An unknown id falls back to generic, so nothing outside the list reaches the shell.
  assert.match(deviceEnv("x; rm -rf /"), /^EMULY_PRESET=generic\n/);
});
