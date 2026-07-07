# Changelog

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
