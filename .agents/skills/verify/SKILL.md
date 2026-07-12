---
name: verify
description: Build, launch, and drive pagebin locally to verify worker or CLI changes end-to-end.
---

# Verifying pagebin changes

## Launch the worker locally

```sh
bunx wrangler dev --port 8790 --var PAGEBIN_PUBLISH_TOKEN:test-publish-token
```

Runs in miniflare with a local R2 bucket — no cloud state touched. Wait for
`http://localhost:8790/robots.txt` to return 200.

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

`AGENT_BROWSER_EXECUTABLE_PATH` in the environment may point at a stale
helium path — override it:

```sh
export AGENT_BROWSER_EXECUTABLE_PATH=$(which google-chrome-stable)
agent-browser open "<viewer url>" --session pagebin-verify
```

Measure the auto-reload poll cadence from inside the page (the viewer polls
`/api/artifacts/<id>/version/<token>`):

```sh
agent-browser --session pagebin-verify eval "(() => {
  const polls = performance.getEntriesByType('resource').filter(e => e.name.includes('/version/'));
  const times = polls.map(p => Math.round(p.startTime));
  return JSON.stringify({count: polls.length, gaps: times.map((t,i) => i ? t - times[i-1] : t)});
})()"
```

Expected polling behavior: 2s initial delay, ×1.5 backoff per unchanged poll
up to 60s; reset to 2s on detected update or tab becoming visible; zero polls
while `document.hidden`. Background the tab with `tab new about:blank`,
foreground with `tab t1` (headless Chrome propagates visibilitychange on tab
switch). After a PUT, the iframe src gains `?v=<updatedAt>`.

## Gotchas

- The viewer iframe is sandboxed; `contentDocument` is inaccessible — verify
  reload via the iframe `src` attribute and a screenshot, not DOM access.
- `bun run typecheck` covers both tsconfigs; editor LSP diagnostics against
  `worker/index.ts` are noise (LSP doesn't load `@cloudflare/workers-types`).
