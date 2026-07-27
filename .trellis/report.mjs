#!/usr/bin/env node
// Trellis session reporter (canonical copy — installed to .trellis/report.mjs).
// Dependency-free, Node >= 18. Invoked three ways:
//   - Stop hook       (default): send if a new report exists; else nudge once
//   - SessionEnd hook (--flush): send only, never nudge, never block
//   - /trellis-report (--send) : send the current report.json now
// EVERY failure path exits 0 silently — reporting must never break a session.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT = join(HERE, 'report.json')
const CONFIG = join(HERE, 'config.json')
const STATE = join(HERE, '.state.json')
const TTL_MS = 180 * 24 * 3600 * 1000
const MODE = process.argv.includes('--flush')
  ? 'flush'
  : process.argv.includes('--send')
    ? 'send'
    : 'stop'

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(path, obj) {
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2))
  } catch {
    /* ignore */
  }
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

// JS value -> Firestore typed value
function fv(v) {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fv) } }
  if (v && typeof v === 'object')
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fv(x)])) } }
  return { stringValue: String(v) }
}

const clampStr = (s, n) => String(s ?? '').slice(0, n)
const clampArr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : [])

// Build the dev_reports payload from report.json, clamped to the rule limits.
function buildPayload(report, cfg, sessionId, trigger) {
  const now = new Date()
  const f = {
    project: cfg.project,
    token: cfg.token,
    trigger,
    summary: clampStr(report.summary, 2000),
    at: null, // filled as timestampValue below
    expireAt: null,
  }
  if (sessionId) f.sessionId = clampStr(sessionId, 64)
  if (Array.isArray(report.worked)) f.worked = clampArr(report.worked, 15).map((x) => clampStr(x, 300))
  if (Array.isArray(report.next)) f.next = clampArr(report.next, 10).map((x) => clampStr(x, 300))
  if (Array.isArray(report.blockers)) f.blockers = clampArr(report.blockers, 10).map((x) => clampStr(x, 300))
  if (report.version && typeof report.version === 'object') {
    const v = {}
    for (const k of ['current', 'deployed', 'notes'])
      if (report.version[k] != null) v[k] = clampStr(report.version[k], 500)
    if (Object.keys(v).length) f.version = v
  }
  if (Array.isArray(report.bugs))
    f.bugs = clampArr(report.bugs, 20).map((b) => ({
      key: clampStr(b.key, 80),
      title: clampStr(b.title, 200),
      severity: ['critical', 'high', 'medium', 'low'].includes(b.severity) ? b.severity : 'medium',
      action: ['found', 'fixed', 'reopened'].includes(b.action) ? b.action : 'found',
      ...(b.note ? { note: clampStr(b.note, 500) } : {}),
    }))
  if (report.tests && typeof report.tests === 'object') {
    const t = {}
    if (typeof report.tests.ran === 'boolean') t.ran = report.tests.ran
    if (Number.isFinite(report.tests.passed)) t.passed = report.tests.passed
    if (Number.isFinite(report.tests.failed)) t.failed = report.tests.failed
    if (report.tests.note) t.note = clampStr(report.tests.note, 500)
    if (Object.keys(t).length) f.tests = t
  }
  if (Array.isArray(report.findings))
    f.findings = clampArr(report.findings, 20).map((x) => ({
      type: ['review', 'security', 'todo'].includes(x.type) ? x.type : 'todo',
      ...(x.severity ? { severity: x.severity } : {}),
      text: clampStr(x.text, 500),
    }))

  const fields = Object.fromEntries(
    Object.entries(f)
      .filter(([, val]) => val !== null)
      .map(([k, val]) => [k, fv(val)]),
  )
  fields.at = { timestampValue: now.toISOString() }
  fields.expireAt = { timestampValue: new Date(now.getTime() + TTL_MS).toISOString() }
  return { fields }
}

// Uses node:https (not global fetch) so there's no undici keep-alive handle to
// race with process.exit() — avoids a libuv assertion on Windows hook exits.
function post(cfg, body) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(body)
      const u = new URL(
        `https://firestore.googleapis.com/v1/projects/${cfg.fbProject}` +
          `/databases/(default)/documents/dev_reports?key=${cfg.apiKey}`,
      )
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          res.resume() // drain so the socket closes
          res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
        },
      )
      req.on('error', () => resolve(false))
      req.setTimeout(10000, () => {
        req.destroy()
        resolve(false)
      })
      req.end(data)
    } catch {
      resolve(false)
    }
  })
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

// Best-effort: did this session modify files? (nudge only if so)
function sessionModifiedFiles(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return true // unknown → allow nudge
    const text = readFileSync(transcriptPath, 'utf8')
    return /"(?:tool_name|name)"\s*:\s*"(Write|Edit|MultiEdit|NotebookEdit|Bash)"/.test(text)
  } catch {
    return true
  }
}

async function main() {
  const cfg = readJson(CONFIG, null)
  if (!cfg || !cfg.project || !cfg.token || !cfg.fbProject || !cfg.apiKey) process.exit(0)

  const stdin = MODE === 'send' ? {} : readStdin()
  const sessionId = stdin.session_id || ''
  const state = readJson(STATE, {})
  const report = readJson(REPORT, null)
  const haveReport = report && typeof report.summary === 'string' && report.summary.trim().length > 0

  // SEND path (all modes): send a usable report if it's new (or forced on --send).
  if (haveReport) {
    const hash = createHash('sha256').update(stable(report)).digest('hex')
    if (MODE === 'send' || hash !== state.sentHash) {
      const ok = await post(cfg, buildPayload(report, cfg, sessionId, MODE === 'send' ? 'manual' : 'auto'))
      if (ok) {
        state.sentHash = hash
        state.sentSession = sessionId
        writeJson(STATE, state)
        if (MODE === 'send') process.stdout.write('Reported to Trellis ✓\n')
      } else if (MODE === 'send') {
        process.stdout.write('Trellis report failed (check dev token / that dev reporting is enabled).\n')
      }
    } else if (MODE === 'send') {
      process.stdout.write('No changes since last report.\n')
    }
    process.exit(0)
  }

  // NUDGE path — Stop only, and only when the session did real work.
  if (MODE === 'stop') {
    if (stdin.stop_hook_active === true) process.exit(0) // legacy loop guard, if present
    if (state.nudgedSession === sessionId && sessionId) process.exit(0) // one nudge per session
    if (!sessionModifiedFiles(stdin.transcript_path)) process.exit(0) // Q&A only → silent
    state.nudgedSession = sessionId
    writeJson(STATE, state)
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          'Before finishing: create/overwrite .trellis/report.json with this ' +
          "session's report (schema: .trellis/README.md) — summary, any bugs " +
          'found/fixed (stable kebab-case key + severity), version/deploy changes, ' +
          'and test results — then stop.',
      }) + '\n',
    )
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
