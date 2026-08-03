#!/usr/bin/env node
/**
 * clone-website — runtime claims + spec-coverage validator (opencode skill)
 *
 * Validates `docs/research/.runtime-claims.json`, the concurrency-coordination
 * ledger the orchestrator maintains across Phase 2 and Phase 3. Every builder's
 * Shared-Scope Contract is rendered from this file, so a ledger that is
 * structurally wrong or stale silently corrupts every subsequent builder prompt.
 *
 * It also enforces the skill's "non-negotiable" spec rule: every section that
 * was actually built (i.e. has a `section.meta.json`) must have a persisted,
 * non-thin `.spec.md` in the components directory. That rule was prose-only
 * until now; on a real 10-section clone only 2 specs had been persisted and
 * nothing caught it.
 *
 * Report arrays:
 *
 *   structuralViolations — the ledger's shape is wrong. A `status` that isn't
 *     exactly "planned" or "installed", an "installed" entry with a null
 *     `owner`/`file`, a malformed `signature_slots` entry (including the
 *     retired flat-number schema, which is reported with an explicit migration
 *     hint), a `shared_files` entry that isn't a string.  FAILS validation.
 *
 *   staleClaims — the shape is fine but the claim rotted. An entry marked
 *     "installed" pointing at a `file` that no longer exists on disk. Only
 *     checked when the components directory argument is supplied.  FAILS.
 *
 *   missingSpecs — a built section with no persisted spec file.  FAILS.
 *
 *   missingDocs — BEHAVIORS.md / PAGE_TOPOLOGY.md absent once at least one
 *     section has been built (their absence before Phase 3 is fine).  FAILS.
 *
 *   thinSpecs — a spec exists but is missing required headings.  WARNING ONLY.
 *
 *   hedgedSpecs — a spec contains hedge markers ("likely", "TODO",
 *     "NOT YET EXTRACTED", ...) suggesting guessed rather than measured
 *     values. A hedge word can be legitimate, so this is a signal for human
 *     review, not an automatic failure.  WARNING ONLY.
 *
 * signature_slots schema (current):
 *   { "<slot>": { "budget": <int>=0>, "spent": <int>=0>, "claimedBy": [<id>...] } }
 * The retired flat-number form (`{"magnetic-cursor": 1}`) made over-spend
 * structurally undetectable — you could not tell a budget from a spend — and is
 * rejected with a migration message.
 *
 * Usage:
 *   node validate-claims.mjs <path-to-.runtime-claims.json> [<components-dir>] [<sections-dir>]
 *
 * <sections-dir> defaults to `<project-root>/src/sections`, derived from the
 * claims path (`<root>/docs/research/.runtime-claims.json`), so existing
 * two-argument invocations keep working and gain the coverage check for free.
 *
 * Exit codes:
 *   0  valid (no failing findings; warnings may still be present)
 *   1  structural violations, stale claims, missing specs and/or missing docs
 *   2  bad usage / missing or malformed claims file
 *
 * Pure Node — no deps.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

// ---- arg parsing -----------------------------------------------------------
const [, , ...positional] = process.argv
const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const USAGE = 'Usage: validate-claims.mjs <path-to-.runtime-claims.json> [<components-dir>] [<sections-dir>]'

const claimsPath = positional[0]
const componentsDir = positional[1]
if (!claimsPath) die(USAGE, 2)

const isDir = (p) => {
  if (!p || !existsSync(p)) return false
  try { return statSync(p).isDirectory() } catch { return false }
}
const isFile = (p) => {
  if (!p || !existsSync(p)) return false
  try { return statSync(p).isFile() } catch { return false }
}

// The claims file lives at <root>/docs/research/.runtime-claims.json, so its
// own directory is the research dir and two levels up is the project root.
const researchDir = dirname(resolve(process.cwd(), claimsPath))
const projectRoot = resolve(researchDir, '..', '..')

// Explicit third arg wins; otherwise auto-derive and only use it if it's real.
const derivedSectionsDir = join(projectRoot, 'src', 'sections')
const sectionsDirArg = positional[2]
const sectionsDir = sectionsDirArg
  ? resolve(process.cwd(), sectionsDirArg)
  : (isDir(derivedSectionsDir) ? derivedSectionsDir : null)
const sectionsDirSource = sectionsDirArg ? 'argv[3]' : 'derived'

// ---- claims file -----------------------------------------------------------
const TOP_KEYS = ['runtime', 'signature_slots', 'shared_files']

let claims
try {
  claims = JSON.parse(readFileSync(claimsPath, 'utf8'))
} catch (e) {
  die(`Error: .runtime-claims.json is missing or malformed — expected keys: ${TOP_KEYS.join(', ')}. Got: <unreadable: ${String((e && e.message) || e)}>`, 2)
}

// A JSON scalar / array at the top level parses fine but is not a ledger at all.
// Same practical failure as an unreadable file, so it shares exit code 2.
if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
  die(`Error: .runtime-claims.json is missing or malformed — expected an object with keys: ${TOP_KEYS.join(', ')}. Got: ${Array.isArray(claims) ? 'array' : String(claims === null ? 'null' : typeof claims)}`, 2)
}

const structuralViolations = []
const staleClaims = []
const missingSpecs = []
const thinSpecs = []
const hedgedSpecs = []
const missingDocs = []

const violation = (field, value, expected, hint) => {
  const v = { field, value: value === undefined ? null : value, expected }
  if (hint) v.hint = hint
  structuralViolations.push(v)
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// ---- runtime ---------------------------------------------------------------
const VALID_STATUS = new Set(['planned', 'installed'])

if (!isPlainObject(claims.runtime)) {
  violation('runtime', claims.runtime === undefined ? null : claims.runtime, 'object of infra-name -> { status, owner, file }')
} else {
  for (const [name, entry] of Object.entries(claims.runtime)) {
    if (!isPlainObject(entry)) {
      violation(`runtime.${name}`, entry, 'object with { status, owner, file }')
      continue
    }

    if (!VALID_STATUS.has(entry.status)) {
      violation(`runtime.${name}.status`, entry.status, 'planned or installed')
      continue
    }

    // "installed" is a claim about the world: somebody built it, somewhere.
    // A null owner/file means the claim carries no evidence and no builder can
    // be told what to import.
    if (entry.status === 'installed') {
      if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
        violation(`runtime.${name}.owner`, entry.owner, 'non-null string when status is installed')
      }
      if (typeof entry.file !== 'string' || entry.file.trim() === '') {
        violation(`runtime.${name}.file`, entry.file, 'non-null string when status is installed')
      }
    }
  }
}

// ---- signature_slots -------------------------------------------------------
// Schema: { "<slot>": { budget: int>=0, spent: int>=0, claimedBy: string[] } }
//
// The old schema was a bare number per slot, which is ambiguous by
// construction: `{"magnetic-cursor": 1}` could mean "budget 1, unspent" or
// "1 already spent". Over-spend was therefore undetectable. Callers hitting the
// old format get a migration message, not a generic type error.
const isNonNegInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0
const SLOT_SHAPE = 'object { budget: non-negative integer, spent: non-negative integer, claimedBy: array of builder/session id strings }'
const MIGRATION_HINT = 'OLD FLAT-NUMBER SCHEMA DETECTED — needs migration, this is not a value error. `"<slot>": N` is ambiguous (budget or spend?). Rewrite as `"<slot>": { "budget": N, "spent": 0, "claimedBy": [] }` (set "spent"/"claimedBy" to what has actually been consumed) on the next Reconcile pass. Claims files are per-clone-run artifacts, so regenerating is expected and safe.'

let legacySlotSchemaDetected = false

if (!isPlainObject(claims.signature_slots)) {
  violation('signature_slots', claims.signature_slots === undefined ? null : claims.signature_slots, `object of slot-name -> ${SLOT_SHAPE}`)
} else {
  for (const [slot, entry] of Object.entries(claims.signature_slots)) {
    // Retired schema: a bare number (or anything else scalar) per slot.
    if (typeof entry === 'number') {
      legacySlotSchemaDetected = true
      violation(`signature_slots.${slot}`, entry, SLOT_SHAPE, MIGRATION_HINT)
      continue
    }

    if (!isPlainObject(entry)) {
      violation(`signature_slots.${slot}`, entry, SLOT_SHAPE)
      continue
    }

    const budgetOk = isNonNegInt(entry.budget)
    const spentOk = isNonNegInt(entry.spent)
    const claimedByOk = Array.isArray(entry.claimedBy)

    if (!budgetOk) violation(`signature_slots.${slot}.budget`, entry.budget, 'non-negative integer')
    if (!spentOk) violation(`signature_slots.${slot}.spent`, entry.spent, 'non-negative integer')
    if (!claimedByOk) {
      violation(`signature_slots.${slot}.claimedBy`, entry.claimedBy, 'array of builder/session id strings')
    } else {
      entry.claimedBy.forEach((who, i) => {
        if (typeof who !== 'string' || who.trim() === '') {
          violation(`signature_slots.${slot}.claimedBy[${i}]`, who, 'non-empty builder/session id string')
        }
      })
    }

    // The whole point of the new schema: over-spend is now structurally visible.
    if (budgetOk && spentOk && entry.spent > entry.budget) {
      violation(
        `signature_slots.${slot}.spent`,
        entry.spent,
        `<= budget (${entry.budget})`,
        `OVER-SPEND: ${entry.spent} slot(s) consumed against a budget of ${entry.budget}${claimedByOk && entry.claimedBy.length ? ` — claimed by: ${entry.claimedBy.join(', ')}` : ''}. Either raise the budget deliberately or roll back the extra claim.`,
      )
    }

    // Accountability, same rule as runtime.owner: a spent slot with no recorded
    // claimant is a claim with no evidence. A recorded claimant with no
    // corresponding spend means the ledger was updated only half-way.
    if (spentOk && claimedByOk && entry.claimedBy.length !== entry.spent) {
      violation(
        `signature_slots.${slot}.claimedBy`,
        entry.claimedBy,
        `exactly ${entry.spent} entr${entry.spent === 1 ? 'y' : 'ies'} (one per spent slot)`,
        entry.claimedBy.length < entry.spent
          ? 'A slot was marked spent but nobody was recorded as consuming it — add the builder/session id.'
          : 'More claimants recorded than slots marked spent — bump "spent" to match, or drop the stale claimant.',
      )
    }
  }
}

// ---- shared_files ----------------------------------------------------------
if (!Array.isArray(claims.shared_files)) {
  violation('shared_files', claims.shared_files === undefined ? null : claims.shared_files, 'array of path strings')
} else {
  claims.shared_files.forEach((f, i) => {
    if (typeof f !== 'string') violation(`shared_files[${i}]`, f, 'string')
  })
}

// ---- freshness cross-check -------------------------------------------------
// Only runs when a components dir is supplied. The dir itself is a signal that
// the caller is mid-pipeline (Phase 3) and expects installed infra to be real.
if (componentsDir) {
  if (!isDir(componentsDir)) {
    violation('argv[2]', componentsDir, 'an existing components directory')
  }

  if (isPlainObject(claims.runtime)) {
    for (const [name, entry] of Object.entries(claims.runtime)) {
      if (!isPlainObject(entry)) continue
      if (entry.status !== 'installed') continue
      if (typeof entry.file !== 'string' || entry.file.trim() === '') continue // already a structural violation
      const abs = resolve(process.cwd(), entry.file)
      if (!existsSync(abs)) {
        staleClaims.push({
          infra: name,
          field: `runtime.${name}.file`,
          file: entry.file,
          owner: entry.owner ?? null,
          reason: 'marked installed but the file does not exist on disk',
        })
      }
    }
  }
}

// ---- spec coverage ---------------------------------------------------------
// SKILL.md Phase 3 Step 2: "Every component gets a spec in
// docs/research/components/<name>.spec.md BEFORE any builder is dispatched...
// Non-negotiable." This is the gate for that sentence.
//
// A section counts as BUILT when it has a section.meta.json (codegen's own
// marker). Every built section must have a persisted spec.

// Headings are matched by prefix so the template's parentheticals still count:
// "## Computed Styles (exact getComputedStyle values)" satisfies
// "## Computed Styles", and "## Text Content (verbatim, reconstructed...)"
// satisfies "## Text Content".
const REQUIRED_HEADINGS = [
  '## Computed Styles',
  '## States & Behaviors',
  '## Assets',
  '## Text Content',
  '## Responsive Behavior',
]

// Markers that say "I guessed" rather than "I measured".
const HEDGE_MARKERS = [
  { label: 'NOT YET EXTRACTED', re: /NOT\s+YET\s+EXTRACTED/gi },
  { label: 'NOT YET', re: /NOT\s+YET\b/gi },
  { label: 'TODO', re: /\bTODO\b/gi },
  { label: 'reasonable default', re: /reasonable\s+defaults?/gi },
  { label: 'likely', re: /\blikely\b/gi },
  { label: 'guess', re: /\bguess\w*/gi },
]

