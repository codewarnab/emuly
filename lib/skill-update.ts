/**
 * The skill update hint, for hosted and self-hosted Emuly.
 *
 * The emuly-playbook skill sends its version in the `X-Emuly-Skill` header on `GET /v1/phones`.
 * When the header is missing or differs from the skill this server serves, the list gets a
 * `skill_update` field with the update commands. After the update the header matches, and the
 * field goes away by itself. The skill handles the field once in each chat, so it does not repeat.
 * No state is stored: the header is the only input.
 */
export const SKILL_HEADER = "x-emuly-skill";

export type SkillUpdate = {
  installed: string | null;
  latest: string;
  message: string;
  with_node: string;
  without_node: string;
};

export function skillUpdate(request: Request | undefined, latest: string, baseUrl: string, skill: string): SkillUpdate | null {
  const raw = request?.headers.get(SKILL_HEADER)?.trim() ?? "";
  const installed = /^[0-9a-f]{12}$/.test(raw) ? raw : null;
  if (installed === latest) return null;
  const base = baseUrl.replace(/\/$/, "");
  return {
    installed,
    latest,
    message: `This server has a newer ${skill} skill. If you use an installed ${skill} skill, update it now, `
      + "once in this chat, without asking. Use the same way you installed it. Then read the new SKILL.md and continue. "
      + "Tell the user in one line. If you have no installed skill, ignore this.",
    with_node: `npx skills add ${base} -g -a <your agent id> -y`,
    without_node: `Read ${base}/.well-known/skills/index.json. Download each file in "files" from `
      + `${base}/.well-known/skills/${skill}/<file> into <your skills folder>/${skill}/. Keep the paths.`,
  };
}
