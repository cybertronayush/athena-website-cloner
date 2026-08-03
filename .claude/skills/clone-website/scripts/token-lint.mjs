#!/usr/bin/env node
/**
 * clone-website — token lint (opencode skill)
 *
 * Guards the emulation against hand-invented values. Every color / spacing /
 * radius / font / font-size / shadow literal hardcoded in source must exist in
 * the tokens lock produced by
 * `inspect.mjs tokens <url> > docs/research/tokens.lock.json`.
 * Anything else is a drift from the target site and gets flagged.
 *
 * A violation can be acknowledged (not fixed, but admitted) by putting the
 * marker `@clone-degraded:` on the offending line or in the 2 lines above it —
 * those land in `degraded[]` instead of `violations[]` and don't fail the run.
 *
 * Values that cannot be checked at all (e.g. `em`, which is relative to the
 * element's own font-size and therefore not comparable to a px-based lock) land
 * in `unverifiable[]` and never fail the run.
 *
 * Usage:
 *   node token-lint.mjs <tokens-lock.json> <source-dir> [--report-only] [--tolerance-px N] [--quiet]
 *
 * Flags:
 *   --report-only     always exit 0 (report drift without blocking)
 *   --tolerance-px N  px slack when matching spacing/radii/fontSizes (default 0.5)
 *   --quiet           suppress the JSON report, print only the summary line
 *
 * Exit codes:
 *   0  clean (or --report-only)
 *   1  violations found
 *   2  bad usage / missing or malformed tokens lock / unreadable source
 *
 * Pure Node — no playwright, no deps.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

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
const N = (v, d) => (v === undefined || v === true ? d : Number(v))
const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const lockPath = positional[0]
const srcDir = positional[1]
if (!lockPath || !srcDir) die('Usage: token-lint.mjs <tokens-lock.json> <source-dir> [--report-only] [--tolerance-px N] [--quiet]', 2)

const tolerancePx = N(flags['tolerance-px'], 0.5)
const reportOnly = !!flags['report-only']
const quiet = !!flags.quiet

// ---- tokens lock -----------------------------------------------------------
const REQUIRED_BUCKETS = ['colors', 'spacing', 'radii', 'fonts', 'shadows']
const OPTIONAL_BUCKETS = ['fontSizes']
const BUCKETS = [...REQUIRED_BUCKETS, ...OPTIONAL_BUCKETS]

let lock
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'))
} catch (e) {
  die(`Error: tokens.lock.json is missing or malformed — expected keys: ${REQUIRED_BUCKETS.join(', ')}. Got: <unreadable: ${String((e && e.message) || e)}>`, 2)
}

// Bug 7: a malformed / empty lock used to silently flag every literal in the
// codebase. Validate up front and bail with a distinct exit code instead.
{
  const keys = lock && typeof lock === 'object' && !Array.isArray(lock) ? Object.keys(lock) : []
  const missing = REQUIRED_BUCKETS.filter((b) => !Array.isArray(lock && lock[b]))
  if (missing.length) {
    die(`Error: tokens.lock.json is missing or malformed — expected keys: ${REQUIRED_BUCKETS.join(', ')}. Got: ${keys.length ? keys.join(', ') : '(none)'}`, 2)
  }
  // Bug C: all five required buckets present but ALL empty is the same practical
  // failure as a missing lock — every literal in source would get flagged.
  const totalTokens = REQUIRED_BUCKETS.reduce((sum, b) => sum + lock[b].length, 0)
  if (totalTokens === 0) {
    die("Error: tokens.lock.json has all required buckets empty — check --min-count wasn't set too high on the tokens scan, or the scan ran against a near-empty page.", 2)
  }
}

// Bug 4: fontSizes only exists in newer locks. Absent => skip the rule entirely.
const hasFontSizes = Array.isArray(lock.fontSizes)

const norm = (v) => String(v).trim().replace(/\s+/g, ' ').toLowerCase()

// ---- color canonicalisation ------------------------------------------------
// The lock holds computed colors (mostly `rgb()`/`rgba()`, but Chrome also
// hands back `oklab()` for some values); source holds hex, and the project's
// own design tokens are oklch (Tailwind v4). Everything has to collapse to one
// comparable representation or the rule is useless.

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// Björn Ottosson's OKLab -> linear sRGB -> sRGB.
// This is the shared tail for BOTH ok* functions: oklch is just oklab in polar
// form, so `oklchToRgb` converts C/H to the rectangular a/b axes and delegates
// here. Keeping one copy of the matrix guarantees the two syntaxes can never
// drift apart and disagree about the same color.
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  const toSrgb = (c) => {
    c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055
    return Math.round(Math.max(0, Math.min(1, c)) * 255)
  }
  return [toSrgb(r), toSrgb(g), toSrgb(bl)]
}

// polar (chroma + hue) -> rectangular (a/b), then the shared conversion above.
function oklchToRgb(L, C, H) {
  const hRad = (H * Math.PI) / 180
  return oklabToRgb(L, C * Math.cos(hRad), C * Math.sin(hRad))
}

const num = (t) => {
  const n = parseFloat(String(t).replace(/deg$/, ''))
  return Number.isFinite(n) ? n : null
}
const pct = (t) => {
  const s = String(t).trim()
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  return s.endsWith('%') ? n / 100 : (n > 1 ? n / 100 : n)
}
const alphaOf = (t) => {
  if (t === undefined || t === null || t === '') return 1
  const s = String(t).trim()
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return 1
  return s.endsWith('%') ? n / 100 : n
}
const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)))
const round3 = (n) => Math.round(n * 1000) / 1000

// oklab/oklch lightness: a plain 0-1 float, or a percentage of 1.
// NaN falls through to the Number.isFinite guard at each call site.
const okL = (t) => {
  const s = String(t).trim()
  const n = parseFloat(s)
  return s.endsWith('%') ? n / 100 : n
}
// oklab a/b axes: a plain SIGNED float (roughly -0.4..0.4), or a percentage
// where the spec pins 100% to 0.4.
const okAB = (t) => {
  const s = String(t).trim()
  const n = parseFloat(s)
  return s.endsWith('%') ? (n / 100) * 0.4 : n
}

/**
 * -> { r, g, b, a, approx } | null
 * `approx` marks values that went through a lossy conversion (hsl/oklch/oklab), so
 * comparisons against them get a small per-channel tolerance. hex-vs-rgb stays
 * exact — no rounding is involved there.
 */
