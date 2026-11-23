import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_DEVICE_VERSION } from "./agent-device-version.ts";
import { skillFile } from "./agent-runbook.ts";

const base = "https://emuly.example";

test("the served skill offers agent-device at the pinned version", () => {
  assert.ok(skillFile("SKILL.md", base)!.includes("references/tasks/agent-device.md"));
  const skill = skillFile("references/tasks/agent-device.md", base);
  assert.ok(skill, "the agent-device file is served");

  assert.ok(skill.includes("https://agent-device.dev/"));
  assert.ok(skill.includes(`npm install -g agent-device@${AGENT_DEVICE_VERSION}`));
  assert.ok(skill.includes(`pnpm add -g agent-device@${AGENT_DEVICE_VERSION}`));
  assert.ok(skill.includes(`bun add -g agent-device@${AGENT_DEVICE_VERSION}`));
  assert.doesNotMatch(skill, /agent-device@latest/);
});

test("every token in the served skill is replaced", () => {
  const skill = skillFile("SKILL.md", base);
  assert.ok(skill, "SKILL.md is served");
  assert.doesNotMatch(skill, /\{\{|\}\}/);
  assert.ok(skill.includes(base));
  const agentDevice = skillFile("references/tasks/agent-device.md", base)!;
  assert.doesNotMatch(agentDevice, /\{\{|\}\}/);
  assert.ok(agentDevice.includes(AGENT_DEVICE_VERSION));
});

test("an unlisted file is null, so a route can answer 404", () => {
  assert.equal(skillFile("references/missing.md", base), null);
  assert.equal(skillFile("../package.json", base), null);
});
