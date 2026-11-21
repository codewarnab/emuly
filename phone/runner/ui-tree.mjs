// GET /ui: the screen's UI tree as short JSON, from `uiautomator dump`.
//
// The first dump after a screen change often fails with "null root node": the window is not
// ready yet (an animation or an app start). dumpUi() retries a few times with short waits, so
// the agent gets a tree in one call, or one clear error with a hint.
//
// parseUi() keeps only nodes an agent can use (text, a description, an id, or an action such as
// clickable), with the tap point at the centre of each node. ?all=1 keeps every node.

export const UI_TRY_DELAYS_MS = [300, 700, 1200];
// The phone link gives the runner 20 s. Stop retrying before that.
export const UI_BUDGET_MS = 14_000;
const DUMP_TIMEOUT_MS = 8_000;

export class UiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) => {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[name] ?? whole;
});

function attributes(tag) {
  const result = {};
  for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) result[name] = decode(value);
  return result;
}

const FLAGS = [["clickable", "clickable"], ["long-clickable", "long_clickable"], ["scrollable", "scrollable"],
  ["checkable", "checkable"], ["checked", "checked"], ["selected", "selected"], ["focused", "focused"], ["password", "password"]];

/**
 * @param {string} xml the output of `uiautomator dump`
 * @param {{ all?: boolean }} options
 */
export function parseUi(xml, { all = false } = {}) {
  const start = xml.indexOf("<hierarchy");
  if (start < 0) return null;
  const rotation = Number(attributes(xml.slice(start, xml.indexOf(">", start)))?.rotation ?? 0);
  const nodes = [];
  let packageName = null;
  for (const [tag] of xml.slice(start).matchAll(/<node\b[^>]*>/g)) {
    const a = attributes(tag);
    const box = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(a.bounds ?? "");
    if (!box) continue;
    const bounds = box.slice(1).map(Number);
    packageName ??= a.package || null;
    const flags = FLAGS.filter(([name]) => a[name] === "true").map(([, flag]) => flag);
    if (a.enabled === "false") flags.push("disabled");
    const visible = bounds[2] > bounds[0] && bounds[3] > bounds[1];
    const useful = a.text || a["content-desc"] || a["resource-id"] || flags.some(flag => flag !== "disabled");
    if (!all && (!visible || !useful)) continue;
    nodes.push({
      ...(a.text ? { text: a.text } : {}),
      ...(a["content-desc"] ? { desc: a["content-desc"] } : {}),
      ...(a["resource-id"] ? { id: a["resource-id"] } : {}),
      class: (a.class ?? "").replace(/^android\.(widget|view)\./, ""),
      bounds,
      tap: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
      ...(flags.length ? { flags } : {}),
    });
  }
  return { package: packageName, rotation, count: nodes.length, nodes };
}

/**
 * Dump and parse with retries. adb(args, { timeout }) resolves to stdout or rejects with
 * { stdout, stderr }. One dump at a time: two uiautomator processes break each other.
 */
export function createUiReader({ adb, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  delays = UI_TRY_DELAYS_MS, budgetMs = UI_BUDGET_MS }) {
  let queue = Promise.resolve();

  async function attempt() {
    try { return String(await adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { timeout: DUMP_TIMEOUT_MS })); }
    catch (error) { return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.killed ? "timed out" : ""}`; }
  }

  async function read({ all = false } = {}) {
    const started = now();
    let last = "", tries = 0;
    for (;;) {
      tries++;
      last = await attempt();
      const tree = parseUi(last, { all });
      if (tree) return { ...tree, tries, ms: now() - started };
      const delay = delays[tries - 1];
      if (delay === undefined || now() - started + delay > budgetMs) break;
      await sleep(delay);
    }
    const reason = /null root node/i.test(last) ? "uiautomator found no window (null root node)"
      : /already registered|UiAutomationService/i.test(last) ? "another tool holds UiAutomation"
      : /timed out/.test(last) ? "uiautomator timed out" : "uiautomator returned no UI tree";
    console.log(`[ui] failed tries=${tries} reason=${reason.replace(/\s+/g, "_")}`);
    throw new UiError(503, "ui_unavailable", `${reason} after ${tries} tries. The screen may still be changing ` +
      "(an animation, an app start or a dialog). Wait 1 s and retry. If agent-device or another UiAutomation tool runs, " +
      "stop it first. GET /screenshot works in every case.");
  }

  return { read: options => { const run = queue.then(() => read(options)); queue = run.catch(() => {}); return run; } };
}