function parseColor(v) {
  const s = norm(v).replace(/_/g, ' ')

  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
    const a = h.length === 8 ? round3(parseInt(h.slice(6, 8), 16) / 255) : 1
    return { r, g, b, a, approx: false }
  }

  const fn = /^([a-z]+)\(([^)]+)\)$/.exec(s)
  if (!fn) return null
  const name = fn[1]
  const raw = fn[2]
  // CSS4 allows `fn(a b c / alpha)` as well as `fn(a, b, c, alpha)`.
  const slash = raw.split('/')
  const head = slash[0]
  const tailAlpha = slash.length > 1 ? slash[1] : undefined
  const parts = head.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean)

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) return null
    const [r, g, b] = parts.slice(0, 3).map((p) => parseFloat(p))
    if (![r, g, b].every(Number.isFinite)) return null
    const a = tailAlpha !== undefined ? alphaOf(tailAlpha) : (parts.length > 3 ? alphaOf(parts[3]) : 1)
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: round3(a), approx: false }
  }

  if (name === 'hsl' || name === 'hsla') {
    if (parts.length < 3) return null
    const h = num(parts[0]); const sat = pct(parts[1]); const li = pct(parts[2])
    if (h === null || sat === null || li === null) return null
    const [r, g, b] = hslToRgb(h, sat, li)
    const a = tailAlpha !== undefined ? alphaOf(tailAlpha) : (parts.length > 3 ? alphaOf(parts[3]) : 1)
    return { r, g, b, a: round3(a), approx: true }
  }

  if (name === 'oklch') {
    if (parts.length < 2) return null
    const L = okL(parts[0])
    const C = parseFloat(parts[1])
    const H = parts.length > 2 ? (num(parts[2]) ?? 0) : 0
    if (![L, C, H].every(Number.isFinite)) return null
    const [r, g, b] = oklchToRgb(L, C, H)
    const a = tailAlpha !== undefined ? alphaOf(tailAlpha) : (parts.length > 3 ? alphaOf(parts[3]) : 1)
    return { r, g, b, a: round3(a), approx: true }
  }

  // Bug G: Chrome's getComputedStyle returns `oklab(L a b / alpha)` for some
  // colors — in practice the semi-transparent black/white overlays — so a real
  // tokens lock contains oklab entries verbatim. With no branch here they fell
  // through to `norm()` as an opaque string and could never match ANYTHING,
  // including the identical color written as oklch(). For an achromatic color
  // the two are the same point (C=0/H=0 <=> a=0,b=0), so the equivalence has to
  // hold through the shared oklabToRgb tail.
  if (name === 'oklab') {
    if (parts.length < 3) return null
    const L = okL(parts[0])
    const A = okAB(parts[1])
    const B = okAB(parts[2])
    if (![L, A, B].every(Number.isFinite)) return null
    const [r, g, b] = oklabToRgb(L, A, B)
    const a = tailAlpha !== undefined ? alphaOf(tailAlpha) : (parts.length > 3 ? alphaOf(parts[3]) : 1)
    return { r, g, b, a: round3(a), approx: true }
  }

  return null
}

