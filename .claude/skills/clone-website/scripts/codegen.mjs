#!/usr/bin/env node
/**
 * clone-website — fragment codegen (opencode skill)
 *
 * Three of the four shared files in a clone run are contention points: every
 * builder wants to add its `@import` to `globals.css`, its icon to the icons
 * barrel, and its section mount to `page.tsx`. Concurrent hand-edits to those
 * files are the single largest source of merge conflicts and lost work.
 *
 * This script removes the contention by demoting all three to GENERATED
 * ARTIFACTS derived from per-builder-owned fragment folders. Builders only ever
 * write inside a folder they exclusively own; codegen assembles the shared file.
 *
 * Fragment conventions
 * --------------------
 *   src/sections/<section-name>/
 *     <Anything>.tsx        the section component (filename is free)
 *     section.css           OPTIONAL, scoped `@layer components` rules only
 *     section.meta.json     { "order": <number>,
 *                             "componentName": "<PascalCaseExportedName>",
 *                             "importPath": "<path relative to src/app/page.tsx>" }
 *
 *   src/components/icons/
 *     <IconName>.tsx        one self-contained named export per file (barrelled)
 *
 *   src/sections/<section-name>/icons/
 *     <IconName>.tsx        section-private icons; not barrelled, but checked
 *                           for export-name collisions against every other icon
 *
 * Generated artifacts
 * -------------------
 *   src/app/globals.css          section.css `@import`s, alphabetical by section
 *   src/components/icons/index.ts  barrel re-exporting every icon file
 *   src/app/page.tsx             section imports + JSX mounts, ascending `order`
 *
 * Everything outside the BEGIN/END markers in those files is preserved verbatim.
 * Markers are created automatically if absent.
 *
 * Validation (soft; WARN without `--check`, FATAL with `--check`)
 *   - two sections claiming the same `order` slot
 *   - two icon files exporting the same name (shared OR section-local)
 *   - a `section.css` containing `:root` or `@theme` (design tokens are frozen
 *     earlier in the pipeline; sections may only add scoped component rules)
 *   - the same top-level selector declared by two different `section.css` files:
 *     they share one `layer(components)` cascade, so the alphabetically-last
 *     `@import` silently wins and the other section loses its rule
 *
 * Validation (hard; FATAL in every mode — the run writes nothing)
 *   - `src/components/icons.tsx` still exists (retired; it shadows the
 *     `src/components/icons/` barrel in TypeScript module resolution)
 *   - malformed / missing `section.meta.json`, i.e. any of the three required
 *     fields (`order`, `componentName`, `importPath`) missing or wrong-typed.
 *     Dropping such a section would silently delete it from `page.tsx`.
 *   - a section component that `import`s its own `./section.css`. codegen already
 *     imports it into globals.css inside `layer(components)`; the component-level
 *     import ships a second UNLAYERED copy, which beats every Tailwind utility
 *     used in that same section regardless of specificity.
 *   - a generated target is not writable (locked). All targets are checked
 *     before the first write, so a run is all-or-nothing, never partial.
 *
 * Usage:
 *   node codegen.mjs <root> [--check]
 *
 * Exit codes:
 *   0  ok (files written, or `--check` found no drift and no violations)
 *   1  hard validation failure, locked target, or `--check` drift/violation
 *   2  bad usage / unusable project root
 *
 * Pure Node — no deps.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, accessSync, constants } from 'node:fs'
import { resolve, join, basename, extname, dirname } from 'node:path'

// ---- markers ---------------------------------------------------------------
const CSS_BEGIN = '/* BEGIN GENERATED SECTION IMPORTS */'
const CSS_END = '/* END GENERATED SECTION IMPORTS */'
const PAGE_IMPORT_BEGIN = '// BEGIN GENERATED SECTION IMPORTS'
const PAGE_IMPORT_END = '// END GENERATED SECTION IMPORTS'
const PAGE_JSX_BEGIN = '{/* BEGIN GENERATED SECTIONS */}'
const PAGE_JSX_END = '{/* END GENERATED SECTIONS */}'

// ---- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2)
const check = argv.includes('--check')
const positional = argv.filter((a) => !a.startsWith('--'))
const die = (msg, code = 2) => {
  console.error(msg)
  process.exit(code)
}

