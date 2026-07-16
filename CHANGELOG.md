# Changelog

## 0.11.0 - 2026-07-16

- Added `pagebin skill`, a credential-free command that prints concise, version-matched instructions for agents using the CLI.
- Added a project-local release/deployment skill and consolidated project skill discovery around `.agents/skills` with Claude and Codex compatibility symlinks.
- Updated PageBin verification guidance for the local Wrangler configuration, Helium tab handling, sandbox socket permissions, and ephemeral-port test behavior.
- Documented the secret-safe `direnv exec . bun run deploy` production workflow and durable repository guidance learned from the PageBin implementation cycle.

## 0.10.0 - 2026-07-16

- Made artifacts permanent by default, added explicit TTL updates and removal, and hid expired artifacts that can no longer be reissued.
- Removed artifact status tracking and added reliable Codex, Claude Code, and OpenCode agent inference with `--agent` as the sole explicit override.
- Added a branded public not-found page while preserving plain API errors.
- Pre-rendered Markdown, frontmatter, document navigation, and syntax highlighting in the CLI; only Mermaid documents retain a browser rendering dependency.
- Added bounded-concurrency dashboard metadata reads and interactive CLI progress without changing stdout or JSON contracts.

## 0.9.0 - 2026-07-15

- Redesigned the dashboard: flat editorial layout (serif titles, hairline rows) replaces the card grid. Artifacts group by normalized repository origin (`https://`, `git@`, and bare `host/org/name` remotes collapse to one section) with project fallback, so the same repo checked out in different folders lands in one group.
- Each artifact row shows relative age plus always-visible copy-link, reissue, and delete icon actions; metadata renders on two lines — status glyph, color-coded artifact type, branch with checkout folder — then source host, agent, and expiry (only when set).
- Added inline brand icons for coding agents (Anthropic mark for `claude*`, OpenAI for `codex*`, OpenCode; a stand-in bolt for `amp`) and small colored glyphs for branch and host.
- Sections cap at five rows with an expander; navigation via a fixed section outline rail on wide screens and a floating jump button on mobile. Filters are single-line chip groups for status and host.
- Clipboard actions fall back to a copy prompt on insecure origins, and reissue re-renders before copying so a rotated URL is never lost.
- Added an SVG favicon served at `/favicon.svg` and `/favicon.ico`.
- Added `PAGEBIN_DEV_ADMIN_HOSTNAMES` (dev-only, set in `wrangler.dev.toml`) to whitelist extra dashboard hostnames such as a Tailscale address; production configuration is unchanged.
- Rethemed the Markdown viewer to match the dashboard: warm charcoal palette, serif headings, amber accent, matching Mermaid theme. Side panels are more compact, frontmatter arrays of primitives render comma-separated, nested frontmatter sections use small-caps labels instead of bracket icons, and the mobile outline trigger is now a round hamburger button.

## 0.8.0 - 2026-07-12

- Added monotonic revisions, SHA-256 content identity, ETag-conditioned metadata mutations, tombstones, versioned content objects, legacy migration, and orphan cleanup to prevent lost updates and viewer-token resurrection.
- Added `pagebin verify` and `publish --verify` for raw-byte or stored-hash verification.
- Added inferred repository, project, host, Git, title, artifact-type, status, source-path, and agent metadata with explicit overrides.
- Versioned machine output with `schemaVersion: 1`; `watch --json` now emits JSON Lines events.
- Added protected local publication receipts, duplicate-publish prevention, file-only update lookup, `receipts`, and `show`.
- Added watcher ownership metadata and explicit supervision guidance.
- Added public `page-bin.com`, CLI `api.page-bin.com`, and Access-protected `admin.page-bin.com` origin separation.
- Added AES-256-GCM viewer-token recovery for dashboard Open and Copy link without exposing tokens in list responses.
- Added a responsive artifact dashboard with project/host grouping, search, filters, reissue, and delete actions.
- Expanded the `html-plans` skill with artifact contracts, focused recipes, verification guidance, and reusable HTML/log shells.
- Existing `*.workers.dev` viewer URLs are not redirected after the custom-domain migration. Reissue or reconstruct them on `page-bin.com`; configure `PAGEBIN_ENDPOINT=https://api.page-bin.com` for CLI management commands.

## 0.7.0 - 2026-07-07

- Changed viewer auto-reload polling to pause while the tab is hidden and back off from 2s to 60s while content is unchanged, instead of polling every second forever. Polling resets to 2s when the tab becomes visible or an update is detected. This cuts worker invocations from an abandoned viewer tab by ~98%.
- Fixed the weekly cleanup cron schedule to use `SUN` instead of `0` for the day of week, which Cloudflare's cron validation rejects.

## 0.6.0 - 2026-07-07

- Added `pagebin watch <file.html|file.md|file.markdown>` to publish a file, print the new viewer URL, and keep updating that artifact when the file changes.
- Fixed `pagebin watch` validation so watch-specific argument errors no longer mention `update`.
- Added `-h` and `--help` support for every subcommand.

## 0.5.0 - 2026-07-02

- Added Markdown publishing support for `.md` and `.markdown` files. The CLI renders Markdown to a dark HTML document before upload, with YAML frontmatter properties, GitHub-flavored Markdown, syntax-highlighted code blocks, and Mermaid diagrams. Markdown publishing uses the standard sandbox because the generated page needs scripts for rendering and interaction.

## 0.4.0 - 2026-06-18

- Added `pagebin update <artifact_id|viewer_url> <file.html>` to replace an existing artifact's HTML while preserving existing viewer URLs.
- Added `pagebin watch <artifact_id|viewer_url> <file.html>` to re-upload a file when it changes.
- Added viewer auto-reload: open pagebin viewer pages now poll for artifact updates and reload the iframe when content changes.
- Added a token-protected artifact version endpoint used by the viewer reload loop.
- Improved update reliability by rolling back HTML changes if metadata persistence fails.
- Improved watch reliability for editors that save files with atomic replacement.