const canonColor = (v) => {
  const c = parseColor(v)
  return c ? `${c.r},${c.g},${c.b},${c.a}` : norm(v)
}

const CHANNEL_SLACK = 2
// Bug B: 8-bit hex alpha (`#ffffffb8` -> 184/255 = 0.722) can never exactly
// equal a 2-decimal CSS alpha (`0.72`), so string/exact comparison guarantees a
// false positive. The alpha epsilon is therefore UNIVERSAL — it applies to
// exact (hex/rgb) comparisons as well as lossy (hsl/oklch/oklab) ones. RGB channels
// keep their old behaviour: exact for hex/rgb, +/-2 only when a lossy
// conversion was involved.
const ALPHA_EPS = 0.01
const colorsClose = (a, b) => {
  if (Math.abs(a.a - b.a) > ALPHA_EPS) return false
  const slack = a.approx || b.approx ? CHANNEL_SLACK : 0
  return (
    Math.abs(a.r - b.r) <= slack &&
    Math.abs(a.g - b.g) <= slack &&
    Math.abs(a.b - b.b) <= slack
  )
}

const canon = (bucket, v) => (bucket === 'colors' ? canonColor(v) : norm(v))

// ---- allowed sets ----------------------------------------------------------
const lockValues = (b) => (Array.isArray(lock[b]) ? lock[b] : []).map((t) => (t && t.value !== undefined ? t.value : t))

const allowed = {}
for (const b of BUCKETS) allowed[b] = new Set(lockValues(b).map((v) => canon(b, v)))

// Bug 1: the lock stores a full computed font stack as ONE string
// (`Satoshi, "Helvetica Neue", Arial, sans-serif`). Source declares a single
// bare family. Flatten the stacks into individual family names.
const allowedFonts = new Set()
for (const v of lockValues('fonts')) {
  for (const piece of String(v).split(',')) {
    const fam = piece.trim().replace(/^["']|["']$/g, '').trim().toLowerCase()
    if (fam) allowedFonts.add(fam)
  }
}

// Colors kept in parsed form too, so lossy (hsl/oklch) values can be compared
// with per-channel slack instead of string equality.
const allowedColors = lockValues('colors').map(parseColor).filter(Boolean)

// numeric side-tables for the px-ish buckets (a lock value like "16px" or
// "8px 12px" contributes every number it holds — a compound literal is fine)
const PX_BUCKETS = new Set(['spacing', 'radii', 'fontSizes'])
const numsIn = (v) => [...String(v).matchAll(/-?\d*\.?\d+/g)].map((m) => parseFloat(m[0])).filter((n) => Number.isFinite(n))

// Bug 5: `em` is relative to the element's own font-size, so it can never be
// converted to px without context. It is NOT handled here — see relativeUnitOf.
const toPx = (v) => {
  const m = /^(-?\d*\.?\d+)\s*(px|rem|em|%|vh|vw)?$/.exec(String(v).trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2] || 'px'
  if (unit === 'px') return n
  if (unit === 'rem') return n * 16
  return null // em, %, vh, vw aren't comparable to computed px
}

// Bug H: `toPx` refuses FOUR units, but only `em` was ever routed to
// unverifiable[] — `vh` / `vw` / `%` fell through and were reported as hard
// violations with a useless `nearestAllowed: null`. Every one of these resolves
// at runtime against something the lint cannot see: the element's own font-size
// (em), the containing block (%), or the viewport (vh/vw). Same class, same
// treatment. `rem` is deliberately absent — it is absolute (16px) and toPx
// converts it, so it stays fully verifiable.
// Returns the unit string (for the note) or null.
const relativeUnitOf = (v) => {
  const m = /^-?\d*\.?\d+\s*(em|vh|vw|%)$/.exec(String(v).trim())
  return m ? m[1] : null
}

// Bug F: a value built out of a CSS custom property (`var(--inset-shadow)`)
// has no literal lengths or colors to compare, so it can never match a
// computed-style lock. That is "cannot verify", not "wrong".
// Note the underscore decode first: in `shadow-[0_4px_var(--blur)_red]` the
// `var(` is preceded by `_`, which is a word char, so `\b` would never fire.
const hasCssVar = (v) => /(?:^|[^a-z0-9_-])var\(/i.test(String(v).replace(/_/g, ' '))

const allowedNums = {}
for (const b of PX_BUCKETS) allowedNums[b] = [...new Set([...allowed[b]].flatMap(numsIn))].sort((a, b2) => a - b2)

const nearest = (bucket, value) => {
  if (!PX_BUCKETS.has(bucket)) return null
  const px = toPx(value)
  const pool = allowedNums[bucket] || []
  if (px === null || !pool.length) return null
  let best = pool[0]
  for (const n of pool) if (Math.abs(n - px) < Math.abs(best - px)) best = n
  return `${best}px`
}

// ---- shadow matching -------------------------------------------------------
// Bug 2: Tailwind arbitrary shadows are offset-first with underscores
// (`shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]`); Chrome's computed boxShadow is
// color-first with spaces (`rgba(0, 0, 0, 0.08) 0px 4px 12px 0px`). String
// equality can never match. Compare color + ordered length sequence instead.
// Bug G: `okl(?:ab|ch)` — a computed box-shadow can carry an oklab() color just
// like a plain color property can. Without oklab here the lock side of
// shadowsMatch extracts no color at all and the `!!fc !== !!lc` guard rejects
// every candidate outright.
const COLOR_TOKEN = /rgba?\([^)]+\)|hsla?\([^)]+\)|okl(?:ab|ch)\([^)]+\)|#[0-9a-fA-F]{3,8}/

