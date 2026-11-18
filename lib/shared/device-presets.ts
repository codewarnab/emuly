/**
 * Screen presets for a new phone. Every preset uses the same Android 16 image; only the
 * screen changes. phone/scripts/boot.sh writes these values into the AVD config.ini before boot.
 * Every preset sets a size. avdmanager makes a 320x640 160 dpi AVD, too small to use, and a
 * phone moved from another preset back to "generic" must not keep that preset's screen.
 */
export type DevicePreset = {
  id: string;
  label: string;
  /** Short name for the segmented control in the New phone dialog. */
  short: string;
  /** avdmanager device id, written as hw.device.name. */
  device: string | null;
  width: number | null;
  height: number | null;
  density: number | null;
};

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  // 720x1440 keeps the 1:2 shape that the UI drew for this preset. It has 2.25x fewer pixels
  // than Pixel 9, so SwiftShader and the encoder stay light on a 2-core codespace.
  { id: "generic", label: "Generic phone", short: "Generic", device: null, width: 720, height: 1440, density: 320 },
  { id: "pixel_9", label: "Pixel 9", short: "Pixel 9", device: "pixel_9", width: 1080, height: 2424, density: 420 },
  { id: "pixel_9_pro", label: "Pixel 9 Pro", short: "Pixel 9 Pro", device: "pixel_9_pro", width: 1280, height: 2856, density: 495 },
  { id: "small_phone", label: "Small phone", short: "Small", device: "small_phone", width: 720, height: 1280, density: 320 },
  { id: "galaxy_size", label: "Galaxy-size screen", short: "Galaxy", device: null, width: 1080, height: 2340, density: 425 },
  { id: "pixel_tablet", label: "Tablet", short: "Tablet", device: "pixel_tablet", width: 2560, height: 1600, density: 320 },
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

/** True when the preset screen is wider than tall (the tablet). */
export function isWide(id: unknown): boolean {
  const preset = devicePreset(id);
  return !!preset?.width && !!preset.height && preset.width > preset.height;
}

/** Screen width / height for the preset; 0.5 for an unknown id. */
export function screenAspect(id: unknown): number {
  const preset = devicePreset(id);
  return preset?.width && preset.height ? preset.width / preset.height : 0.5;
}
