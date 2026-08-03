#!/usr/bin/env bash
# tripwire-check.sh — detect and revert unauthorised edits to the shared files.
#
# Defense-in-depth behind the POSIX lock: if anything slips past the lock, this
# catches it. Git is the ground truth, so there is no separate hash vault to
# keep in sync. The printed diff is the feedback payload — paste it back into
# the offending builder's context so it can re-request the change properly.
#
# LOCK-STATE GUARD (why this script no longer reverts blindly)
# A diff against the baseline cannot tell "a builder edited a file it must never
# touch" apart from "the orchestrator is mid-reconcile and hasn't committed the
# new baseline yet". Both look identical to git. The permission bits CAN tell
# them apart: per the Shared-Scope Contract the three shared files are locked
# (file 0444 + parent dir 0555) at every point where a tripwire check is a
# legitimate operation, and are only writable while a reconcile is actively in
# flight. So:
#
#   locked   + differs  -> revert automatically (the real tripwire case: a rogue
#                          edit to a file that should have been immutable).
#   unlocked + differs  -> REFUSE, warn loudly, change nothing. Reverting here
#                          destroys legitimate in-progress reconcile work.
#                          Override with --force once you are sure.
#
# This exists because it already happened: a tripwire run against a stale
# pre-reconcile baseline silently reverted correct, uncommitted reconcile output
# and reported it as a success.
#
# Usage: tripwire-check.sh [--force] <root> <last-good-commit-ish>
#   --force  Revert even files that are currently unlocked. Skips ONLY the
#            lock-state guard; a file still has to differ from the baseline to
#            be touched at all.
# Exit:  0 = no drift
#        1 = drift found, everything reverted
#        2 = cannot check (bad args / no repo / unresolvable baseline)
#        3 = drift found but at least one file was REFUSED (unlocked): rerun
#            against the correct up-to-date baseline, or with --force.

set -uo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Mirrors the shared_files list in the lock manifest / Shared-Scope Contract.
# The icon barrel (src/components/icons/index.ts) is deliberately NOT a target:
# codegen.mjs rewrites it from scratch on every Reconcile, so any tamper is
# overwritten as a side effect of normal operation and a tripwire would be
# redundant.
SHARED_FILES=(
  "src/app/globals.css"
  "src/app/layout.tsx"
  "src/app/page.tsx"
)

usage() {
  cat >&2 <<EOF
Usage: ${0##*/} [--force] <root> <last-good-commit-ish>

Detects drift in the shared files (globals.css, layout.tsx, page.tsx) against a
known-good commit and reverts it.

  --force, -f   Also revert files that are currently UNLOCKED (writable).
                By default an unlocked shared file is REFUSED rather than
                reverted: writable means a reconcile is probably in flight and
                the diff is legitimate uncommitted work, not a rogue edit.
                --force skips that guard only — a file must still differ from
                the baseline to be reverted.
  -h, --help    Show this help.

Exit: 0 no drift | 1 drift reverted | 2 cannot check | 3 drift refused (unlocked)
EOF
  exit 2
}

FORCE=0
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)  usage ;;
    -f|--force) FORCE=1; shift ;;
    --)         shift; while [ "$#" -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    -*)         printf 'tripwire: unknown option: %s\n' "$1" >&2; usage ;;
    *)          ARGS+=("$1"); shift ;;
  esac
done

[ "${#ARGS[@]}" -eq 2 ] || usage

ROOT=${ARGS[0]}
BASE=${ARGS[1]}

if [ ! -d "$ROOT" ]; then
  printf 'tripwire: <root> is not a directory: %s\n' "$ROOT" >&2
  exit 2
fi

# ---------------------------------------------------------- preconditions ---
# A missing git repo must be a hard failure. Silently passing here would make
# the tripwire look green while checking nothing at all.
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'tripwire: %s is not inside a git repository.\n' "$ROOT" >&2
  printf 'tripwire: this check uses git as its ground truth and cannot run without it.\n' >&2
  printf 'tripwire: initialise a repo and commit a known-good baseline first.\n' >&2
  exit 2
fi

if ! git -C "$ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  printf 'tripwire: cannot resolve last-good commit-ish: %s\n' "$BASE" >&2
  printf 'tripwire: pass a valid commit, tag, or ref reachable from %s.\n' "$ROOT" >&2
  exit 2
fi

# ----------------------------------------------------------- lock manifest ---
# This script must be callable at ANY point in the pipeline, locked or not, so
# it never assumes the caller unlocked anything first. `git checkout -- <file>`
# unlinks the old inode and creates a new one, which needs WRITE permission on
# the PARENT DIRECTORY. Against a dir-locked file (0444 inside a 0555 dir) the
# revert therefore fails even though detection worked. We read the same manifest
# lock-shared.sh uses and wrap each individual revert in a narrow
# unlock -> checkout -> relock cycle. No pipeline-wide unlock, nothing else on
# disk is touched.
if [ -n "${SHARED_LOCK_MANIFEST:-}" ]; then
  MANIFEST=$SHARED_LOCK_MANIFEST
