
<!-- trellis-dev:begin (managed by Trellis installer — do not edit inside) -->
## Trellis session reporting
This project reports dev activity to Trellis. Maintain `.trellis/report.json`
(schema + examples: `.trellis/README.md`):
- CREATE/OVERWRITE it near the end of any session that changed files — fresh
  each session, never append to the previous session's report.
- Record every bug you FIND or FIX as a bug event with a stable kebab-case
  `key` (reuse the same key when fixing a bug found earlier), a severity
  (critical/high/medium/low), plus test results, version/deploy changes, and
  notable review/security findings or TODOs.
- Keep `summary` plain-language — the reader is a non-developer.
- A Stop hook sends the file automatically; if asked to write the report
  before stopping, do so immediately, then stop. `/trellis-report` sends on
  demand. Never edit `.trellis/report.mjs`, `config.json`, or this block.
<!-- trellis-dev:end -->