if (positional.length === 0) die('Usage: codegen.mjs <root> [--check]')
const root = resolve(positional[0])
if (!existsSync(root) || !statSync(root).isDirectory()) die(`Error: root is not a directory: ${root}`)

const SECTIONS_DIR = join(root, 'src', 'sections')
const ICONS_DIR = join(root, 'src', 'components', 'icons')
const GLOBALS_CSS = join(root, 'src', 'app', 'globals.css')
const PAGE_TSX = join(root, 'src', 'app', 'page.tsx')
const LEGACY_ICONS = join(root, 'src', 'components', 'icons.tsx')

const rel = (p) => p.slice(root.length + 1)

// ---- problem collection ----------------------------------------------------
/** @type {{code: string, where: string, message: string, fatal: boolean}[]} */
const problems = []
/** `fatal` problems abort the whole run in every mode — nothing is written. */
const problem = (code, where, message, fatal = false) => problems.push({ code, where, message, fatal })

// ---- hard gate: the retired icons.tsx barrel -------------------------------
// TypeScript resolves `src/components/icons.tsx` before `src/components/icons/`,
// so the file's mere existence silently breaks every import from the new barrel
// (TS2305: has no exported member). It is not a benign leftover.
if (existsSync(LEGACY_ICONS) && statSync(LEGACY_ICONS).isFile()) {
  die(
    `codegen: ${rel(LEGACY_ICONS)} still exists and will silently break icon imports from src/components/icons/ ` +
      `(TypeScript resolves the file before the directory). ` +
      `Delete it and move its exports into src/components/icons/<IconName>.tsx files.`,
    1,
  )
}

// ---- small helpers ---------------------------------------------------------
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Blank out comments while preserving line structure, so regex scans don't
 *  trip over commented-out code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function readDirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Replace the lines between `begin` and `end` markers with `inner`, matching the
 * marker's own indentation. Returns `{ ok, text, reason }`.
 */
function replaceBlock(source, begin, end, inner) {
  const lines = source.split('\n')
  const beginIdx = lines.findIndex((l) => l.trim() === begin)
  const endIdx = lines.findIndex((l) => l.trim() === end)
  if (beginIdx === -1 || endIdx === -1) return { ok: false, reason: 'markers-missing' }
  if (endIdx < beginIdx) return { ok: false, reason: 'markers-inverted' }
  const indent = lines[beginIdx].match(/^\s*/)[0]
  const body = inner.map((l) => (l === '' ? '' : indent + l))
  const next = [...lines.slice(0, beginIdx), indent + begin, ...body, indent + end, ...lines.slice(endIdx + 1)]
  return { ok: true, text: next.join('\n') }
}

const hasMarkers = (source, begin, end) => {
  const lines = source.split('\n')
  return lines.some((l) => l.trim() === begin) && lines.some((l) => l.trim() === end)
}

