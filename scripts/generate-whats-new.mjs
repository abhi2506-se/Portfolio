#!/usr/bin/env node
/**
 * scripts/generate-whats-new.mjs
 *
 * Finds new features automatically, so nobody has to type them in. It runs
 * before every build (npm "prebuild"), and writes lib/whats-new.generated.json.
 *
 * Two modes:
 *  1. Git mode (GitHub deploys, e.g. Vercel). Compares against the previous
 *     deployed commit (VERCEL_GIT_PREVIOUS_SHA, or WHATS_NEW_BASE). Each new
 *     commit with a "feat:" subject becomes an entry. New public pages are
 *     added too.
 *  2. Snapshot mode (zip uploads, no .git). Compares the current file list with
 *     scripts/whats-new-snapshot.json. New public pages and new components, hooks
 *     and libs become entries. The snapshot is then updated, so the next run only
 *     reports what changed after this one.
 *
 * The script never fails the build. On any problem it keeps the previous file.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = process.cwd()
const OUT = path.join(ROOT, 'lib', 'whats-new.generated.json')
const SNAPSHOT = path.join(ROOT, 'scripts', 'whats-new-snapshot.json')
const MAX_ITEMS = 40
const SKIP_DIRS = ['node_modules', '.next', '.git', 'out', 'dist']

const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

const hasGit = fs.existsSync(path.join(ROOT, '.git')) || sh('git rev-parse --is-inside-work-tree') === 'true'

/** Public, user-facing pages only. Admin, API and portal routes are internal. */
function isPublicPage(file) {
  return /^app\/.*page\.(tsx|jsx|ts|js)$/.test(file)
    && !/^app\/(admin|api|portal)\//.test(file)
}

function routeOf(file) {
  const dir = file.replace(/^app\//, '').replace(/\/?page\.(tsx|jsx|ts|js)$/, '')
  // Route groups like (marketing) don't appear in the URL.
  const clean = dir.split('/').filter(p => !/^\(.*\)$/.test(p)).join('/')
  return '/' + clean
}

function titleFromName(file) {
  const base = path.basename(file).replace(/\.(tsx|ts|jsx|js)$/, '')
  return base.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * Turns a file's top comment into a title and a short description, so features
 * read as "Video compression before sending", not as a file name. Falls back to
 * the file name when there's no comment.
 */
function describeFile(file) {
  let text = ''
  try { text = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch {}
  // Only the file's header comment, which is above the first import/export/const.
  const header = text.split(/^(?:import|export|const|function|async)\b/m)[0].slice(0, 2000)
  const block = header.match(/\/\*\*?([\s\S]*?)\*\//)
  const raw = block ? block[1] : header.split('\n').filter(l => /^\s*\/\//.test(l)).join('\n')
  const lines = raw
    .split('\n')
    .map(l => l.replace(/^\s*(\/\/|\*)?\s?/, '').replace(/\(?(SERVER ONLY|CLIENT ONLY)\)?/gi, '').trim())
    .filter(l => l
      && !/[\w-]+\/[\w./-]+|\.(tsx?|jsx?|mjs)\b/.test(l)   // file paths and file names
      && !/^[─=\-_*#]+$/.test(l)
      && !/^[a-z]/.test(l))                                       // skip code-ish fragments
  const first = lines[0] || ''
  if (!first) return { title: titleFromName(file), body: file }
  const sentence = first.split(/(?<=[.!?])\s/)[0] || first
  const title = sentence.replace(/[.:]$/, '').slice(0, 120)
  const body = lines.slice(1, 4).join(' ').slice(0, 300)
  return { title: title.charAt(0).toUpperCase() + title.slice(1), body: body || file }
}

function stableId(...parts) {
  return 'auto_' + crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

/** All files under the project, relative to ROOT, skipping build and dependency folders. */
function listFiles(dir = ROOT, rel = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir), { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), r))
    else out.push(r)
  }
  return out
}

function fromGit() {
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA || process.env.WHATS_NEW_BASE || ''
  const range = base ? `${base}..HEAD` : 'HEAD~15..HEAD'
  const log = sh(`git log ${range} --no-merges --date=iso --pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e`)
  if (!log) return []
  const items = []
  for (const record of log.split('\x1e').map(r => r.trim()).filter(Boolean)) {
    const [hash, date, subject, body = ''] = record.split('\x1f')
    const m = subject.match(/^feat(\([^)]*\))?!?:\s*(.+)$/i)
    if (!m) continue
    items.push({
      id: stableId('commit', hash),
      title: m[2].trim().charAt(0).toUpperCase() + m[2].trim().slice(1),
      body: body.trim().slice(0, 500),
      date: new Date(date).toISOString(),
    })
  }
  // New public pages in the same range
  const added = sh(`git diff --name-status --diff-filter=A ${range}`).split('\n').filter(Boolean)
  for (const line of added) {
    const file = line.split('\t').pop()
    if (file && isPublicPage(file)) {
      items.push({
        id: stableId('page', file),
        title: `New page: ${routeOf(file)}`,
        body: 'This page is new.',
        date: new Date().toISOString(),
      })
    }
  }
  return items
}

function fromSnapshot(current) {
  const now = new Date().toISOString()
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).files } catch {}
  // First run without a snapshot records the baseline and reports nothing.
  if (!previous) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ takenAt: now, files: current }, null, 2))
    return []
  }
  const before = new Set(previous)
  const added = current.filter(f => !before.has(f))
  const items = []
  for (const file of added) {
    if (isPublicPage(file)) {
      items.push({ id: stableId('page', file), title: `New page: ${routeOf(file)}`, body: 'This page is new.', date: now })
    } else if (/^(components|hooks|lib)\//.test(file) && /\.(tsx|ts)$/.test(file) && !file.endsWith('.d.ts')) {
      const d = describeFile(file)
      items.push({ id: stableId('file', file), title: d.title, body: d.body || file, date: now })
    }
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify({ takenAt: now, files: current }, null, 2))
  return items
}

function main() {
  let items
  try {
    const current = listFiles()
    items = hasGit && (process.env.VERCEL_GIT_PREVIOUS_SHA || sh('git rev-list --count HEAD') !== '1')
      ? fromGit()
      : fromSnapshot(current)
  } catch (err) {
    console.warn('[whats-new] skipped:', err?.message || err)
    return
  }
  // Newest first, unique, capped
  const seen = new Set()
  const unique = items
    .filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, MAX_ITEMS)
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items: unique }, null, 2) + '\n')
  console.log(`[whats-new] ${unique.length} entr${unique.length === 1 ? 'y' : 'ies'} written to lib/whats-new.generated.json`)
}

main()
