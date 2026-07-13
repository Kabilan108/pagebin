# Changelog

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
