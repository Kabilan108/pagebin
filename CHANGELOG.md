# Changelog

## 0.4.0 - 2026-06-18

- Added `pagebin update <artifact_id|viewer_url> <file.html>` to replace an existing artifact's HTML while preserving existing viewer URLs.
- Added `pagebin watch <artifact_id|viewer_url> <file.html>` to re-upload a file when it changes.
- Added viewer auto-reload: open pagebin viewer pages now poll for artifact updates and reload the iframe when content changes.
- Added a token-protected artifact version endpoint used by the viewer reload loop.
- Improved update reliability by rolling back HTML changes if metadata persistence fails.
- Improved watch reliability for editors that save files with atomic replacement.
