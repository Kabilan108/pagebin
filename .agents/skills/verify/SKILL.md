---
name: verify
description: Build, launch, and drive pagebin locally to verify worker or CLI changes end-to-end.
---

# Verifying pagebin changes

## Launch the worker locally

```sh
bunx wrangler dev --config wrangler.dev.toml --port 8790 \
  --var PAGEBIN_PUBLISH_TOKEN:test-publish-token \
  --var PAGEBIN_PUBLIC_ORIGIN:http://127.0.0.1:8790
```

Runs in miniflare with a local R2 bucket — no cloud state touched. Wait for
`http://127.0.0.1:8790/robots.txt` to return 200. Do not use `wrangler.toml`
for local QA: its production custom domains can rewrite localhost requests and
produce misleading 421 responses.

## Drive the API

```sh
# publish (multipart, .html extension required)
curl -s -X POST http://localhost:8790/api/publish \
  -H "Authorization: Bearer test-publish-token" \
  -F "file=@page.html;type=text/html"
# → {"id": ..., "url": "http://localhost:8790/p/<id>/<token>", ...}

# update in place
curl -s -X PUT http://localhost:8790/api/artifacts/<id>/content \
  -H "Authorization: Bearer test-publish-token" \
  -F "file=@page.html;type=text/html"
```

## Drive the viewer (browser surface)

Use the `helium-browser-use` skill and create a labeled agent-owned tab. The
viewer URL is a capability secret; do not print it or include it in screenshots
of browser chrome. The current tab-list command and JSON shape are:

```sh
port="${HELIUM_AGENTS_CDP_PORT:-9222}"
agent-browser --cdp "$port" tab new --label pagebin-verify "<viewer url>"
agent-browser --cdp "$port" tab list --json
```

Measure the auto-reload poll cadence from inside the page (the viewer polls
`/api/artifacts/<id>/version/<token>`):

```sh
agent-browser --cdp "$port" eval "(() => {
  const polls = performance.getEntriesByType('resource').filter(e => e.name.includes('/version/'));
  const times = polls.map(p => Math.round(p.startTime));
  return JSON.stringify({count: polls.length, gaps: times.map((t,i) => i ? t - times[i-1] : t)});
})()"
```

Expected polling behavior: 2s initial delay, ×1.5 backoff per unchanged poll
up to 60s; reset to 2s on detected update or tab becoming visible; zero polls
while `document.hidden`. Background the tab with `tab new about:blank`,
foreground with the tracked tab ID. After a PUT, the iframe src gains
`?v=<updatedAt>`.

## Gotchas

- The viewer iframe is sandboxed; `contentDocument` is inaccessible — verify
  reload via the iframe `src` attribute and a screenshot, not DOM access.
- In restricted environments, agent-browser needs write access to its runtime
  socket under `/run/user/$UID/agent-browser`; a read-only error is a sandbox
  permission issue, not a Helium/CDP failure.
- `agent-browser tab list --json` returns tabs under `.data.tabs`. Do not chain
  tab creation with a guessed JSON parser: the mutation can succeed even if the
  parser fails, leaving an untracked agent-owned tab.
- CLI tests bind ephemeral localhost ports. If every `Bun.serve({ port: 0 })`
  test reports `EADDRINUSE`, rerun with local socket-binding permission.
- `bun run typecheck` covers both tsconfigs; editor LSP diagnostics against
  `worker/index.ts` are noise (LSP doesn't load `@cloudflare/workers-types`).
