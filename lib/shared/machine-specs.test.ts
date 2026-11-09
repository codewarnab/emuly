import { test } from "node:test";
import assert from "node:assert/strict";
import { machineRows, machineSpecs } from "./machine-specs.ts";

test("reads RAM from cores and disk from the machine name", () => {
  assert.deepEqual(machineSpecs("standardLinux32gb", 4), { cores: 4, ramGb: 16, diskGb: 32 });
  assert.deepEqual(machineSpecs("premiumLinux64gb", 8), { cores: 8, ramGb: 32, diskGb: 64 });
});

test("falls back when cores or disk are unknown", () => {
  assert.deepEqual(machineSpecs("basicLinux32gb", null), { cores: 2, ramGb: 8, diskGb: 32 });
  assert.deepEqual(machineRows("custom", 4)[2], ["Disk", "Unknown"]);
});
