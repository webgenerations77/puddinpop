# .trellis — Trellis dev reporting

Claude Code maintains `report.json` here each session; a Stop hook sends it to
Trellis. You (Claude) write `report.json`; do not edit `report.mjs` or `config.json`.

## report.json schema (only `summary` is required)
```json
{
  "summary": "One paragraph: what this session did and where things stand.",
  "worked": ["Fixed pledge rounding in totals.js", "Added a rules test"],
  "next": ["Deploy and verify on live site"],
  "blockers": ["Waiting on Firebase console access"],
  "version": { "current": "v42", "deployed": "v41", "notes": "Rounding fix" },
  "bugs": [
    { "key": "pledge-rounding", "title": "Pledge totals off by cents",
      "severity": "high", "action": "fixed", "note": "float -> integer cents" }
  ],
  "tests": { "ran": true, "passed": 12, "failed": 0 },
  "findings": [
    { "type": "todo", "text": "totals.js needs a test for negative pledges" }
  ]
}
```
- `bugs[].key`: stable kebab-case slug reused across sessions (the bug's identity).
- `bugs[].action`: found | fixed | reopened. `severity`: critical | high | medium | low.
- `findings[].type`: review | security | todo.
- Overwrite fresh each session; never append to a previous report.
