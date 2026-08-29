#!/usr/bin/env node
// Trellis session reporter (canonical copy — installed to .trellis/report.mjs).
// Dependency-free, Node >= 18. Invoked three ways:
//   - Stop hook       (default): refresh the folder lock, then send if a new
//                      report exists, else nudge once
//   - SessionEnd hook (--flush): hand off to a DETACHED worker (--flush-worker,
//                      spawnFlushWorker()) that releases the folder lock, then
//                      sends only — never nudge, never block, and never make
//                      the hook itself wait on the network during shutdown
//   - /trellis-report (--send) : send the current report.json now
// EVERY failure path exits 0 silently — reporting must never break a session.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT = join(HERE, 'report.json')
const CONFIG = join(HERE, 'config.json')
const STATE = join(HERE, '.state.json')
const TTL_MS = 180 * 24 * 3600 * 1000
// `--flush-worker` is this same file, re-invoked as the DETACHED background
// process `--flush` hands off to — see spawnFlushWorker(). It runs the exact
// `flush` path below; the flag only decides how `main()` gets there.
const IS_FLUSH_WORKER = process.argv.includes('--flush-worker')
const MODE = process.argv.includes('--flush') || IS_FLUSH_WORKER
  ? 'flush'
  : process.argv.includes('--send')
    ? 'send'
    : 'stop'
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

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
    // Which serializer produced this report (docs/86 §4.2). Bumped whenever the
    // shape on the wire changes. Reports from before 2026-08-14 omit it, and the
    // rule keeps it optional forever so those keep working — but without it
    // nothing can answer "which projects are still running the copy that
    // destroys an owner item", and the self-heal path has a blind spot (a repo
    // that is dirty, parked on a dispatch branch, or checked out never catches
    // up on its own).
    // 3 (2026-08-18): sends `roadmap`. A project still stamping 2 has a working
    // reporter that simply cannot carry a plan — which is a rollout question,
    // not a fault, and this number is the only thing that can tell them apart.
    reporter: 3,
  }
  if (sessionId) f.sessionId = clampStr(sessionId, 64)
  if (Array.isArray(report.worked)) f.worked = clampArr(report.worked, 15).map((x) => clampStr(x, 300))
  // ⚠ `next[]` IS A UNION OF PLAIN STRINGS AND `{key, owner, text}` MAPS, AND
  // `clampStr` DESTROYS THE SECOND KIND. `String({...})` is the literal
  // "[object Object]", which is what shipped from 2026-08-12 to 08-14: measured
  // live at 19% of every `next` item across two projects, and it is the reason
  // items a session marked for the owner never reached their Focus page. The
  // owner saw the garbage in the activity feed and the item nowhere else.
  //
  // ⚠ OWNER-MARKED OBJECTS TAKE THE 10-ITEM BUDGET FIRST. `clampArr` truncates
  // positionally, so an owner item at position 11 would never reach the wire at
  // all — and the reader cannot refuse what never arrived, so it is silent loss
  // of exactly the item class this feature exists for. The reader is
  // order-insensitive (`parseNextSteps` builds a Map by key) and the plain
  // strings only feed the activity feed, so reordering costs nothing.
  //
  // ⚠ `Array.isArray` GUARD, NOT `typeof x === 'object'` ALONE. `typeof []` is
  // `'object'`, so an array would take the map branch and arrive as
  // `{key:'', owner:false, text:''}` — refused downstream as `not-owner`, which
  // is a wrong reason for a real mistake. Arrays stay on the string path,
  // exactly as today.
  //
  // Validation deliberately stays on the READING side (`parseNextSteps`), not
  // here: this file is installed into every project and updated by a rollout, so
  // a second copy of the key rules living here would drift out of step with the
  // first and there would be no way to tell which copy a given project ran.
  if (Array.isArray(report.next)) {
    const isItem = (x) => x && typeof x === 'object' && !Array.isArray(x)
    const items = report.next
      .filter(isItem)
      .map((x) => ({ key: clampStr(x.key, 80), owner: x.owner === true, text: clampStr(x.text, 300) }))
    const plain = report.next.filter((x) => !isItem(x)).map((x) => clampStr(x, 300))
    f.next = [...clampArr(items, 10), ...plain].slice(0, 10)
  }
  // The project's own plan (2026-08-18). Maps only — there is no string form
  // here, deliberately: `next` has one and it is the reason 19% of its items
  // arrived as the literal "[object Object]". A step with no key has no
  // identity, so there is nothing useful to send.
  //
  // ⚠ NO KEY VALIDATION HERE, for the reason the `next` block above gives at
  // length: this file lives in 25 repos and is updated by a rollout, so a second
  // copy of the key rules would drift from `roadmap.ts` and nothing would say
  // which copy a given project ran. Shape and length only; `parseRoadmap`
  // decides what is legal and reports what it refused.
  //
  // ⚠ AN EMPTY ARRAY MUST SURVIVE. `[]` is the reader's "nothing is planned any
  // more" and an absent field is "this report did not say" — dropping the empty
  // one collapses two different statements into the one that changes nothing.
  if (Array.isArray(report.roadmap)) {
    f.roadmap = clampArr(report.roadmap, 12)
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .map((x) => ({
        key: clampStr(x.key, 80),
        title: clampStr(x.title, 160),
        ...(x.detail ? { detail: clampStr(x.detail, 500) } : {}),
      }))
  }
  if (Array.isArray(report.blockers)) f.blockers = clampArr(report.blockers, 10).map((x) => clampStr(x, 300))
  if (report.version && typeof report.version === 'object') {
    const v = {}
    for (const k of ['current', 'deployed', 'notes'])
      if (report.version[k] != null) v[k] = clampStr(report.version[k], 500)
    if (Object.keys(v).length) f.version = v
  }
  // ⚠⚠ `status` IS ACCEPTED AS AN ALIAS FOR `action`, AND THAT IS NOT SLOPPINESS.
  // On 2026-08-25 four sessions in one project wrote `status: "fixed"` — which is
  // exactly what Trellis's own bug records call this field — and the old line here
  // turned all EIGHTEEN of them into `found`, because an unrecognized value fell
  // through to the default. Eighteen finished fixes arrived as eighteen fresh
  // discoveries; no error was raised anywhere, the reports sent cleanly, and the
  // bugs then sat un-closeable for three days because they also carried no note.
  // The trap is that the input schema and the stored schema use different names
  // for one idea, so `status` is the natural thing to write. Accepting both is
  // the cheapest way to close it for good.
  //
  // ⚠ AND AN UNRECOGNIZED VALUE NO LONGER VANISHES SILENTLY. It still sends as
  // `found` — refusing the report outright would throw away a whole session's
  // record, and this file exits 0 on every path precisely so it can never take a
  // session down — but it now says so in `findings`, which reaches the owner.
  // A silent default that CREATES work is the dangerous direction: it manufactures
  // a backlog nobody can close, which is the permissive-collapse family this
  // project keeps paying for.
  const BUG_ACTIONS = ['found', 'fixed', 'reopened']
  const badActions = []
  if (Array.isArray(report.bugs))
    f.bugs = clampArr(report.bugs, 20).map((b) => {
      const named = BUG_ACTIONS.includes(b.action)
        ? b.action
        : BUG_ACTIONS.includes(b.status)
          ? b.status
          : null
      if (named === null && (b.action != null || b.status != null))
        badActions.push(`${clampStr(b.key, 80)}="${clampStr(b.action ?? b.status, 20)}"`)
      return {
        key: clampStr(b.key, 80),
        title: clampStr(b.title, 200),
        severity: ['critical', 'high', 'medium', 'low'].includes(b.severity) ? b.severity : 'medium',
        action: named ?? 'found',
        ...(b.note ? { note: clampStr(b.note, 500) } : {}),
      }
    })
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

  // The only channel this file has that the owner actually reads. Appended after
  // the session's own findings so it can never displace one, and clamped back to
  // the same 20 the block above enforces.
  if (badActions.length)
    f.findings = [
      ...(f.findings || []),
      {
        type: 'todo',
        text: clampStr(
          `Report format: ${badActions.length} bug ${badActions.length === 1 ? 'entry' : 'entries'} named an ` +
            `action this reporter does not recognize and ${badActions.length === 1 ? 'was' : 'were'} recorded as ` +
            `"found" — ${badActions.join(', ')}. Valid values are found, fixed or reopened (.trellis/README.md).`,
          500,
        ),
      },
    ].slice(0, 20)

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