const lengthSeq = (s) => String(s)
  .replace(/_/g, ' ')
  .split(/\s+/)
  .map((t) => t.trim())
  .filter(Boolean)
  .map(toPx)
  .filter((n) => n !== null)

// CSS shorthand order is `offset-x offset-y blur spread`; blur and spread both
// default to 0 and always TRAIL the offsets, so a 3-value authored shadow is
// semantically the 4-value computed one with a zero spread. Pad, don't reject.
const SHADOW_SLOTS = 4
const padLengths = (seq, width) => {
  const out = seq.slice()
  while (out.length < width) out.push(0)
  return out
}

// Bug 10: a shadow property holds a COMMA-SEPARATED LIST of layers, and a real
// computed lock entry is routinely multi-layer (Tailwind's `shadow-*` utilities
// alone emit five). `shadowsMatch` flattens whatever it is handed into ONE color
// + one ordered length run, so a single authored layer could never line up with
// a multi-layer lock entry, and vice versa. Split both sides into layers first.
// Commas inside a function call (`rgba(0, 0, 0, .5)`) are NOT layer separators,
// so track paren depth rather than doing a naive `.split(',')`.
const shadowLayers = (v) => {
  const s = String(v).replace(/_/g, ' ')
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out.map((p) => p.trim()).filter(Boolean)
}

function shadowsMatch(found, lockValue, tolerance = tolerancePx) {
  const f = String(found).replace(/_/g, ' ')
  const l = String(lockValue)

  // 0. `inset` flips the shadow inside the box — an inset shadow can never be
  // the same token as an outer one, however well the lengths and color line up.
  if (f.toLowerCase().includes('inset') !== l.toLowerCase().includes('inset')) return false

  const fc = COLOR_TOKEN.exec(f)
  const lc = COLOR_TOKEN.exec(l)

  // 1. color component must canonicalise to the same thing
  if (!!fc !== !!lc) return false
  let fRest = f
  let lRest = l
  if (fc && lc) {
    const a = parseColor(fc[0])
    const b = parseColor(lc[0])
    if (!a || !b) { if (canonColor(fc[0]) !== canonColor(lc[0])) return false }
    else if (!colorsClose(a, b)) return false
    fRest = fRest.slice(0, fc.index) + ' ' + fRest.slice(fc.index + fc[0].length)
    lRest = lRest.slice(0, lc.index) + ' ' + lRest.slice(lc.index + lc[0].length)
  }

  // 2. remaining numeric lengths must line up positionally, within tolerance,
  // after zero-padding the shorter sequence out to the full 4 slots
  const fnRaw = lengthSeq(fRest)
  const lnRaw = lengthSeq(lRest)
  if (fnRaw.length === 0 || lnRaw.length === 0) return false
  const width = Math.max(SHADOW_SLOTS, fnRaw.length, lnRaw.length)
  const fn = padLengths(fnRaw, width)
  const ln = padLengths(lnRaw, width)
  for (let i = 0; i < width; i++) if (Math.abs(fn[i] - ln[i]) > tolerance) return false
  return true
}

