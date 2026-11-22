/** Public text for the landing page, its Markdown copy, llms.txt and the JSON-LD.
    One source, so the HTML page and the Markdown that AI agents read never differ. */

export const SITE_NAME = "Emuly";
export const SITE_TITLE = "Emuly — a free Android emulator in the cloud";
export const SITE_DESCRIPTION =
  "Run an Android emulator in the cloud, for free. Use the Codespaces hours included in your GitHub plan. Paste one prompt into your coding agent.";
export const REPO_URL = "https://github.com/codewarnab/emuly";

export type Faq = { q: string; a: string; link?: { href: string; text: string } };

export const FAQS: Faq[] = [
  { q: "How do I run an Android emulator in the cloud for free?", a: "Copy the Emuly prompt and paste it into your coding agent, such as Claude Code, Codex or Cursor. The agent asks you to sign in to GitHub once. Then it starts an Android emulator in your own GitHub Codespace, on the free hours your GitHub plan includes." },
  { q: "Is it really free?", a: "Yes. You bring the compute through the Codespaces hours included in your GitHub plan. Emuly never bills you or resells GitHub. Stay within your included hours to avoid GitHub charges." },
  { q: "Can AI agents control the phone?", a: "Yes. Emuly has an HTTP API and an agent playbook. An agent can take screenshots, read the UI tree, tap, type, install APKs and record the screen. It also works with adb and scrcpy." },
  { q: "What does it need from GitHub?", a: "One permission: Codespaces. No repo access. Your agent asks you to sign in when it needs approval." },
  { q: "What happens when I stop it?", a: "Your codespace keeps the phone. Waking it boots Android fresh, which takes a few minutes. Only deleting the codespace erases it. GitHub deletes a stopped phone after its retention period. New phones get 30 days after the last stop. The console shows each phone's countdown." },
  { q: "Is it fast?", a: "Yes. Android runs with hardware acceleration (KVM) on the codespace machine. It is not slow software emulation, so apps open and respond quickly." },
  { q: "Limits?", a: "Running phones share your hours. GitHub decides how many codespaces you can have and run. GitHub stops an idle phone after 30 minutes or 4 hours, your choice. Cold boot takes about 2 minutes. Hours shown in the console are estimates." },
  { q: "How does it compare to BrowserStack, Appetize or Genymotion?", a: "Those services give a one-time trial or a few free minutes a month. Emuly gives about 30 hours a month on GitHub Free, because it uses your own Codespaces hours. They do more in other areas, such as real phones or iOS.", link: { href: "/compare", text: "See the full comparison" } },
  { q: "Can I host it myself?", a: "Yes. One Docker container runs the whole app on your machine, with your own GitHub account. Your agent does the setup from one prompt. You only sign in to GitHub.", link: { href: "/self-host", text: "See how self-hosting works" } },
];

const trim = (base: string) => base.replace(/\/$/, "");
const faqMarkdown = (base: string) =>
  FAQS.map(f => `### ${f.q}\n\n${f.a}${f.link ? ` [${f.link.text}](${trim(base)}${f.link.href}.md).` : ""}`).join("\n\n");

/** The landing page as Markdown: GET /index.md, or GET / with Accept: text/markdown. */
export function homeMarkdown(base: string) {
  const b = trim(base);
  return `# Run an Android emulator in the cloud. Free.

${SITE_DESCRIPTION}

Emuly runs a real Android emulator in your own GitHub Codespace, with KVM hardware acceleration. It uses the hours your GitHub plan already includes, so there is nothing to pay. Use the phone in the browser, with adb and scrcpy, or let an AI coding agent drive it over the HTTP API.

## Get started

Paste the setup prompt into any coding agent: ${b}/agent.md

Or install the agent skill: \`npx skills add ${b}\`

Works with Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Windsurf, Cline, Roo Code, OpenCode, Devin, Zed, Kiro and other agents.

## The essentials

- **Free**: uses your Codespaces hours. No card.
- **Safe to stop**: only deleting it erases the phone.
- **Your way**: use it in the browser, or with adb and scrcpy.

## Questions

${faqMarkdown(b)}

## Links

- Self-host: ${b}/self-host.md
- Compare free cloud Android emulators: ${b}/compare.md
- Source code: ${REPO_URL}
`;
}

export function selfHostMarkdown(base: string, setupPrompt: string) {
  return `# Self-host Emuly

Run Emuly on your own machine. Your coding agent does the setup. You sign in.

1. You: paste the prompt below into your coding agent.
2. Agent: runs the Docker container.
3. You: sign in to GitHub.
4. Agent: phones are ready.

## Setup prompt

\`\`\`text
${setupPrompt}
\`\`\`

Manual guide: ${REPO_URL}/blob/main/docs/SELF-HOST.md

Back to home: ${trim(base)}/index.md
`;
}

/** GET /llms.txt, in the llmstxt.org format. */
export function llmsTxt(base: string, skillUrl: string) {
  const b = trim(base);
  return `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

Emuly gives you and your AI agents a free Android emulator in the cloud. Each phone runs in the user's own GitHub Codespace with KVM acceleration. Agents control it over an HTTP API: screenshots, UI tree, taps, text, APK installs, adb and screen recording.

## Docs

- [Home](${b}/index.md): what Emuly is, and common questions
- [Agent setup prompt](${b}/agent.md): paste this into a coding agent to get a phone
- [Agent playbook](${skillUrl}): how an agent starts, drives and stops phones over the API
- [Self-host](${b}/self-host.md): run Emuly on your own machine with Docker
- [Free Android emulators online, compared](${b}/compare.md): Emuly vs Appetize, BrowserStack, Genymotion Cloud and others

## Optional

- [Full docs in one file](${b}/llms-full.txt)
- [Source code](${REPO_URL})
`;
}

export function jsonLd(base: string) {
  const b = trim(base);
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      url: b,
      description: SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, Android",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      sameAs: [REPO_URL],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQS.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
}
