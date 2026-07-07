# Changelog

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
