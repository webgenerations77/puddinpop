#!/usr/bin/env node
// Trellis folder lock (canonical copy — installed to .trellis/lock.mjs).
//
// Tells Trellis that a Claude session is working in this folder, so the
// dispatch runner leaves it alone. Without this, opening a project in VS Code
// and asking Claude to change something races the runner: the runner claims the
// folder, hard-resets it to origin, and the work in progress is gone.
//
// Three ways in, wired to three hooks:
//   --start   SessionStart  — take the lock
//   --refresh Stop          — push the expiry out; the session is still alive
//   --release SessionEnd    — stand down
//
// The lock EXPIRES. That is the whole safety design: a crashed editor, a killed
// terminal or a laptop that slept can't hold a folder longer than LOCK_MIN,
// because a lock nobody refreshes simply stops counting. Nothing has to clean
// up after a session that died, which is why there is no delete anywhere here.
//
// Dependency-free, Node >= 18. EVERY failure path exits 0 in silence — this
// must never break, block or slow down a session. The cost of failing quietly
// is that a folder isn't protected, which is exactly where things stood before
// this existed; the cost of failing loudly would be a broken editor.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, 'config.json')
// ── WHERE THE SESSION ID LIVES BETWEEN PROCESSES (2026-08-12, docs §3 option b) ──
// Acquire and release run in SEPARATE PROCESSES and must compute the SAME key.
// Anything process-local cannot: a pid, a port, an in-memory uuid. The old
// fallback was `pid-<process.pid>`, so whenever the harness supplied no
// session_id the two halves keyed different documents — and because a PATCH
// creates a document that isn't there, the release succeeded against a document
// that was never the lock. Measured: `decide__pid-11696` held Decide for its
// full 45 minutes after the owner had been told it was checked back in.
//
// So the id is written down at acquire and read back at release. Gitignored;
// the installer adds the entry.
const SESSION_FILE = join(HERE, '.lock-session')

// How long a lock lives without a refresh. Comfortably longer than the gap
// between Stop hooks in an active session, and short enough that a session
// which died unnoticed frees its folder within one coffee break.
const LOCK_MIN = 45

const MODE = process.argv.includes('--release')
  ? 'release'
  : process.argv.includes('--refresh')
    ? 'refresh'
    : 'start'

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// JS value -> Firestore typed value (same shape as report.mjs).
function fv(v) {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  return { stringValue: String(v) }
}

/**
 * Read the session id the hook was given on stdin.
 *
 * The lock document is keyed on it, so two sessions in one folder each hold
 * their own lock and neither can stand the other's down — closing one editor
 * window must not unlock a folder another session is still working in.
 *
 * Hooks deliver JSON on stdin; if that isn't there for any reason we fall back
 * to a per-process id, which still locks correctly and simply can't be matched
 * up across hook invocations.
 */
function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    }
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d) => (raw += d))
      process.stdin.on('end', finish)
      process.stdin.on('error', finish)
      setTimeout(finish, 2000) // never hang a hook waiting for input
    } catch {
      finish()
    }
  })
}

/**
 * @param mustExist Refuse to CREATE the document — see the call site.
 */
function patch(cfg, docId, fields, mustExist = false) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify({ fields })
      // PATCH with an explicit updateMask so this both creates the document and
      // updates it in place — one call for all three modes.
      const mask = Object.keys(fields)
        .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
        .join('&')
      // ⚠ A PATCH CREATES THE DOCUMENT WHEN IT ISN'T THERE, which is what let a
      // release report success against a lock it had just invented. On release
      // we require the document to already exist, so a wrong key comes back
      // 404 and leaves nothing behind instead of littering `folder_locks` with
      // a `released: true` phantom that every runner pass then pays to read.
      const exists = mustExist ? '&currentDocument.exists=true' : ''
      // `cfg.endpoint` is the ONE seam, and it is config-driven rather than an
      // environment variable on purpose: this request carries the project's dev
      // token, and an env var would let anything in the session's environment
      // redirect it. config.json is gitignored and local, so only something
      // that already owns this folder can point it elsewhere. Absent in every
      // real install — `trellis-dev.mjs` never writes it — so production is
      // byte-for-byte the behavior above.
      const base = cfg.endpoint || 'https://firestore.googleapis.com'
      const u = new URL(
        `${base}/v1/projects/${cfg.fbProject}` +
          `/databases/(default)/documents/folder_locks/${encodeURIComponent(docId)}` +
          `?key=${cfg.apiKey}&${mask}${exists}`,
      )
      const transport = u.protocol === 'http:' ? http : https
      const req = transport.request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          res.resume()
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

/**
 * The last resort, and the reason it is NOT a pid.
 *
 * Host plus folder is stable across processes, so acquire and release still
 * agree on it. Its known weakness is that two sessions in one folder on one
 * host share a key, so the first to end stands the other down — which is why it
 * is only ever reached when the harness gave no session id AND the id file
 * could not be written. A pid, by contrast, cannot work even once.
 */
function stableFallback() {
  return `${hostname()}-${basename(dirname(HERE))}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
}

/**
 * The id this session's lock is keyed on, the same in every process.
 *
 * ACQUIRE decides it and writes it down. REFRESH and RELEASE read it back —
 * the file first, because it is the only source that is exact. Everything else
 * is a guess that happens to be stable.
 */
function resolveSessionId(input) {
  const fromHook = input.session_id ? String(input.session_id).slice(0, 64) : null

  if (MODE === 'start') {
    const id = fromHook || stableFallback()
    try {
      writeFileSync(SESSION_FILE, id, 'utf8')
    } catch {
      // Read-only checkout, permissions, a full disk. The lock still works;
      // release just falls back to the same computation acquire used, which is
      // why the fallback has to be deterministic rather than process-local.
    }
    return id
  }

  let persisted = null
  try {
    persisted = readFileSync(SESSION_FILE, 'utf8').trim().slice(0, 64) || null
  } catch {
    persisted = null
  }
  return persisted || fromHook || stableFallback()
}

async function main() {
  const cfg = readJson(CONFIG, null)
  if (!cfg?.project || !cfg?.token || !cfg?.fbProject || !cfg?.apiKey) return

  const input = await readStdin()
  const sessionId = resolveSessionId(input)
  const now = new Date()

  // Releasing pulls the expiry back to now rather than deleting the document —
  // the rules deliberately grant no delete on this path, and an expired lock is
  // already ignored by everything that reads one.
  const expireAt = MODE === 'release' ? now : new Date(now.getTime() + LOCK_MIN * 60000)

  const ok = await patch(cfg, `${cfg.project}__${sessionId}`, {
    project: fv(cfg.project),
    token: fv(cfg.token),
    sessionId: fv(sessionId),
    host: fv(hostname().slice(0, 64)),
    // The folder being held, for the card — the repo root is two levels up
    // from this file (.trellis/lock.mjs).
    folder: fv(basename(dirname(HERE)).slice(0, 300)),
    label: fv('a Claude session'),
    at: fv(now),
    expireAt: fv(expireAt),
    released: fv(MODE === 'release'),
  },
  // Only the release refuses to create. Acquire must be able to, and a refresh
  // that found its lock gone should put it back rather than leave the folder
  // unprotected for the rest of the session.
  MODE === 'release')

  // Clear the id only once the release actually landed. Removing it on a failed
  // release would strand the real lock with nothing left that knows its key.
  if (MODE === 'release' && ok) {
    try {
      unlinkSync(SESSION_FILE)
    } catch {
      /* already gone, or never written */
    }
  }
}

main().catch(() => {}) // never surface anything to the session
