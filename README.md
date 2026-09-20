# pi-codex-statusline

A minimal, one-line footer for [Pi](https://pi.dev), adapting my [Claude Code status line](https://github.com/K-Planky/claude-code-statusline) for ChatGPT Codex subscription usage.

```text
GPT-5.4 High · ctx 34% · 5h 28% (2h14m) · 7d 61% (4d9h)
```

Text only, with no spinner or idle usage polling. Context and quota values light up only when they need attention.

## What it shows

- active model and reasoning level
- context window usage
- ChatGPT's 5-hour and 7-day Codex usage windows with reset countdowns
- statuses published by other Pi extensions, when space permits

The line adapts to narrow terminals by removing countdowns and lower-priority fields. It always stays within the terminal width.

## Install

```sh
pi install git:github.com/K-Planky/pi-codex-statusline
```

For local development:

```sh
pi -e ./index.ts
```

Then use `/login` in Pi and authenticate the **OpenAI Codex** provider. Quota segments appear only while an `openai-codex` model is active.

## Refresh behavior

Run `/usage` to manually refresh the footer's Codex usage. It adds nothing to the conversation or model context, starts no agent run, and shows no messages or notifications—even on failure. It quietly does nothing outside a TUI session or when a non-Codex model is active.

Usage is loaded when a TUI session starts with a Codex model and after each agent run fully settles. While the agent is working with a Codex model, usage is also refreshed every 60 seconds. Polling continues through automatic retries and queued follow-ups, and stops when the agent fully settles, switches away from Codex, or the session shuts down.

While a reset countdown is active, a lightweight one-shot timer redraws the footer whenever its remaining minute changes. Each tick is aligned to the window's reset deadline; it never makes a network request and stops when no valid future reset remains. Usage polling is independent of this display timer, so it works even without a visible countdown. Model and thinking-level changes also redraw without fetching usage.

## Design

- `ctx` warns at 75% and becomes critical at 85%.
- Codex windows warn at 75% and become critical at 90%.
- Expired quota windows display `0%` until the next API refresh.
- API failures are quiet. The last successful quota snapshot remains visible; without one, quota segments are omitted.

Colors come from the active Pi theme. Extension statuses retain ANSI colors/styles, but other terminal control sequences are removed. Model names are shortened by terminal columns without splitting emoji or combining characters.

## Privacy

The extension requests:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

It uses the OAuth token Pi already stores for the active `openai-codex` provider. By default, the token is sent only to ChatGPT and is never logged or persisted by this extension. Unrelated provider headers are not forwarded.

For local testing, `PI_CODEX_STATUSLINE_BASE_URL` can override the destination. The override receives your OAuth token: use HTTPS except for loopback testing, and never point it at an endpoint you do not trust. Redirects are rejected.

Refreshes have a 15-second deadline, including time spent waiting for Pi's credential resolver. Cancellation stops this extension waiting and prevents a late usage request; it cannot cancel Pi's underlying credential-resolution work.

## Development

Use Node.js 22.19+ and `npm ci`. The extension is checked against Pi 0.86.1.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

`index.ts` is the entry point for both local use and package installation. Pi loads
TypeScript directly; no build step or generated JavaScript is needed, including
when installing from Git with development dependencies omitted.

Source and tests use strict TypeScript, Pi's official API types, readonly usage
models, and runtime validation of untrusted JSON. `npm run check` checks both
source and tests, including indexed access and exact optional properties.
`npm test` runs the TypeScript regression tests via `tsx`. Shared typed fixtures
model the host APIs, and malformed-input cases remain explicit without weakening
the production types.

## Author

Built by [K-Planky](https://github.com/K-Planky), adapting the design from my original [claude-code-statusline](https://github.com/K-Planky/claude-code-statusline).

## License

MIT
