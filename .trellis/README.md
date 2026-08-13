# .trellis — Trellis dev reporting

Claude Code maintains `report.json` here each session; a Stop hook sends it to
Trellis. You (Claude) write `report.json`; do not edit `report.mjs` or `config.json`.

## report.json schema (only `summary` is required)
```json
{
  "summary": "One paragraph: what this session did and where things stand.",
  "worked": ["Fixed pledge rounding in totals.js", "Added a rules test"],
  "next": [
    "Deploy and verify on live site",
    { "key": "rotate-stripe-key", "owner": true,
      "text": "Rotate the Stripe key — only you can do this one" }
  ],
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
- `bugs[].title`: **a sentence a non-developer can read** — what goes wrong, not the
  key repeated. The key is the filing name; the title is what the owner sees on their
  screen. "Pledge totals off by cents" is a title; `pledge-rounding` is not.
- `bugs[].action`: found | fixed | reopened. `severity`: critical | high | medium | low.
- `findings[].type`: review | security | todo.
- Overwrite fresh each session; never append to a previous report.

### `next` — and the two items in it that mean different things

A **plain string** is a note. It shows up in the activity feed and nothing else. Use it
for anything a future session should know, anything you are about to do yourself, and
anything that is not really a job. Most items are strings.

An **object** is a job for the owner, and it lands on their Focus page:

```json
{ "key": "rotate-stripe-key", "owner": true, "text": "Rotate the Stripe key" }
```

All three fields are required — `owner` must be literally `true`, and an item missing
any of them is refused rather than guessed at.

- **`key` is the task's identity, exactly like `bugs[].key`.** Reuse it in a later
  session and you update that one task; invent a new one and you file a second.
  Lowercase, digits and hyphens, 2–80 characters.
- **`owner: true` means only the owner can do it** — a decision, a password, a purchase,
  something on their phone. If a session could do it, it is not this. Measured before
  this existed: two thirds of what sessions filed as "next" was their own dev work, and
  putting that on the owner's page would bury the third that was genuinely theirs.
- **The owner's board wins.** Re-reporting a key updates the title and nothing else —
  never its column, order, sprint or due date. A task they marked **done** is left alone
  completely.

⚠ **Never derive a key from the text.** Measured 2026-08-12: one session filed the same
intent 26 minutes apart in two different wordings. A key computed from the words files
that twice; a key you chose files it once.