// `readFileSync(0)` is a synchronous, UNBOUNDED read — it blocks until the
// writer closes the pipe. Measured 2026-08-27: if the harness ever leaves a
// hook's stdin open past the JSON payload instead of closing it right away,
// that call hangs forever, this process never reaches any of its
// `process.exit(0)` calls below, and the lock refresh / report send this
// hook exists to do simply never happens — indistinguishable from "the Stop
// hook did not fire". `lock.mjs`'s own `readStdin()` already guards the same
// read with an async listener plus a timeout fallback; this mirrors it so a
// slow-to-close pipe can delay this hook by at most STDIN_TIMEOUT_MS, never
// hang it.
const STDIN_TIMEOUT_MS = 2000
function readStdinRaw() {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(raw)
    }
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d) => (raw += d))
      process.stdin.on('end', finish)
      process.stdin.on('error', finish)
      setTimeout(finish, STDIN_TIMEOUT_MS)
    } catch {
      finish()
    }
  })
}

// Runs `.trellis/lock.mjs` as a CHILD PROCESS AND AWAITS ITS EXIT, instead of
// leaving the folder-lock refresh/release as a second command in the same
// Stop/SessionEnd hook event.
//
// Measured 2026-08-13/14: with lock.mjs and report.mjs wired as two commands
// on one event, the report hook demonstrably ran every time while the lock's
// refresh never landed once in a 45-minute session — running the same lock
// command by hand worked instantly, so the script was fine and the SECOND
// hook command was not. The two-group-vs-one-group hook shape was tested and
// ruled out; reordering the two commands (lock first) was the next untested
// theory and is still unproven live. Rather than depend on an unverified,
// undocumented guarantee about how the harness runs multiple commands per
// hook event, this makes the lock op part of THIS hook's own single command:
// spawn it, feed it the same stdin the harness gave this process (lock.mjs
// falls back to it only if `.trellis/.lock-session` is unreadable), and wait
// for it to exit before doing anything else. One process, one command, order
// guaranteed by this file rather than by the harness.
//
// Never rejects — a lock op that fails or times out (lock.mjs caps its own
// Firestore call at 10s) must not block this hook from sending the report.
function runLock(mode, stdinRaw) {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [join(HERE, 'lock.mjs'), `--${mode}`], {
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
      child.stdin.on('error', () => {}) // lock.mjs may exit before reading stdin
      child.stdin.end(stdinRaw)
    } catch {
      resolve()
    }
  })
}

