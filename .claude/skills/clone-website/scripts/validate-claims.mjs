#!/usr/bin/env node
/**
 * clone-website — runtime claims validator (opencode skill)
 *
 * Validates `docs/research/.runtime-claims.json`, the concurrency-coordination
 * ledger the orchestrator maintains across Phase 2 and Phase 3. Every builder's
 * Shared-Scope Contract is rendered from this file, so a ledger that is
 * structurally wrong or stale silently corrupts every subsequent builder prompt.
 *
 * Two classes of problem are reported:
 *
 *   structuralViolations — the shape is wrong. A `status` that isn't exactly
 *     "planned" or "installed", an "installed" entry with a null `owner`/`file`
 *     (i.e. nobody recorded who installed it or where it lives), a
 *     `signature_slots` budget that isn't a non-negative integer, a
 *     `shared_files` entry that isn't a string.
 *
 *   staleClaims — the shape is fine but the claim rotted. An entry marked
 *     "installed" pointing at a `file` that no longer exists on disk. Only
 *     checked when the components directory argument is supplied.
 *
 * Usage:
 *   node validate-claims.mjs <path-to-.runtime-claims.json> [<components-dir>]
 *
 * Exit codes:
 *   0  valid (both report arrays empty)
 *   1  structural violations and/or stale claims found
 *   2  bad usage / missing or malformed claims file
 *
 * Pure Node — no deps.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// ---- arg parsing -----------------------------------------------------------
const [, , ...positional] = process.argv
const die = (msg, code = 1) => { console.error(msg); process.exit(code) }

const claimsPath = positional[0]
const componentsDir = positional[1]
if (!claimsPath) die('Usage: validate-claims.mjs <path-to-.runtime-claims.json> [<components-dir>]', 2)

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

const violation = (field, value, expected) => {
  structuralViolations.push({ field, value: value === undefined ? null : value, expected })
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
const isNonNegInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0

if (!isPlainObject(claims.signature_slots)) {
  violation('signature_slots', claims.signature_slots === undefined ? null : claims.signature_slots, 'object of slot-name -> non-negative integer budget')
} else {
  for (const [slot, budget] of Object.entries(claims.signature_slots)) {
    if (!isNonNegInt(budget)) violation(`signature_slots.${slot}`, budget, 'non-negative integer')
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
  if (!existsSync(componentsDir)) {
    violation('argv[2]', componentsDir, 'an existing components directory')
  } else {
    let st = null
    try { st = statSync(componentsDir) } catch { st = null }
    if (!st || !st.isDirectory()) violation('argv[2]', componentsDir, 'an existing components directory')
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

// ---- report ----------------------------------------------------------------
const valid = structuralViolations.length === 0 && staleClaims.length === 0

console.log(JSON.stringify({ valid, structuralViolations, staleClaims }, null, 2))

// stderr so stdout stays cleanly parseable / pipeable
console.error(`validate-claims: ${structuralViolations.length} structural violations, ${staleClaims.length} stale claims — ${valid ? 'valid' : 'INVALID'}`)

process.exitCode = valid ? 0 : 1