// ---- discovery: sections ---------------------------------------------------
function loadSections() {
  const out = []
  if (!existsSync(SECTIONS_DIR)) return out

  for (const entry of readDirSafe(SECTIONS_DIR)) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const dir = join(SECTIONS_DIR, name)
    const metaPath = join(dir, 'section.meta.json')

    // A section whose metadata cannot be read is never "skipped" quietly: it would
    // vanish from page.tsx with no visible failure. Every problem below is fatal.
    if (!existsSync(metaPath)) {
      problem('meta-missing', rel(dir), `section "${name}" has no section.meta.json — required fields: order, componentName, importPath`, true)
      continue
    }

    let meta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch (e) {
      problem('meta-malformed', rel(metaPath), `section "${name}": unparseable JSON: ${String((e && e.message) || e)}`, true)
      continue
    }

    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      problem('meta-malformed', rel(metaPath), `section "${name}": expected a JSON object`, true)
      continue
    }

    let usable = true
    if (typeof meta.order !== 'number' || !Number.isFinite(meta.order)) {
      problem('meta-order', rel(metaPath), `section "${name}": "order" must be a finite number, got ${JSON.stringify(meta.order)}`, true)
      usable = false
    }
    if (typeof meta.componentName !== 'string' || !IDENT.test(meta.componentName)) {
      problem('meta-component', rel(metaPath), `section "${name}": "componentName" must be a valid identifier, got ${JSON.stringify(meta.componentName)}`, true)
      usable = false
    }
    if (typeof meta.importPath !== 'string' || meta.importPath.trim() === '') {
      problem('meta-import', rel(metaPath), `section "${name}": "importPath" must be a non-empty string, got ${JSON.stringify(meta.importPath)}`, true)
      usable = false
    }
    if (!usable) continue

    const cssPath = join(dir, 'section.css')
    const hasCss = existsSync(cssPath) && statSync(cssPath).isFile()
    if (hasCss) {
      lintSectionCss(cssPath, name)

      // codegen already `@import`s this section.css into globals.css inside
      // `layer(components)`. A component-level `import "./section.css"` ships a
      // SECOND, UNLAYERED copy — and unlayered CSS beats every `@layer utilities`
      // rule regardless of specificity, so the duplicate silently overrides the
      // Tailwind utilities used in this very section's JSX. Always fatal.
      for (const f of readDirSafe(dir)) {
        if (!f.isFile() || extname(f.name) !== '.tsx') continue
        const src = stripComments(readFileSync(join(dir, f.name), 'utf8'))
        if (/import\s+['"]\.\/section\.css['"]/.test(src)) {
          problem(
            'css-double-import',
            `${rel(dir)}/${f.name}`,
            'imports ./section.css directly. codegen already imports it into globals.css inside layer(components); ' +
              'a component-level import ships it a second time UNLAYERED, where it beats every Tailwind utility. Remove the import.',
            true,
          )
        }
      }
    }

    out.push({
      name,
      order: meta.order,
      componentName: meta.componentName,
      importPath: meta.importPath.trim(),
      hasCss,
    })
  }

  // duplicate `order` slots
  const byOrder = new Map()
  for (const s of out) {
    if (!byOrder.has(s.order)) byOrder.set(s.order, [])
    byOrder.get(s.order).push(s.name)
  }
  for (const [order, names] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    if (names.length > 1) {
      problem('duplicate-order', 'src/sections', `order ${order} claimed by ${names.sort().join(', ')} — each section needs a unique slot`)
    }
  }

  // Every section.css lands in the same `layer(components)` cascade, so the same
  // selector declared by two sections is a silent cross-section override: last
  // `@import` alphabetically wins and the other section quietly loses its rule.
  for (const [selector, owners] of [...cssSelectorOwners.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (owners.size > 1) {
      problem(
        'duplicate-class-selector',
        'src/sections',
        `selector \`${selector}\` declared by ${[...owners].sort().join(', ')} — every section.css shares one layer(components) cascade, ` +
          'so the alphabetically-last @import silently wins. Prefix section selectors with the section name to keep them scoped.',
      )
    }
  }

  return out
}

/** selector → Set<section name> across every section.css, for collision detection. */
const cssSelectorOwners = new Map()

/** Selectors that are legitimately shared / already policed elsewhere. */
const SELECTOR_COLLISION_IGNORE = new Set([':root', '*', 'html', 'body', 'from', 'to'])

/**
 * Shallow top-level selector scan. Walks braces so rules wrapped in at-rules
 * (`@layer components { ... }`, `@media { ... }`) still count as top-level, while
 * nested rules inside another style rule are skipped. Not a real CSS parser —
 * same rigor level as the `:root`/`@theme` checks above.
 */
function topLevelSelectors(src) {
  const out = new Set()
  /** @type {('at'|'rule')[]} */
  const stack = []
  let buf = ''
  for (const ch of src) {
    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      if (prelude.startsWith('@')) {
        stack.push('at')
        continue
      }
      const nested = stack.includes('rule')
      stack.push('rule')
      if (nested) continue
      for (const part of prelude.split(',')) {
        const sel = part.trim().replace(/\s+/g, ' ')
        if (sel && !SELECTOR_COLLISION_IGNORE.has(sel)) out.add(sel)
      }
    } else if (ch === '}') {
      stack.pop()
      buf = ''
    } else if (ch === ';') {
      buf = ''
    } else {
      buf += ch
    }
  }
  return [...out]
}

