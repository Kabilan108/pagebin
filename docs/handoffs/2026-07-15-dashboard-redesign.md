# Handoff: dashboard redesign + markdown viewer retheme (0.9.0)

**Date:** 2026-07-15 · **Scope:** `worker/dashboard.ts` (new), `worker/index.ts`, `src/markdown-template.ts`, `wrangler.dev.toml`

## What shipped

### Dashboard (`/` on admin origin)

The card-grid dashboard was replaced with a flat editorial design after prototyping five candidates at `/1`–`/5` (dense table, sidebar, feed, editorial index, terminal console). The final design merges the editorial index (variant 4) with the console's monospace-adjacent metadata treatment (variant 5). The page now lives in `worker/dashboard.ts` as `dashboardHtml()`; the variant routes were removed.

Row anatomy, locked in through iteration:

- **Line 1:** serif title (click/tap opens the artifact) · relative age in muted gray · copy-link / reissue / delete icon buttons at the row's end, always visible (hover-only actions were rejected — dead on mobile).
- **Meta row 1:** status glyph (`● ✓ ◐ ○`, colored) · artifact type (color-coded: plan gold, report teal, review rose, explainer blue, implementation-log green) · branch icon + branch with the checkout folder name in faint parens.
- **Meta row 2:** laptop icon + source host · agent with brand icon · `expires <date>` only when an expiry exists.
- **Not shown by decision:** filename (title falls back to it when no title exists), repo URL, commit sha, size, revision.

Structure: sections grouped by **repository origin URL** (see decisions), capped at 5 rows with an "… N more" expander per section; a fixed outline rail in the left gutter on ≥1240px viewports and a round ☰ floating button on smaller screens. Filters are chip groups for status and host, each on its own line; search is a bottom-bordered input.

### Markdown viewer (`src/markdown-template.ts`)

Rethemed from neutral near-black to the dashboard's warm palette: bg `#191713`, cream text, serif title/h1–h4 (h5/h6 stay small-caps sans), accent `#7dd3fc` cyan → `#d39a62` amber throughout (callout blockquotes, footnote links, mermaid theme variables). Syntax-token colors unchanged. Side panels compacted (sidebar 320→250px, 12px text); frontmatter arrays of primitives render comma-separated (arrays of objects keep block layout); nested frontmatter sections use small-caps labels with a thin indent line instead of the bracket icon; the decorative per-field icons were dropped; the mobile outline trigger is the same round ☰ as the dashboard. **Still dark-only** — a light scheme is a known follow-up if wanted.

### Worker plumbing

- SVG favicon (dark rounded square, cream page, amber folded corner) served at `/favicon.svg` + `/favicon.ico`, before auth, on all origins.
- `PAGEBIN_DEV_ADMIN_HOSTNAMES` (comma-separated) extends the dashboard's localhost allowance — set only in `wrangler.dev.toml` (Tailscale hostname + IP) so the dev server is reachable from a phone via `http://<tailscale-ip>:8788`. Not set in production config; prod routes pin hostnames so this cannot be spoofed there.
- Dashboard CSP gained `img-src 'self'` for the favicon.

## Decisions and why

- **Group by repo, not project.** `project` is inferred as `basename(git rev-parse --show-toplevel)` — the checkout *folder* name — so one repo cloned in two places splits into two groups. The dashboard normalizes `attributes.repo` (`https://…`, `git@host:…`, bare `host/org/name`, trailing `.git`) to `org/name` and groups on that, falling back to project, then "Uncategorized". The checkout folder still shows next to the branch. A possible future CLI change: infer `project` from the origin URL instead.
- **Reissue keeps the artifact's existing expiry.** A 30-day-TTL-on-reissue default was implemented mid-session and then **reverted** — the final call is that reissuing rotates the token without touching `expiresAt` (long-lived stays long-lived). Open question noted at the time: whether reissue should *clear* a TTL; currently it does not.
- **Agent brand icons** are inline SVG paths from Simple Icons (CSP forbids external assets): Anthropic mark (clay `#d97757`) for agents matching `claude`, OpenAI knot for `codex`, OpenCode's mark. **Amp has no fetchable vector logo** (site branding is served as WorkOS-hosted raster images), so `amp` gets a stand-in bolt glyph in coral — swap in the real path if obtained. Unknown agents get a generic sparkle stroke icon.
- **Native `<select>` rejected on desktop** (unstylable popup); chips won over a custom dropdown for filters. The prototype's custom-dropdown implementation was deleted with the knobs.
- **Prototype knobs** (a settings drawer that let the user A/B group-by, filters style, meta font, caps, and field visibility live) were how the design was converged, then removed once decisions were final. Design is now hard-coded.

## Review findings addressed (adversarial pass)

1. **(med)** Clipboard is unavailable on insecure origins (e.g. the Tailscale-IP dev URL), and reissue copied *before* re-rendering — a rotated URL could be lost entirely. Fixed: `copyText()` falls back to `prompt()`, and reissue reloads the list before attempting the copy.
2. Section DOM ids were name-derived slugs that could collide; now index-based (`sec-0…`), and outline clicks null-guard.
3. A selected host filter whose last artifact was deleted left the list stuck on an invisible filter; the filter now clears when its host disappears.
4. Comma-separated frontmatter array CSS broke arrays of objects (block-in-inline fragmentation); complex entries now keep block layout via `meta-token-complex`.

Confirmed clean by the same review: no user data reaches `innerHTML` (icons are static constants; everything else is `textContent`), the dev hostname whitelist cannot affect production, favicon route shadows nothing.

## Dev environment notes

- Dev server: `bunx wrangler dev --config wrangler.dev.toml --port 8788 --ip 0.0.0.0 --var 'PAGEBIN_PUBLIC_ORIGIN:'` — the blanked origin makes viewer links use the request origin, correct from both localhost and Tailscale. `.dev.vars` holds `PAGEBIN_PUBLISH_TOKEN=dev-local-token`.
- Local R2 is seeded with ~39 artifacts (pagebin ×2 checkouts, dotfiles, fleetview, uncategorized, showcase) with backdated timestamps, written via `wrangler r2 object put --local` while the server was stopped.
- A kitchen-sink markdown artifact ("Markdown Rendering Showcase") exercises frontmatter shapes, all heading levels, tables, task lists, highlighted code, two mermaid diagrams, details, image, and footnotes — republish it after template changes with `pagebin update <file>`.

## Known follow-ups

- Light color scheme for the markdown viewer (dashboard already supports both).
- Real Amp logo when a vector is available.
- Possibly infer `project` from origin URL in the CLI.
- Clipboard on plain-HTTP mobile still requires the prompt fallback; HTTPS via `tailscale serve` would fix it properly.