elif [ -f "$SCRIPT_DIR/shared-lock.manifest" ]; then
  MANIFEST=$SCRIPT_DIR/shared-lock.manifest
else
  MANIFEST=$ROOT/scripts/shared-lock.manifest
fi

# Emits the manifest's dirLocked entries, one repo-relative path per line.
# Prefers jq, falls back to awk so the scripts stay dependency-free.
manifest_dir_locked() {
  if command -v jq >/dev/null 2>&1 && jq -e . "$MANIFEST" >/dev/null 2>&1; then
    jq -r '.dirLocked[]? // empty' "$MANIFEST"
    return
  fi
  awk '
    { buf = buf $0 " " }
    END {
      i = index(buf, "\"dirLocked\"")
      if (i == 0) exit 0
      rest = substr(buf, i)
      s = index(rest, "["); e = index(rest, "]")
      if (s == 0 || e == 0 || e < s) exit 0
      n = split(substr(rest, s + 1, e - s - 1), arr, ",")
      for (k = 1; k <= n; k++) {
        v = arr[k]
        gsub(/^[ \t]+|[ \t]+$/, "", v); gsub(/^"|"$/, "", v)
        if (v != "") print v
      }
    }
  ' "$MANIFEST"
}

DIR_LOCKED=()
if [ -f "$MANIFEST" ]; then
  while IFS= read -r _entry; do
    [ -n "$_entry" ] || continue
    DIR_LOCKED+=("$_entry")
  done < <(manifest_dir_locked)
fi
if [ "${#DIR_LOCKED[@]}" -eq 0 ]; then
  # No readable manifest: assume the shared files carry the lock. Guessing wrong
  # here is harmless (each mode is snapshotted and restored verbatim), whereas
  # guessing "unlocked" would resurrect the silent revert failure.
  printf 'tripwire: no usable lock manifest at %s — assuming the shared files are dir-locked.\n' "$MANIFEST" >&2
  DIR_LOCKED=("${SHARED_FILES[@]}")
fi

is_dir_locked() {
  local _p
  for _p in "${DIR_LOCKED[@]}"; do
    [ "$_p" = "$1" ] && return 0
  done
  return 1
}

# Octal permission bits of a path (BSD stat first, then GNU), empty if missing.
mode_of() {
  stat -f '%OLp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1" 2>/dev/null || printf ''
}

# True when any write bit (owner, group, or other) is set in an octal mode
# string. Tolerates a leading setuid/sticky digit by looking at the last three.
mode_has_write() {
  local m=${1:-}
  m=${m: -3}
  [ "${#m}" -eq 3 ] || return 1
  local d
  for d in "${m:0:1}" "${m:1:1}" "${m:2:1}"; do
    case "$d" in 2|3|6|7) return 0 ;; esac
  done
  return 1
}

# True when a shared file is NOT currently locked, i.e. somebody can still write
# it. lock-shared.sh sets file 0444 + parent dir 0555; unlock-shared.sh sets
# file 0644 + parent dir 0755. Either half being open counts as unlocked:
#   - a writable file is the obvious case,
#   - a writable parent dir is enough to rename or unlink over a 0444 file, and
#     it is the FIRST thing unlock-shared.sh opens, so a half-applied unlock is
#     still an active reconcile.
# Deliberately biased toward reporting "unlocked": a false unlocked reading only
# costs an extra confirmation, a false locked reading destroys real work.
is_unlocked() {
  local file=$1
  local abs="$ROOT/$file"

  if [ -e "$abs" ] && mode_has_write "$(mode_of "$abs")"; then
    return 0
  fi

  # The parent dir is only half of the lock for dir-locked manifest entries;
  # for anything else its mode says nothing about the file's lock state.
  if is_dir_locked "$file" && mode_has_write "$(mode_of "$(dirname -- "$abs")")"; then
    return 0
  fi

  return 1
}

# Human-readable "0444 file / 0555 dir" summary for the warning block.
lock_state_desc() {
  local abs="$ROOT/$1"
  local fmode pmode
  fmode=$(mode_of "$abs"); [ -n "$fmode" ] || fmode='missing'
  pmode=$(mode_of "$(dirname -- "$abs")"); [ -n "$pmode" ] || pmode='missing'
  printf 'file mode %s, parent dir mode %s' "$fmode" "$pmode"
}

# Revert one file to $BASE, opening the POSIX lock only for the duration of the
# checkout and restoring the exact prior modes afterwards.
revert_file() {
  local file=$1
  local abs="$ROOT/$file"
  local pdir pmode='' fmode='' rc=0
  pdir=$(dirname -- "$abs")

  if is_dir_locked "$file"; then
    pmode=$(mode_of "$pdir")
    [ -e "$abs" ] && fmode=$(mode_of "$abs")
    [ -n "$pmode" ] && chmod 0755 "$pdir" 2>/dev/null
    [ -n "$fmode" ] && chmod 0644 "$abs" 2>/dev/null
  fi

  git -C "$ROOT" checkout "$BASE" -- "$file" 2>/dev/null || rc=$?

  # Relock inside-out: the file first, then its parent directory.
  if [ -n "$fmode" ]; then
    chmod "0$fmode" "$abs" 2>/dev/null
  elif [ "$pmode" = "555" ] && [ -e "$abs" ]; then
    # File was absent before the revert; a locked parent means the restored
    # file belongs at the locked mode too.
    chmod 0444 "$abs" 2>/dev/null
  fi
  [ -n "$pmode" ] && chmod "0$pmode" "$pdir" 2>/dev/null

  return "$rc"
}