/** Sections may only add scoped component rules — token layers are frozen. */
function lintSectionCss(cssPath, sectionName) {
  const src = stripComments(readFileSync(cssPath, 'utf8'))
  src.split('\n').forEach((line, i) => {
    if (/(^|[\s,{}>+~])(:root)\b/.test(line)) {
      problem('css-token-rule', `${rel(cssPath)}:${i + 1}`, 'section.css may not declare `:root` — design tokens are frozen; use scoped `@layer components` rules')
    }
    if (/@theme\b/.test(line)) {
      problem('css-token-rule', `${rel(cssPath)}:${i + 1}`, 'section.css may not declare `@theme` — design tokens are frozen; use scoped `@layer components` rules')
    }
  })

  for (const sel of topLevelSelectors(src)) {
    if (!cssSelectorOwners.has(sel)) cssSelectorOwners.set(sel, new Set())
    cssSelectorOwners.get(sel).add(sectionName)
  }
}

// ---- discovery: icons ------------------------------------------------------
/** Pull the named exports out of an icon module (ignores `export default`). */
function parseExportNames(src) {
  const clean = stripComments(src)
  const names = new Set()

  const decl = /export\s+(?!default\b)(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
  for (const m of clean.matchAll(decl)) names.add(m[1])

  const listed = /export\s*\{([^}]*)\}/g
  for (const m of clean.matchAll(listed)) {
    for (const raw of m[1].split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '')
      if (!spec) continue
      const asMatch = spec.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/)
      const name = asMatch ? asMatch[1] : spec
      if (IDENT.test(name) && name !== 'default') names.add(name)
    }
  }

  return [...names].sort()
}

/**
 * Section-local icon modules: `src/sections/<section>/icons/<IconName>.tsx`.
 * They are NOT barrelled (they stay private to their section), but they are fed
 * through the same duplicate-export map as the shared icons. Without this, two
 * builders each dropping an `ArrowIcon` into their own section are never compared
 * against each other — the collision only surfaces later, by hand.
 */
function loadSectionIcons() {
  const out = []
  if (!existsSync(SECTIONS_DIR)) return out

  for (const section of readDirSafe(SECTIONS_DIR)) {
    if (!section.isDirectory()) continue
    const iconsDir = join(SECTIONS_DIR, section.name, 'icons')
    if (!existsSync(iconsDir) || !statSync(iconsDir).isDirectory()) continue

    const files = readDirSafe(iconsDir)
      .filter((e) => e.isFile() && extname(e.name) === '.tsx')
      .map((e) => e.name)
      .sort()

    for (const file of files) {
      const full = join(iconsDir, file)
      const names = parseExportNames(readFileSync(full, 'utf8'))
      if (names.length === 0) {
        problem('icon-no-export', rel(full), 'no named export found — icons must expose a self-contained named export')
        continue
      }
      out.push({ file, label: rel(full), stem: basename(file, '.tsx'), names })
    }
  }

  return out
}

function loadIcons() {
  const out = []

  const files = existsSync(ICONS_DIR)
    ? readDirSafe(ICONS_DIR)
        .filter((e) => e.isFile() && extname(e.name) === '.tsx')
        .map((e) => e.name)
        .sort()
    : []

  for (const file of files) {
    const full = join(ICONS_DIR, file)
    const stem = basename(file, '.tsx')
    let names = parseExportNames(readFileSync(full, 'utf8'))
    if (names.length === 0) {
      problem('icon-no-export', rel(full), 'no named export found — icons must expose a self-contained named export')
      continue
    }
    out.push({ file, label: rel(full), stem, names })
  }

  // duplicate export names across files — shared icons AND section-local icons
  // share one namespace here, so same-name clashes are caught wherever they live.
  const owners = new Map()
  for (const icon of [...out, ...loadSectionIcons()]) {
    for (const n of icon.names) {
      if (!owners.has(n)) owners.set(n, [])
      owners.get(n).push(icon.label)
    }
  }
  for (const [name, files_] of [...owners.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (files_.length > 1) {
      const scope = files_.every((f) => f.startsWith('src/components/icons/')) ? 'src/components/icons' : 'src'
      problem('duplicate-icon-export', scope, `export "${name}" declared by ${files_.sort().join(', ')} — icon export names must be unique`)
    }
  }

  return out
}

// ---- artifact: globals.css -------------------------------------------------
/**
 * CSS requires `@import` to precede every rule other than `@charset`/`@layer`,
 * so the block goes directly after the last existing top-level `@import`.
 * With no imports to anchor to, it is appended at the end of the file.
 */
function insertCssMarkers(source) {
  const lines = source.split('\n')
  let insertAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*@(import|charset)\b/.test(lines[i])) insertAt = i + 1
  }
  if (insertAt === -1) return `${source.replace(/\s*$/, '')}\n\n${CSS_BEGIN}\n${CSS_END}\n`
  lines.splice(insertAt, 0, '', CSS_BEGIN, CSS_END)
  return lines.join('\n')
}

