// Turns long GitHub and setup errors into one short line that people read.
const KNOWN: [RegExp, string][] = [
  [/OAuth App access restrictions/i, "GitHub blocked access to the template repository."],
  [/not found|404/i, "GitHub could not find the template repository. Ask for collaborator access."],
  [/spending limit|billing|quota/i, "Your Codespaces hours or spending limit ran out."],
  [/rate limit/i, "GitHub is busy. Try again in a minute."],
  [/timed out/i, "The codespace did not answer in time. Try again."],
];

export function shortMessage(message: string) {
  for (const [pattern, text] of KNOWN) if (pattern.test(message)) return text;
  const first = message.split(/(?<=\.)\s/)[0].trim();
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}
