---
name: trellis-report
description: Write/refresh .trellis/report.json for this session and send it to Trellis now.
allowed-tools: Read, Write, Bash
---

Send a dev-activity report to Trellis for the current session:
1. Create or overwrite `.trellis/report.json` per `.trellis/README.md` — a plain-language
   `summary`, plus any bugs found/fixed (stable kebab-case `key` + severity), version/deploy
   changes, test results, and notable findings/TODOs.
2. Run: `node .trellis/report.mjs --send`
3. Report the one-line result to the user.
