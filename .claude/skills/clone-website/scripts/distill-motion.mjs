#!/usr/bin/env node
/**
 * clone-website — motion corpus distiller (offline research tool)
 *
 * One-time, run by hand against reference repos. Rakes every animation call
 * site out of a codebase and dumps them as one flat JSON array so a human can
 * build a histogram and name the motion verbs.
 *
 * This script does NOT cluster, name, or classify beyond the raw `kind` of the
 * call site. Verb naming is a judgment step, not a regex step — see SKILL.md.
 *
 * Usage:
 *   node distill-motion.mjs <repo-dir> [<repo-dir> ...] --out <output-dir>
 *
 * Writes <output-dir>/motion-corpus-raw.json and prints a count table.
 * Pure Node — no playwright, no deps.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, extname, basename, resolve } from 'node:path'

// ---- arg parsing -----------------------------------------------------------
const [, , ...rest] = process.argv
const positional = []
const flags = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const nx = rest[i + 1]
    if (nx === undefined || nx.startsWith('--')) flags[k] = true
    else { flags[k] = nx; i++ }
  } else positional.push(a)
}
const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const repos = positional
const outDir = flags.out === true ? undefined : flags.out
if (!repos.length || !outDir) die('Usage: distill-motion.mjs <repo-dir> [<repo-dir> ...] --out <output-dir>', 2)

// ---- file walking ----------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'out', 'coverage', '.turbo'])
const EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.css'])

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, acc) }
    else if (e.isFile() && EXTS.has(extname(e.name))) acc.push(p)
  }
  return acc
}

// ---- match patterns --------------------------------------------------------
// Snippet-based on purpose: brace matching across GSAP/Framer configs is more
// fragile than it is useful for a corpus you're going to eyeball anyway.
const CONTEXT = 150
const MAX_SNIPPET = 300
const CODE_RULES = [
  { kind: 'gsap', re: /gsap\s*\.\s*(?:to|from|fromTo|timeline|set|registerPlugin)\s*\(/g },
  { kind: 'scrolltrigger', re: /(?:scrollTrigger\s*:\s*\{|ScrollTrigger\s*\.\s*(?:create|batch|refresh)\s*\()/g },
]
const CSS_RULES = [
  { kind: 'css-transition', re: /(?:^|[\s;{])transition(?:-[a-z-]+)?\s*:/gm },
  { kind: 'css-animation', re: /(?:^|[\s;{])animation(?:-[a-z-]+)?\s*:/gm },
]

// ---- line lookup -----------------------------------------------------------
// One O(n) pass per file builds the newline offsets; each match then costs a
// O(log n) binary search instead of re-slicing the file from byte 0.
function newlineOffsets(text) {
  const offsets = []
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) offsets.push(i)
  return offsets
}
function lineOf(offsets, index) {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < index) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const snippetAt = (text, index, matched) => collapse(text.slice(index, index + matched.length + CONTEXT))

// ---- framer: one record per JSX opening tag --------------------------------
// Matching `initial=` / `animate=` / `transition=` independently counts one
// element three times and skews the `by kind` histogram. So find the opening
// tag's span first and emit a single record for the whole tag.
const TAG_START = /<([A-Za-z][\w.$:-]*)/g
const FRAMER_PROP = /\b(?:initial|animate|exit|transition|whileHover|whileTap|whileInView)\s*=\s*\{/
const FRAMER_VARIANT = /\btransition\s*:\s*\{/g
const MAX_TAG_SPAN = 4000

// Exclusive end offset of the JSX opening tag whose name ends at `from`, or -1.
// Pragmatic scanner, not a parser: it tracks brace depth and quotes so a `>`
// inside `{...}` or a string does not close the tag early.
function scanTagEnd(text, from) {
  let depth = 0
  let quote = ''
  const limit = Math.min(text.length, from + MAX_TAG_SPAN)
  for (let i = from; i < limit; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') { if (depth > 0) depth--; continue }
    if (depth === 0) {
      if (c === '>') return i + 1
      if (c === '<') return -1 // ran past the tag — treat as a false start
    }
  }
  return -1
}

function collectFramer(text) {
  const hits = []
  const spans = []
  TAG_START.lastIndex = 0
  let m
  while ((m = TAG_START.exec(text)) !== null) {
    const end = scanTagEnd(text, TAG_START.lastIndex)
    if (end === -1) { TAG_START.lastIndex = m.index + 1; continue }
    const tag = text.slice(m.index, end)
    spans.push([m.index, end])
    if (FRAMER_PROP.test(tag)) hits.push({ index: m.index, snippet: clip(collapse(tag), MAX_SNIPPET) })
    TAG_START.lastIndex = end // skip nested tags so one element stays one record
  }
  // Variants/config objects live outside JSX tags. Count those too, but skip
  // any that sit inside a tag we already emitted (spans are sorted + disjoint).
  let s = 0
  FRAMER_VARIANT.lastIndex = 0
  for (const v of text.matchAll(FRAMER_VARIANT)) {
    while (s < spans.length && spans[s][1] <= v.index) s++
    if (s < spans.length && spans[s][0] <= v.index) continue
    hits.push({ index: v.index, snippet: snippetAt(text, v.index, v[0]) })
  }
  return hits.sort((a, b) => a.index - b.index)
}

// ---- scan ------------------------------------------------------------------
const records = []
let filesScanned = 0

for (const repoArg of repos) {
  const repoPath = resolve(repoArg)
  const repo = basename(repoPath)
  const files = walk(repoPath)
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    filesScanned++
    const isCss = extname(file) === '.css'
    const rules = isCss ? CSS_RULES : CODE_RULES
    const rel = relative(repoPath, file) || basename(file)
    const offsets = newlineOffsets(text)
    for (const { kind, re } of rules) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        records.push({
          repo,
          file: rel,
          kind,
          line: lineOf(offsets, m.index),
          snippet: snippetAt(text, m.index, m[0]),
        })
      }
    }
    if (!isCss) {
      for (const h of collectFramer(text)) {
        records.push({
          repo,
          file: rel,
          kind: 'framer',
          line: lineOf(offsets, h.index),
          snippet: h.snippet,
        })
      }
    }
  }
}

// ---- output ----------------------------------------------------------------
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'motion-corpus-raw.json')
writeFileSync(outFile, JSON.stringify(records, null, 2))

const tally = (key) => records.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc }, {})
const table = (label, counts) => {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
  console.log(`\n${label}`)
  if (!rows.length) { console.log('  (none)'); return }
  const w = Math.max(...rows.map(([k]) => k.length))
  for (const [k, n] of rows) console.log(`  ${k.padEnd(w)}  ${n}`)
}

console.log(`motion corpus -> ${outFile}`)
console.log(`files scanned: ${filesScanned}   records: ${records.length}`)
table('by kind:', tally('kind'))
table('by repo:', tally('repo'))
if (!records.length) console.log('\nNo animation call sites found — check the repo paths before going further.')
