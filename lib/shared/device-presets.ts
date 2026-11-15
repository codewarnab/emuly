/**
 * Screen presets for a new phone. Every preset uses the same Android 16 image; only the
 * screen changes. phone/scripts/boot.sh writes these values into the AVD config.ini before boot.
 * "generic" leaves the AVD as setup.sh made it.
 */
export type DevicePreset = {
  id: string;
  label: string;
  /** avdmanager device id, written as hw.device.name. */
  device: string | null;
  width: number | null;
  height: number | null;
  density: number | null;
};

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: "generic", label: "Generic phone", device: null, width: null, height: null, density: null },
  { id: "pixel_9", label: "Pixel 9", device: "pixel_9", width: 1080, height: 2424, density: 420 },
  { id: "pixel_9_pro", label: "Pixel 9 Pro", device: "pixel_9_pro", width: 1280, height: 2856, density: 495 },
  { id: "small_phone", label: "Small phone", device: "small_phone", width: 720, height: 1280, density: 320 },
  { id: "galaxy_size", label: "Galaxy-size screen", device: null, width: 1080, height: 2340, density: 425 },
  { id: "pixel_tablet", label: "Tablet", device: "pixel_tablet", width: 2560, height: 1600, density: 320 },
];

export const DEFAULT_DEVICE_PRESET = "generic";

export function devicePreset(id: unknown): DevicePreset | undefined {
  return DEVICE_PRESETS.find(preset => preset.id === id);
}

/** Shell lines for $HOME/emuly/device.env. Values come only from the fixed list above. */
export function deviceEnv(id: string): string {
  const preset = devicePreset(id) ?? devicePreset(DEFAULT_DEVICE_PRESET)!;
  return [
    `EMULY_PRESET=${preset.id}`,
    `EMULY_DEVICE=${preset.device ?? ""}`,
    `EMULY_LCD_WIDTH=${preset.width ?? ""}`,
    `EMULY_LCD_HEIGHT=${preset.height ?? ""}`,
    `EMULY_LCD_DENSITY=${preset.density ?? ""}`,
    "",
  ].join("\n");
}
