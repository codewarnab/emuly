<div align="center">

<img src="app/icon.svg" width="72" height="72" alt="Emuly" />

<h1>Emuly</h1>

<p><strong>Run an Android emulator in the cloud. Free.</strong></p>

<p>It runs in your own GitHub Codespace, on the hours your GitHub plan already includes.<br />Paste one prompt into your coding agent. It does the rest.</p>

<p>
  <a href="https://emuly.vercel.app">Website</a>
  &nbsp;·&nbsp;
  <a href="docs/SELF-HOST.md">Self-host</a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p><sub>WORKS WITH ANY CODING AGENT</sub></p>

<p>
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/claude-ai-icon.svg"><img src="public/agents/claude-ai-icon.svg" height="18" alt="Claude Code" title="Claude Code"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/openai_dark.svg"><img src="public/agents/openai.svg" height="18" alt="Codex" title="Codex"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/cursor_dark.svg"><img src="public/agents/cursor_light.svg" height="18" alt="Cursor" title="Cursor"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/t3-light.svg"><img src="public/agents/t3-dark.svg" height="18" alt="T3 Code" title="T3 Code"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/opencode-dark.svg"><img src="public/agents/opencode.svg" height="18" alt="OpenCode" title="OpenCode"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/copilot_dark.svg"><img src="public/agents/copilot.svg" height="18" alt="GitHub Copilot" title="GitHub Copilot"></picture>&nbsp;&nbsp;&nbsp;
<img src="public/agents/gemini.svg" height="18" alt="Gemini CLI" title="Gemini CLI">&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/windsurf-dark.svg"><img src="public/agents/windsurf-light.svg" height="18" alt="Windsurf" title="Windsurf"></picture>&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/cline-dark.svg"><img src="public/agents/cline.svg" height="18" alt="Cline" title="Cline"></picture>&nbsp;&nbsp;&nbsp;
<img src="public/agents/amp.svg" height="18" alt="Amp" title="Amp">&nbsp;&nbsp;&nbsp;
<img src="public/agents/devin.svg" height="18" alt="Devin" title="Devin">&nbsp;&nbsp;&nbsp;
<picture><source media="(prefers-color-scheme: dark)" srcset="public/agents/zed-logo_dark.svg"><img src="public/agents/zed-logo.svg" height="18" alt="Zed" title="Zed"></picture>
</p>

</div>

<table>
  <tr>
    <td width="33%" valign="top">
      <strong>Free</strong><br />
      <sub>Uses your Codespaces hours. About 30 h a month on GitHub Free, 45 h on Pro. No card.</sub>
    </td>
    <td width="33%" valign="top">
      <strong>Built for agents</strong><br />
      <sub>Your agent starts, drives and tests the phone. You only approve the sign-in.</sub>
    </td>
    <td width="33%" valign="top">
      <strong>Fast</strong><br />
      <sub>Hardware acceleration (KVM). Not slow software emulation.</sub>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>Safe to stop</strong><br />
      <sub>An idle phone stops and keeps its state. Only deleting it erases it.</sub>
    </td>
    <td valign="top">
      <strong>Your way</strong><br />
      <sub>Watch and touch it in the browser, or connect adb and scrcpy.</sub>
    </td>
    <td valign="top">
      <strong>Minimal access</strong><br />
      <sub>Asks GitHub for the <code>codespace</code> scope only. Never <code>repo</code>.</sub>
    </td>
  </tr>
</table>

## How it works

1. You sign in with GitHub.
2. Emuly creates a codespace on your account and boots Android in it.
3. Your agent, or your browser, controls the phone through the Emuly API.

Emuly never bills you and never resells GitHub access. Use one GitHub account per person.

## Self-host

One Docker container runs the whole app on your machine, with your own GitHub account.
See the [self-host guide](docs/SELF-HOST.md).

## Docs

[Self-host](docs/SELF-HOST.md) · [Webhooks](docs/WEBHOOKS.md) · [Billing and usage](docs/BILLING-USAGE.md) · [Contributing](CONTRIBUTING.md) · [Report a security issue](https://github.com/codewarnab/emuly/security/advisories/new)

<br />

<div align="center"><sub>MIT License · Your codespace, your phone.</sub></div>