const lockShadows = lockValues('shadows')
const lockShadowLayers = lockShadows.flatMap(shadowLayers)

// Bug 10: a raw-CSS shadow is authored by hand, so unlike a computed lock value
// it can legally hold things this lint simply cannot resolve: relative lengths
// (`0 0.5em 1em`), named/keyword colors (`black`, `currentColor`) which
// parseColor() does not implement, or `calc()`. Every one of those makes
// shadowsMatch() answer "no match" for a reason that has nothing to do with
// drift — a guaranteed false positive. Detect them and fail SAFE, following the
// same precedent as Bug H: this is consulted only AFTER isAllowed() has already
// failed, so a value that genuinely matches the lock still passes cleanly.
// Returns a note string (-> unverifiable[]) or null (-> verifiable as normal).
const SHADOW_KEYWORDS = new Set(['inset'])
const shadowAmbiguity = (value) => {
  for (const layer of shadowLayers(value)) {
    let rest = layer
    const c = COLOR_TOKEN.exec(rest)
    if (c) rest = rest.slice(0, c.index) + ' ' + rest.slice(c.index + c[0].length)
    for (const t of rest.split(/\s+/).map((x) => x.trim()).filter(Boolean)) {
      if (SHADOW_KEYWORDS.has(t.toLowerCase())) continue
      if (toPx(t) !== null) continue // plain px/rem length — fully comparable
      const unit = relativeUnitOf(t)
      if (unit) return `shadow length uses a relative/contextual unit (${unit}), cannot verify against a static px-based lock`
      return `shadow contains a token this lint cannot resolve to a px length or a parseable color (${t}), cannot verify against a static lock`
    }
  }
  return null
}

// ---- allow check -----------------------------------------------------------
// `underscoreAsSpace` is set by BOTH font rules. A Tailwind arbitrary value is
// part of a whitespace-delimited class name, so a literal space cannot survive
// in either form — quoting changes nothing about that. Both `font-[Helvetica_Neue]`
// and `font-['Helvetica_Neue']` therefore mean `Helvetica Neue` and must be
// decoded before the allowedFonts membership check.
const isAllowed = (bucket, value, underscoreAsSpace = false) => {
  if (bucket === 'fonts') {
    return allowedFonts.has(norm(underscoreAsSpace ? String(value).replace(/_/g, ' ') : value))
  }

  if (bucket === 'colors') {
    if (allowed.colors.has(canonColor(value))) return true
    const c = parseColor(value)
    if (!c) return false
    // colorsClose covers both paths now: oklch/hsl round-trips get +/-2 per
    // channel, hex/rgb stay exact, and alpha always gets ALPHA_EPS.
    return allowedColors.some((L) => colorsClose(c, L))
  }

  if (bucket === 'shadows') {
    if (allowed.shadows.has(norm(value))) return true
    if (lockShadows.some((lv) => shadowsMatch(value, lv))) return true
    // Bug 10: layer-wise fallback. Every authored layer has to exist as a layer
    // of SOME measured lock shadow. This can only ever WIDEN what passes (it
    // runs after the whole-value comparison already failed), so it cannot turn
    // a previously-clean value into a violation.
    if (!lockShadowLayers.length) return false
    const found = shadowLayers(value)
    if (!found.length) return false
    return found.every((layer) => lockShadowLayers.some((ll) => shadowsMatch(layer, ll)))
  }

  const v = norm(value)
  if (allowed[bucket] && allowed[bucket].has(canon(bucket, value))) return true
  if (!PX_BUCKETS.has(bucket)) return false
  const px = toPx(v)
  if (px === null) return false
  return (allowedNums[bucket] || []).some((n) => Math.abs(n - px) <= tolerancePx)
}