const listDirs = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return [] }
}
const listFiles = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
  } catch { return [] }
}

// Normalised heading text of every `## ` heading in the doc, lowercased.
const headingsOf = (text) => text
  .split(/\r?\n/)
  .filter((l) => /^##\s+/.test(l))
  .map((l) => l.replace(/^##\s+/, '').trim().toLowerCase())

const hasHeading = (headings, required) => {
  const want = required.replace(/^##\s+/, '').trim().toLowerCase()
  return headings.some((h) => h === want || h.startsWith(want))
}

// Prefer <name>.spec.md / <name>-section.spec.md, then any spec whose filename
// contains the section dir name (case-insensitive), per the skill's loose
// naming convention (`hero` -> `hero-section.spec.md`).
const findSpecFor = (sectionName, specFiles) => {
  const n = sectionName.toLowerCase()
  const exact = [`${n}.spec.md`, `${n}-section.spec.md`, `${n}section.spec.md`]
  for (const cand of exact) {
    const hit = specFiles.find((f) => f.toLowerCase() === cand)
    if (hit) return hit
  }
  return specFiles.find((f) => f.toLowerCase().includes(n)) || null
}

let builtSections = []

if (componentsDir && sectionsDir) {
  if (!isDir(sectionsDir)) {
    violation(
      sectionsDirSource === 'argv[3]' ? 'argv[3]' : 'sectionsDir',
      sectionsDir,
      'an existing sections directory (default: <project-root>/src/sections)',
    )
  } else {
    builtSections = listDirs(sectionsDir)
      .filter((name) => isFile(join(sectionsDir, name, 'section.meta.json')))
      .sort()

    const specFiles = isDir(componentsDir)
      ? listFiles(componentsDir).filter((f) => f.toLowerCase().endsWith('.spec.md'))
      : []

    for (const section of builtSections) {
      const specFile = findSpecFor(section, specFiles)

      if (!specFile) {
        missingSpecs.push({
          section,
          sectionDir: join(sectionsDir, section),
          expectedSpec: join(componentsDir, `${section}-section.spec.md`),
          reason: 'section was built (has section.meta.json) but no matching .spec.md was persisted in the components directory',
        })
        continue
      }

      const specPath = join(componentsDir, specFile)
      let text = ''
      try { text = readFileSync(specPath, 'utf8') } catch { text = '' }

      const headings = headingsOf(text)
      const absent = REQUIRED_HEADINGS.filter((h) => !hasHeading(headings, h))
      if (absent.length) {
        thinSpecs.push({
          section,
          spec: specPath,
          missingHeadings: absent,
          reason: 'spec exists but is missing required sections (warning — does not fail validation)',
        })
      }

      const found = []
      for (const { label, re } of HEDGE_MARKERS) {
        const matches = text.match(re)
        if (matches && matches.length) found.push({ marker: label, count: matches.length })
      }
      // "NOT YET EXTRACTED" already implies "NOT YET"; don't double-report it.
      const notYetExtracted = found.find((f) => f.marker === 'NOT YET EXTRACTED')
      const deduped = found
        .map((f) => (f.marker === 'NOT YET' && notYetExtracted
          ? { ...f, count: f.count - notYetExtracted.count }
          : f))
        .filter((f) => f.count > 0)
      if (deduped.length) {
        hedgedSpecs.push({
          section,
          spec: specPath,
          markers: deduped,
          reason: 'spec contains hedge markers suggesting guessed rather than measured values — human review signal, not an automatic failure',
        })
      }
    }

    // Phase 1/2 artifacts. Only meaningful once builders have actually been
    // dispatched — before that, their absence just means Phase 3 hasn't started.
    if (builtSections.length > 0) {
      for (const doc of ['BEHAVIORS.md', 'PAGE_TOPOLOGY.md']) {
        const p = join(researchDir, doc)
        if (!isFile(p)) {
          missingDocs.push({
            doc,
            expectedPath: p,
            reason: `${builtSections.length} section(s) already built but this Phase 1/2 artifact was never persisted`,
          })
        }
      }
    }
  }
}

// ---- report ----------------------------------------------------------------
// thinSpecs / hedgedSpecs are softer signals and are report-only by design.
const failing =
  structuralViolations.length +
  staleClaims.length +
  missingSpecs.length +
  missingDocs.length

const valid = failing === 0

console.log(JSON.stringify({
  valid,
  structuralViolations,
  staleClaims,
  missingSpecs,
  thinSpecs,
  hedgedSpecs,
  missingDocs,
}, null, 2))

// stderr so stdout stays cleanly parseable / pipeable
console.error(
  `validate-claims: ${structuralViolations.length} structural violations, ${staleClaims.length} stale claims, ` +
  `${missingSpecs.length} missing specs, ${missingDocs.length} missing docs ` +
  `(warnings: ${thinSpecs.length} thin specs, ${hedgedSpecs.length} hedged specs) — ${valid ? 'valid' : 'INVALID'}`,
)

if (legacySlotSchemaDetected) {
  console.error('validate-claims: signature_slots uses the RETIRED flat-number schema. Migrate each slot to { "budget": N, "spent": N, "claimedBy": [...] } — see the hint on each signature_slots violation above.')
}

if (componentsDir && !sectionsDir) {
  console.error(`validate-claims: no sections directory found (looked for ${derivedSectionsDir}) — spec-coverage check SKIPPED. Pass one explicitly as the 3rd argument if it lives elsewhere.`)
} else if (componentsDir && sectionsDir && isDir(sectionsDir) && builtSections.length === 0) {
  console.error(`validate-claims: no built sections found under ${sectionsDir} (no section.meta.json) — spec-coverage check found nothing to verify.`)
}

if (!componentsDir) {
  console.error('validate-claims: no components directory supplied — staleness and spec-coverage checks SKIPPED. ' + USAGE)
}

process.exitCode = valid ? 0 : 1
