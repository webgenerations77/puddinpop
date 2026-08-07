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
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, 'config.json')

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

function patch(cfg, docId, fields) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify({ fields })
      // PATCH with an explicit updateMask so this both creates the document and
      // updates it in place — one call for all three modes.
      const mask = Object.keys(fields)
        .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
        .join('&')
      const u = new URL(
        `https://firestore.googleapis.com/v1/projects/${cfg.fbProject}` +
          `/databases/(default)/documents/folder_locks/${encodeURIComponent(docId)}` +
          `?key=${cfg.apiKey}&${mask}`,
      )
      const req = https.request(
        {
          hostname: u.hostname,
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

async function main() {
  const cfg = readJson(CONFIG, null)
  if (!cfg?.project || !cfg?.token || !cfg?.fbProject || !cfg?.apiKey) return

  const input = await readStdin()
  const sessionId = String(input.session_id || `pid-${process.pid}`).slice(0, 64)
  const now = new Date()

  // Releasing pulls the expiry back to now rather than deleting the document —
  // the rules deliberately grant no delete on this path, and an expired lock is
  // already ignored by everything that reads one.
  const expireAt = MODE === 'release' ? now : new Date(now.getTime() + LOCK_MIN * 60000)

  await patch(cfg, `${cfg.project}__${sessionId}`, {
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
  })
}

main().catch(() => {}) // never surface anything to the session
