/** Public text for /compare and /compare.md. One source, so the page and the Markdown never differ.
    Competitor numbers come from their own pricing or help pages. Check them again before you change CHECKED. */

import { REPO_URL } from "./site-content";

export const COMPARE_CHECKED = "November 2026";
export const COMPARE_TITLE = "Free Android emulators online, compared";
export const COMPARE_DESCRIPTION =
  "How much free Android emulator time you get in the cloud from Emuly, Revyl, Limrun, Appetize, BrowserStack, Genymotion Cloud, TestingBot and Browserling, with no install.";

/** minutes: free minutes you can use in one month, for the bar chart. repeats: the free time comes back every month. */
export type Row = { name: string; minutes: number; free: string; repeats: boolean; limit: string; agent: boolean; best: string };

export const ROWS: Row[] = [
  { name: "Emuly", minutes: 1800, free: "~30 h / month", repeats: true, limit: "None", agent: true, best: "Long sessions and AI agent testing" },
  { name: "Revyl", minutes: 1200, free: "1,200 min / month", repeats: true, limit: "2 devices at once", agent: true, best: "AI test runs on iOS and Android" },
  { name: "Limrun", minutes: 120, free: "120 min", repeats: false, limit: "One-time trial credits", agent: true, best: "Fast-start iOS and Android for agents" },
  { name: "TestingBot", minutes: 100, free: "100 min", repeats: false, limit: "One-time trial", agent: false, best: "Web and app testing in one account" },
  { name: "Genymotion Cloud", minutes: 60, free: "60 min", repeats: false, limit: "Trial on request", agent: false, best: "Many device profiles" },
  { name: "Appetize", minutes: 30, free: "30 min / month", repeats: true, limit: "3-min sessions", agent: false, best: "Short demos embedded in a web page" },
  { name: "BrowserStack App Live", minutes: 30, free: "30 min", repeats: false, limit: "One-time trial", agent: false, best: "Real phones from many brands" },
  { name: "Browserling", minutes: 3, free: "3 min", repeats: false, limit: "Websites only", agent: false, best: "A quick look at a website" },
];

/** them: the free offer in a few words. theyWin: what the other service does better. emulyWins: why to pick Emuly. */
export type Vs = { name: string; them: string; theyWin: string; emulyWins: string };

export const VERSUS: Vs[] = [
  { name: "Revyl", them: "1,200 min a month, 2 devices at once", theyWin: "Runs iOS too, with AI test runs and reports built in.", emulyWins: "About 1.5x more free time, no device limit beyond your GitHub plan, and open source." },
  { name: "Appetize", them: "30 min a month, 3-min sessions", theyWin: "Runs iOS too. Good for short demos embedded on a website.", emulyWins: "About 30 hours a month with no session limit, and an API that agents can drive." },
  { name: "BrowserStack", them: "30-min one-time trial, then paid", theyWin: "Real phones from many brands, for tests on real hardware.", emulyWins: "Free every month. Good for daily development and agent testing." },
  { name: "Genymotion Cloud", them: "60-min trial on request, then per minute", theyWin: "Many Android versions and device profiles.", emulyWins: "Free every month, open source, and ready for coding agents." },
];

export type Faq = { q: string; a: string };

export const COMPARE_FAQS: Faq[] = [
  { q: "What is the best free Android emulator in the cloud?", a: "For long free use, Emuly. It runs in your own GitHub Codespace, so you get about 30 hours a month on GitHub Free and about 45 hours on GitHub Pro, with no card. Revyl comes next with 1,200 minutes a month. Most other cloud emulators give a one-time trial or a few minutes a month." },
  { q: "Can I run an Android emulator in my browser for free?", a: "Yes. Emuly streams an Android 16 emulator to your browser tab. You sign in with GitHub, and the phone runs in your own codespace. Nothing installs on your computer." },
  { q: "Is there a free alternative to BrowserStack for Android?", a: "Yes. Emuly is free and open source (MIT). It runs Android emulators, not real phones. If you need real hardware, BrowserStack is still the better choice." },
  { q: "How does Emuly compare to Revyl?", a: "Revyl gives 1,200 free device minutes a month, 2 devices at once, and supports iOS. Emuly gives about 1,800 minutes (30 hours) a month on GitHub Free, Android only, and is open source." },
  { q: "Is there a free alternative to Appetize?", a: "Yes. Emuly has no session limit and gives about 30 hours a month on GitHub Free. Appetize gives 30 minutes a month with 3-minute sessions, but it also supports iOS." },
  { q: "Can I run Android apps on a low-RAM laptop or a Chromebook?", a: "Yes. With Emuly, the emulator runs on a 4-core cloud machine, not on your computer. Your browser only shows the screen. You can install your own APK." },
  { q: "Can an AI coding agent test my Android app on a cloud emulator?", a: "Yes. Emuly has an HTTP API, a CLI and a skill for coding agents such as Claude Code, Codex, Cursor and GitHub Copilot. The agent can start a phone, install an APK, tap, type, take screenshots and stop the phone." },
  { q: "Why is Emuly free?", a: "Emuly does not host the phone. The phone runs in a codespace on your GitHub account, on the Codespaces hours your GitHub plan includes. Emuly never bills you. If you use up the hours, GitHub stops the codespace until next month." },
];

const trim = (base: string) => base.replace(/\/$/, "");

/** GET /compare.md, or GET /compare with Accept: text/markdown. */
export function compareMarkdown(base: string) {
  const b = trim(base);
  const table = [
    "| Service | Free time | Every month? | Limit | Agent API | Good for |",
    "|---|---|---|---|---|---|",
    ...ROWS.map(r => `| ${r.name} | ${r.free} | ${r.repeats ? "Yes" : "No"} | ${r.limit} | ${r.agent ? "Yes" : "No"} | ${r.best} |`),
  ].join("\n");
  return `# ${COMPARE_TITLE}

${COMPARE_DESCRIPTION}

Checked ${COMPARE_CHECKED}. Free tiers change, so check each service's pricing page.

${table}

Emuly is free because the phone runs in your own GitHub Codespace: about 30 hours a month on GitHub Free and about 45 hours on GitHub Pro.

${VERSUS.map(v => `## Emuly vs ${v.name}\n\n- ${v.name} free tier: ${v.them}\n- ${v.name} is better at: ${v.theyWin}\n- Pick Emuly for: ${v.emulyWins}`).join("\n\n")}

## Questions

${COMPARE_FAQS.map(f => `### ${f.q}\n\n${f.a}`).join("\n\n")}

## Links

- Start a free phone: ${b}
- Home: ${b}/index.md
- Source code: ${REPO_URL}
`;
}

export function compareJsonLd(base = "https://emuly.xyz") {
  const b = trim(base);
  return [
    { "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: COMPARE_FAQS.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Emuly", item: b },
      { "@type": "ListItem", position: 2, name: "Compare", item: `${b}/compare` } ] },
    { "@context": "https://schema.org", "@type": "ItemList", name: COMPARE_TITLE,
      itemListElement: ROWS.map((r, i) => ({ "@type": "ListItem", position: i + 1, name: `${r.name}: ${r.free} free` })) },
  ];
}
