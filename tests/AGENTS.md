# Test guidance

- When reproducing CLI failures against an in-process fake worker, never use `spawnSync`: it blocks the event loop that `Bun.serve` runs on and deadlocks. Spawn the CLI async, as the harness does.
- The update endpoint treats a missing `Content-Length` header as over-limit; hand-rolled probe requests must set it explicitly.
- Always pass an explicit `--endpoint` when spawning the CLI in tests — omitting it makes the test depend on (and potentially hit) the real endpoint direnv exports from `.envrc`.
