import { test } from "node:test";
import assert from "node:assert/strict";
import { skillUpdate } from "./skill-update.ts";
import { skillFile, skillVersion } from "./agent-runbook.ts";

const base = "https://emuly.test/";
const listWith = (header?: string) => new Request("https://emuly.test/v1/phones", { headers: header ? { "X-Emuly-Skill": header } : {} });

test("a current skill gets no hint; an old, missing or bad version gets the update commands", () => {
  const latest = skillVersion();
  assert.equal(skillUpdate(listWith(latest), latest, base, "emuly-playbook"), null);

  const old = skillUpdate(listWith("000000000000"), latest, base, "emuly-playbook")!;
  assert.equal(old.installed, "000000000000");
  assert.equal(old.latest, latest);
  assert.equal(old.with_node, "npx skills add https://emuly.test -g -a <your agent id> -y");
  assert.match(old.without_node, /https:\/\/emuly\.test\/\.well-known\/skills\/index\.json/);
  assert.match(old.message, /once in this chat/);

  assert.equal(skillUpdate(listWith(), latest, base, "emuly-playbook")!.installed, null);
  assert.equal(skillUpdate(listWith("x; rm -rf /"), latest, base, "emuly-playbook")!.installed, null);
  assert.equal(skillUpdate(undefined, latest, base, "emuly-playbook")!.installed, null);
});

test("the served skill names its own version, so the agent sends the version it has", () => {
  assert.match(skillVersion(), /^[0-9a-f]{12}$/);
  assert.equal(skillVersion(), skillVersion(), "stable");
  assert.ok(skillFile("SKILL.md", base)!.includes(`X-Emuly-Skill: ${skillVersion()}`));
  assert.ok(skillFile("references/machine/linux.md", base)!.includes(`X-Emuly-Skill: ${skillVersion()}`));
});