function buildGlobalsCss(sections) {
  if (!existsSync(GLOBALS_CSS)) {
    problem('missing-target', rel(GLOBALS_CSS), 'file not found — cannot regenerate section imports')
    return null
  }

  let source = readFileSync(GLOBALS_CSS, 'utf8')
  if (!hasMarkers(source, CSS_BEGIN, CSS_END)) source = insertCssMarkers(source)

  const inner = sections
    .filter((s) => s.hasCss)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `@import "../sections/${name}/section.css" layer(components);`)

  const res = replaceBlock(source, CSS_BEGIN, CSS_END, inner)
  if (!res.ok) {
    problem('marker-error', rel(GLOBALS_CSS), `generated-block markers are ${res.reason}`)
    return null
  }
  return { path: GLOBALS_CSS, content: res.text }
}

// ---- artifact: icons barrel ------------------------------------------------
function buildIconsBarrel(icons) {
  if (!existsSync(ICONS_DIR)) return null

  const lines = [
    '// GENERATED by scripts/codegen.mjs — do not edit by hand.',
    '// Add an icon by creating src/components/icons/<IconName>.tsx, then re-run codegen.',
    '',
  ]
  if (icons.length === 0) {
    lines.push('export {};')
  } else {
    for (const icon of icons) lines.push(`export { ${icon.names.join(', ')} } from "./${icon.stem}";`)
  }

  return { path: join(ICONS_DIR, 'index.ts'), content: lines.join('\n') + '\n' }
}

// ---- artifact: page.tsx ----------------------------------------------------
/** Insert the import markers directly after the last existing import line. */
function ensurePageImportMarkers(source) {
  if (hasMarkers(source, PAGE_IMPORT_BEGIN, PAGE_IMPORT_END)) return source
  const lines = source.split('\n')
  let insertAt = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*import\s/.test(l) || /^\s*}\s*from\s+['"]/.test(l) || /^\s*['"]use (client|server)['"]/.test(l)) {
      insertAt = i + 1
    }
  }
  const block = insertAt === 0 ? [PAGE_IMPORT_BEGIN, PAGE_IMPORT_END, ''] : ['', PAGE_IMPORT_BEGIN, PAGE_IMPORT_END]
  lines.splice(insertAt, 0, ...block)
  return lines.join('\n')
}

/** Insert the JSX markers just inside the closing `</main>` of the page. */
function ensurePageJsxMarkers(source) {
  if (hasMarkers(source, PAGE_JSX_BEGIN, PAGE_JSX_END)) return source
  const lines = source.split('\n')
  const closeIdx = lines.findIndex((l) => l.trim() === '</main>')
  if (closeIdx === -1) {
    problem(
      'marker-error',
      rel(PAGE_TSX),
      `could not auto-insert ${PAGE_JSX_BEGIN} — no standalone </main> line found. Add the markers manually inside the main return JSX.`,
    )
    return null
  }
  const indent = lines[closeIdx].match(/^\s*/)[0] + '  '
  lines.splice(closeIdx, 0, indent + PAGE_JSX_BEGIN, indent + PAGE_JSX_END)
  return lines.join('\n')
}

function buildPageTsx(sections) {
  if (!existsSync(PAGE_TSX)) {
    problem('missing-target', rel(PAGE_TSX), 'file not found — cannot regenerate section mounts')
    return null
  }

  let source = readFileSync(PAGE_TSX, 'utf8')
  source = ensurePageImportMarkers(source)
  source = ensurePageJsxMarkers(source)
  if (source === null) return null

  // Sort by `order`, tie-break on folder name so duplicate slots stay deterministic.
  const ordered = [...sections].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  const importLines = ordered.map((s) => `import { ${s.componentName} } from "${s.importPath}";`)
  const jsxLines = ordered.map((s) => `<${s.componentName} />`)

  const withImports = replaceBlock(source, PAGE_IMPORT_BEGIN, PAGE_IMPORT_END, importLines)
  if (!withImports.ok) {
    problem('marker-error', rel(PAGE_TSX), `import markers are ${withImports.reason}`)
    return null
  }
  const withJsx = replaceBlock(withImports.text, PAGE_JSX_BEGIN, PAGE_JSX_END, jsxLines)
  if (!withJsx.ok) {
    problem('marker-error', rel(PAGE_TSX), `section markers are ${withJsx.reason}`)
    return null
  }

  return { path: PAGE_TSX, content: withJsx.text }
}