# ----------------------------------------------------------------- detect ---
# Compares the working tree (staged + unstaged) against the known-good commit.
changed=$(git -C "$ROOT" diff --name-only "$BASE" -- "${SHARED_FILES[@]}" 2>/dev/null)

if [ -z "$changed" ]; then
  printf 'tripwire: no shared-file drift detected (baseline %s)\n' "$BASE"
  exit 0
fi

# ------------------------------------------------------- report and revert ---
printf '=== SHARED-FILE TRIPWIRE TRIPPED ===\n'
printf 'baseline: %s\n' "$BASE"
printf 'root    : %s\n\n' "$ROOT"

[ "$FORCE" -eq 1 ] && printf '%s\n\n' '--force: lock-state guard disabled, unlocked files will be reverted too.'

reverted=()
failed=()
refused=()

# Check and revert every file before reporting. Bailing on the first violation
# would hide the rest and force a second round-trip.
while IFS= read -r file; do
  [ -n "$file" ] || continue

  printf -- '---------- UNAUTHORISED CHANGE: %s ----------\n' "$file"
  printf 'Diff vs last-good state (paste this back to the responsible builder):\n\n'
  git -C "$ROOT" diff "$BASE" -- "$file"
  printf '\n'

  # --------------------------------------------------- lock-state guard ---
  # A writable shared file means the lock is currently open, which per the
  # Shared-Scope Contract only happens during an active reconcile. The diff is
  # then almost certainly legitimate uncommitted work, not drift, so reverting
  # it would delete exactly what the operator is in the middle of producing.
  if [ "$FORCE" -eq 0 ] && is_unlocked "$file"; then
    refused+=("$file")
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    printf '!! REVERT REFUSED — %s IS CURRENTLY UNLOCKED\n' "$file"
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    printf 'Current state: %s (locked would be 0444 file / 0555 dir).\n' "$(lock_state_desc "$file")"
    printf 'An unlocked shared file means a RECONCILE IS PROBABLY IN FLIGHT.\n'
    printf 'The diff above is then legitimate work that has not been committed as\n'
    printf 'the new baseline yet, and auto-reverting it would destroy it for good.\n'
    printf 'Nothing was changed on disk for this file.\n\n'
    printf 'Do one of these:\n'
    printf '  (a) Finish the reconcile, re-lock, commit the new baseline\n'
    printf '      (git add -A && git commit -m %s), then re-run this check\n' "'chore: post-reconcile baseline'"
    printf '      against THAT commit — not the stale %s.\n' "$BASE"
    printf '  (b) If you are certain this really is an unauthorised edit, re-run\n'
    printf '      with --force:\n'
    printf '        %s --force %s %s\n\n' "${0##*/}" "$ROOT" "$BASE"
    continue
  fi

  if revert_file "$file"; then
    reverted+=("$file")
    printf 'REVERTED: %s restored to %s\n\n' "$file" "$BASE"
  else
    failed+=("$file")
    printf 'REVERT FAILED: %s could not be restored — needs manual repair\n\n' "$file"
  fi
done <<< "$changed"

# ---------------------------------------------------------------- summary ---
printf '=== TRIPWIRE SUMMARY ===\n'
printf 'files reverted (%d):\n' "${#reverted[@]}"
if [ "${#reverted[@]}" -eq 0 ]; then
  printf '  (none)\n'
else
  for file in "${reverted[@]}"; do printf '  - %s\n' "$file"; done
fi

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'files that FAILED to revert (%d):\n' "${#failed[@]}"
  for file in "${failed[@]}"; do printf '  - %s\n' "$file"; done
fi

if [ "${#refused[@]}" -gt 0 ]; then
  printf 'files REFUSED — unlocked, left untouched (%d):\n' "${#refused[@]}"
  for file in "${refused[@]}"; do printf '  - %s\n' "$file"; done
fi

printf '\nAction: the shared files are owned by the reconcile step. Send the diff\n'
printf 'above back to the builder that produced it and have it re-request the\n'
printf 'change in its completion message instead of editing directly.\n'

if [ "${#refused[@]}" -gt 0 ]; then
  printf '\nNOTE: %d file(s) were left alone because they are unlocked. Verify the\n' "${#refused[@]}"
  printf 'baseline %s is actually current before doing anything else — a stale\n' "$BASE"
  printf 'baseline is the usual reason this guard fires. Re-run with --force only\n'
  printf 'if you have confirmed the change is genuinely unauthorised.\n'
  exit 3
fi

exit 1