// SessionEnd cannot block, and — even with the lock op folded into this one
// hook command above — it still can't rely on getting the network time a lock
// release and a report POST need back to back: the release alone measures
// 2.1-2.3s, so the pair comfortably clears the shutdown window Claude Code
// gives a terminating SessionEnd hook, and both were reported canceled.
//
// So `--flush` itself now does no network work. It reads just the session id
// off stdin (the one field the rest of the flush path needs) and hands off to
// a DETACHED copy of this same file — `--flush-worker` — before exiting
// immediately. The worker is not part of the hook Claude Code is timing, so
// however long Firestore takes, it is no longer a race against shutdown.
// `detached: true` + `stdio: 'ignore'` + `unref()` is Node's documented way to
// start a process that outlives its parent on both Windows and POSIX.
function spawnFlushWorker(sessionId) {
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--flush-worker', '--session-id', sessionId || ''],
      { stdio: 'ignore', detached: true },
    )
    child.on('error', () => {}) // the 45-minute lock TTL is the fallback if this never runs
    child.unref()
  } catch {
    /* same fallback — a lock nobody refreshes or releases simply expires */
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
  // The real SessionEnd invocation: hand off to the detached worker and
  // return immediately — see spawnFlushWorker()'s note. Everything below this
  // block runs only for Stop, --send, and the worker itself.
  if (MODE === 'flush' && !IS_FLUSH_WORKER) {
    const raw = await readStdinRaw()
    let sessionId = ''
    try {
      sessionId = JSON.parse(raw).session_id || ''
    } catch {
      /* no session id available; lock.mjs falls back to a stable host+folder key */
    }
    spawnFlushWorker(sessionId)
    process.exit(0)
  }

  const stdinRaw = IS_FLUSH_WORKER
    ? JSON.stringify({ session_id: argValue('--session-id') || '' })
    : MODE === 'send'
      ? ''
      : await readStdinRaw()
  // Before anything else — see runLock()'s note on why this lives here rather
  // than as a second hook command.
  if (MODE === 'stop') await runLock('refresh', stdinRaw)
  if (MODE === 'flush') await runLock('release', stdinRaw)

  const cfg = readJson(CONFIG, null)
  if (!cfg || !cfg.project || !cfg.token || !cfg.fbProject || !cfg.apiKey) process.exit(0)

  const stdin = (() => {
    try {
      return JSON.parse(stdinRaw)
    } catch {
      return {}
    }
  })()
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