// ---- writability preflight -------------------------------------------------
/**
 * Every generated target is checked BEFORE the first write, so a run either
 * rewrites all artifacts or none of them. Writing page.tsx and then dying on a
 * locked globals.css would leave the tree half-regenerated.
 */
function modeOf(p) {
  try {
    return '0' + (statSync(p).mode & 0o7777).toString(8).padStart(3, '0')
  } catch {
    return 'unknown'
  }
}

function assertAllWritable(paths) {
  const locked = []
  for (const p of paths) {
    const target = existsSync(p) ? p : dirname(p)
    try {
      accessSync(target, constants.W_OK)
    } catch {
      locked.push({ path: p, target })
    }
  }
  if (locked.length === 0) return
  for (const l of locked) {
    const what = l.target === l.path ? rel(l.path) : `${rel(l.path)} (parent ${rel(l.target)})`
    console.error(`codegen: ${what} is locked (mode ${modeOf(l.target)}). Run unlock-shared.sh first.`)
  }
  console.error('codegen: nothing was written — generation is all-or-nothing.')
  process.exit(1)
}

// ---- run -------------------------------------------------------------------
const sections = loadSections()
const icons = loadIcons()

const artifacts = [buildGlobalsCss(sections), buildIconsBarrel(icons), buildPageTsx(sections)].filter(Boolean)

// ---- report validation -----------------------------------------------------
const fatals = problems.filter((p) => p.fatal)

if (problems.length > 0) {
  console.error(`\n${problems.length} validation problem${problems.length === 1 ? '' : 's'}:`)
  for (const p of problems) {
    const label = p.fatal || check ? 'ERROR' : 'WARN'
    console.error(`  ${label}  [${p.code}] ${p.where}: ${p.message}`)
  }
  console.error('')
}

if (fatals.length > 0 && !check) {
  console.error(
    `codegen: ${fatals.length} fatal problem${fatals.length === 1 ? '' : 's'} — refusing to generate artifacts that would silently drop a section or break its cascade.`,
  )
  console.error('codegen: nothing was written — fix the file(s) above and re-run.')
  process.exit(1)
}

// ---- write or diff ---------------------------------------------------------
const stale = []
const written = []

if (!check) assertAllWritable(artifacts.map((a) => a.path))

for (const a of artifacts) {
  const current = existsSync(a.path) ? readFileSync(a.path, 'utf8') : null
  if (current === a.content) continue
  if (check) stale.push({ path: a.path, reason: current === null ? 'missing (codegen never run)' : 'out of date' })
  else {
    try {
      writeFileSync(a.path, a.content, 'utf8')
    } catch (e) {
      console.error(`codegen: failed to write ${rel(a.path)}: ${String((e && e.message) || e)}`)
      if (written.length > 0) console.error(`codegen: partially written: ${written.map(rel).join(', ')}`)
      process.exit(1)
    }
    written.push(a.path)
  }
}

console.log(`sections: ${sections.length}  (with section.css: ${sections.filter((s) => s.hasCss).length})`)
console.log(`icons:    ${icons.length}`)

if (check) {
  if (stale.length > 0) {
    console.error('\nDrift detected — these generated artifacts do not match the fragments on disk:')
    for (const s of stale) console.error(`  STALE  ${rel(s.path)} — ${s.reason}`)
    console.error('\nRe-run: node codegen.mjs <root>')
  }
  if (stale.length > 0 || problems.length > 0) process.exit(1)
  console.log('check: clean — generated artifacts are in sync and no violations found.')
  process.exit(0)
}

if (written.length === 0) console.log('unchanged: all generated artifacts already in sync.')
else for (const p of written) console.log(`wrote: ${rel(p)}`)
process.exit(0)