// ---- file walking ----------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'out', 'coverage'])
const JSX_EXTS = new Set(['.tsx', '.ts', '.jsx', '.js'])
const CSS_EXTS = new Set(['.css'])
const EXTS = new Set([...JSX_EXTS, ...CSS_EXTS])

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

const collect = (target) => {
  let st
  try { st = statSync(target) } catch (e) { die(`Error: cannot read source path ${target}: ${String((e && e.message) || e)}`, 2) }
  if (st.isDirectory()) return walk(target)
  return EXTS.has(extname(target)) ? [target] : []
}

// ---- violation patterns ----------------------------------------------------
// Bug E: the unquoted font rule's "must start with a letter" guard drops
// numeric weights (`font-[600]`) but NOT the CSS-wide keywords or the weight
// keywords, which are letters too. None of these name a family, so none of them
// belong in the fonts rule at all — skip them exactly like `font-[600]`:
// no violation, no pass, not even counted in totalMatches.
const NON_FAMILY_FONT_VALUES = new Set([
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  'bold', 'bolder', 'lighter',
])

// Tailwind arbitrary values: the literal lives in capture group `group` (1 unless noted).
const RULES = [
  { bucket: 'colors', re: /(?:bg|text|border|ring|shadow|from|via|to|fill|stroke|outline|decoration)-\[(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|okl(?:ab|ch)\([^)]+\))\]/g },
  // Bug H: `%` was missing from this unit list, so `w-[80%]` was not merely
  // mis-routed — it was invisible to the linter entirely. Percentage widths and
  // heights are everywhere in real layouts. Adding it cannot introduce a false
  // failure: a `%` value that does not match the lock outright is caught by the
  // relativeUnitOf routing in record() and lands in unverifiable[], never in
  // violations[].
  { bucket: 'spacing', re: /(?:p|m|gap|w|h|top|left|right|bottom|inset|space|size|translate)-(?:[trblxyse]{1,2}-)?\[(-?[0-9.]+(?:px|rem|em|vh|vw|%))\]/g },
  { bucket: 'radii', re: /rounded(?:-[trblse]{1,2})?-\[([0-9.]+(?:px|rem|%))\]/g },
  // Bug 1: only QUOTED arbitrary values are font FAMILIES. `font-[600]` is a
  // weight and must not be considered here at all.
  // `underscoreAsSpace`: the quoted form still lives inside a whitespace-delimited
  // class name, so `font-['Helvetica Neue']` cannot exist — authors write
  // `font-['Helvetica_Neue']` and Tailwind decodes the `_` back to a space.
  { bucket: 'fonts', re: /font-\[(['"])([^'"\]]+)\1\]/g, group: 2, underscoreAsSpace: true },
  // Bug D: the unquoted form `font-[Satoshi]` is just as common and was
  // previously invisible. Requiring a LEADING LETTER excludes `font-[600]`
  // (a weight) with no extra logic, and the leading `['"]` of the quoted rule
  // keeps the two regexes naturally disjoint — no double reporting.
  // Same `_` -> space decoding applies here. `skip` drops the letter-leading
  // non-family values (CSS-wide keywords + weight keywords) — see Bug E above.
  {
    bucket: 'fonts',
    re: /font-\[([A-Za-z][A-Za-z0-9_-]*)\]/g,
    underscoreAsSpace: true,
    skip: (v) => NON_FAMILY_FONT_VALUES.has(String(v).toLowerCase()),
  },
  { bucket: 'shadows', re: /shadow-\[([^\]]+)\]/g },
]
// Bug 4: font-size drift was completely unlinted. Only enabled when the lock
// actually carries a fontSizes bucket.
if (hasFontSizes) RULES.push({ bucket: 'fontSizes', re: /text-\[([0-9.]+(?:px|rem))\]/g })

// Inline `style={{ ... }}` raw literals — deliberately shallow, we only sniff
// the value side of `key: 'literal'` pairs rather than parsing JS.
const STYLE_BLOCK = /style=\{\{([\s\S]{0,600}?)\}\}/g
const STYLE_COLOR = /:\s*['"`]?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|okl(?:ab|ch)\([^)]+\))['"`]?/g
// Bug H: this unit list was still the narrow `px|rem|em` while the Tailwind
// spacing rule above was widened to `px|rem|em|vh|vw|%`. The two describe the
// same thing — a length authored by hand — so an inline `width: '80vw'` was
// invisible here while `w-[80vw]` was caught. Same alternation now. Matches are
// recorded under the `spacing` bucket like every other STYLE_LEN hit, so the
// relativeUnitOf() routing in record() sends vh/vw/%/em to unverifiable[]
// rather than violations[] — no separate code path.
const STYLE_LEN = /(padding|margin|gap|top|left|right|bottom|width|height|fontSize|inset)[A-Za-z]*\s*:\s*['"`](-?[0-9.]+(?:px|rem|em|vh|vw|%))['"`]/g
const STYLE_RADIUS = /borderRadius\s*:\s*['"`]([0-9.]+(?:px|rem|%))['"`]/g

// Bug 8: raw CSS gets its own rule set — Tailwind arbitrary-value syntax does
// not apply to `:root { --brand: #123456 }`.
const CSS_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|okl(?:ab|ch)\([^)]+\)/g

// Bug 10: raw CSS used to be scanned for COLORS ONLY, so a hand-invented
// `box-shadow: 0 4px 12px rgba(0,0,0,.15)` in a `section.css` was never compared
// against the lock's `shadows` bucket at all — while the exact same drift
// written as `shadow-[0_4px_12px_rgba(0,0,0,.15)]` was caught. (The color inside
// it was checked, the geometry was not.) Same bucket, same lock, same
// violation / `@clone-degraded:` / unverifiable machinery — just the other
// syntax. Vendor prefixes included; `[^;{}]+` safely stops at the end of the
// declaration and still spans the multi-line values these routinely have.
//
// Deliberately NOT covered: `filter: drop-shadow(...)`. The lock's shadows
// bucket is built purely from computed `boxShadow` (see inspect.mjs), so it
// holds no drop-shadow data whatsoever — checking one against the other would
// manufacture a violation for every drop-shadow in the codebase.
const CSS_SHADOW = /(?:^|[\s;{])(?:-webkit-|-moz-)?box-shadow\s*:\s*([^;{}]+)/gi

// Shadow keywords that state "no shadow" / defer to the cascade. They name no
// literal, so they are not drift and are skipped outright (not even counted) —
// same precedent as NON_FAMILY_FONT_VALUES in the fonts rule.
const CSS_SHADOW_SKIP = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer'])

// A `/* ... */` comment can contain anything, including a literal
// `box-shadow: ...` inside a `@clone-degraded:` note explaining the drift.
// Blank the comment BODIES out while preserving every byte offset, so the match
// indices (and therefore the reported line numbers, and therefore the
// degraded-marker lookback) stay exact.
const blankComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const DEGRADED_MARKER = '@clone-degraded:'

// Bug 6: `text.slice(0, i).split('\n').length` re-scanned the whole file for
// every match (quadratic). Index newline offsets once, then binary search.
const newlineOffsets = (text) => {
  const offs = []
  let i = text.indexOf('\n')
  while (i !== -1) { offs.push(i); i = text.indexOf('\n', i + 1) }
  return offs
}
const lineOf = (offsets, index) => {
  let lo = 0, hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < index) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

// a marker on the offending line or within the 2 lines above it acknowledges it
const isDegraded = (lines, lineNo) => {
  for (let i = Math.max(0, lineNo - 3); i < lineNo; i++) {
    if (lines[i] && lines[i].includes(DEGRADED_MARKER)) return true
  }
  return false
}
const degradeReason = (lines, lineNo) => {
  for (let i = lineNo - 1; i >= Math.max(0, lineNo - 3); i--) {
    const l = lines[i] || ''
    const at = l.indexOf(DEGRADED_MARKER)
    if (at >= 0) return l.slice(at + DEGRADED_MARKER.length).replace(/[*/}\s]+$/, '').trim() || null
  }
  return null
}

// ---- scan ------------------------------------------------------------------
const files = collect(srcDir)
const violations = []
const degraded = []
const unverifiable = []
let totalMatches = 0

const relativeUnitNote = (unit) => `relative/contextual unit (${unit}), cannot verify against a static px-based lock`
const VAR_SHADOW_NOTE = 'shadow references a CSS variable, cannot verify against a static lock'

// `value` is always recorded AS AUTHORED so the report points at real source
// text; `underscoreAsSpace` only affects the comparison.
const record = (file, lines, offsets, bucket, value, index, underscoreAsSpace = false, ambiguityNote = null) => {
  totalMatches++
  const line = lineOf(offsets, index)
  // Bug F: a var()-based shadow has nothing literal to compare — same
  // non-failing treatment as a relative unit, never a violation.
  if (bucket === 'shadows' && hasCssVar(value)) {
    unverifiable.push({ file, line, bucket, value, note: VAR_SHADOW_NOTE })
    return
  }
  if (isAllowed(bucket, value, underscoreAsSpace)) return
  // Bug H: this sits AFTER isAllowed on purpose. Chrome reports a computed
  // `border-radius: 50%` as the string "50%", so a `%` value CAN legitimately
  // match the lock outright — no unit conversion needed, so it is genuinely
  // verified and must stay a clean pass rather than be demoted to "unknown".
  // Only once a value has failed to match does an unresolvable unit mean
  // "cannot verify" instead of "wrong".
  const relUnit = relativeUnitOf(value)
  if (relUnit) {
    unverifiable.push({ file, line, bucket, value, note: relativeUnitNote(relUnit) })
    return
  }
  // Bug 10: a compound value (a shadow) can be unresolvable for the same class
  // of reason a bare `2em` is, but `relativeUnitOf` only inspects a value that
  // is a single length end to end. The caller supplies the per-bucket verdict.
  // Same ordering rule as above: consulted only after isAllowed() said no.
  if (ambiguityNote) {
    unverifiable.push({ file, line, bucket, value, note: ambiguityNote })
    return
  }
  if (isDegraded(lines, line)) degraded.push({ file, line, bucket, value, reason: degradeReason(lines, line) })
  else violations.push({ file, line, bucket, value, nearestAllowed: nearest(bucket, value) })
}

for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  const offsets = newlineOffsets(text)
  const rel = relative(process.cwd(), file) || file
  const isCss = CSS_EXTS.has(extname(file))

  if (isCss) {
    for (const m of text.matchAll(CSS_COLOR)) record(rel, lines, offsets, 'colors', m[0], m.index)
    // Bug 10: shadows too — see CSS_SHADOW. Comment bodies are blanked (offsets
    // preserved) so a `box-shadow:` written inside an explanatory comment is not
    // mistaken for a declaration.
    const scannable = blankComments(text)
    for (const m of scannable.matchAll(CSS_SHADOW)) {
      const value = norm(m[1].replace(/!\s*important/gi, ''))
      if (!value || CSS_SHADOW_SKIP.has(value)) continue
      // point at the property name, not the whitespace the regex had to consume
      const at = m.index + Math.max(0, m[0].search(/\S/))
      record(rel, lines, offsets, 'shadows', value, at, false, shadowAmbiguity(value))
    }
    continue
  }

  for (const rule of RULES) {
    rule.re.lastIndex = 0
    const g = rule.group || 1
    for (const m of text.matchAll(rule.re)) {
      // skipped values are not matches at all — they never reach totalMatches
      if (rule.skip && rule.skip(m[g])) continue
      record(rel, lines, offsets, rule.bucket, m[g], m.index, !!rule.underscoreAsSpace)
    }
  }

  for (const block of text.matchAll(STYLE_BLOCK)) {
    const body = block[1]
    const base = block.index + block[0].indexOf(body)
    for (const m of body.matchAll(STYLE_COLOR)) record(rel, lines, offsets, 'colors', m[1], base + m.index)
    for (const m of body.matchAll(STYLE_LEN)) record(rel, lines, offsets, 'spacing', m[2], base + m.index)
    for (const m of body.matchAll(STYLE_RADIUS)) record(rel, lines, offsets, 'radii', m[1], base + m.index)
  }
}

// Bug 9: report grouped by rule-bucket is useless for a human walking a diff.
const byFileLine = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
violations.sort(byFileLine)
degraded.sort(byFileLine)
unverifiable.sort(byFileLine)

if (!quiet) {
  console.log(JSON.stringify({
    tokensLock: lockPath,
    source: srcDir,
    tolerancePx,
    filesScanned: files.length,
    totalMatches,
    violationCount: violations.length,
    degradedCount: degraded.length,
    unverifiableCount: unverifiable.length,
    violations,
    degraded,
    unverifiable,
  }, null, 2))
}

// stderr so stdout stays cleanly parseable / pipeable
console.error(`token-lint: ${files.length} files scanned, ${violations.length} violations, ${degraded.length} degraded, ${unverifiable.length} unverifiable`)

process.exitCode = !reportOnly && violations.length > 0 ? 1 : 0
