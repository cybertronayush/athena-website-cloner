#!/usr/bin/env bash
# tripwire-check.sh — detect and revert unauthorised edits to the shared files.
#
# Defense-in-depth behind the POSIX lock: if anything slips past the lock, this
# catches it. Git is the ground truth, so there is no separate hash vault to
# keep in sync. The printed diff is the feedback payload — paste it back into
# the offending builder's context so it can re-request the change properly.
#
# Usage: tripwire-check.sh <root> <last-good-commit-ish>
# Exit:  0 = no drift, 1 = drift found (files reverted), 2 = cannot check.

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
  printf 'Usage: %s <root> <last-good-commit-ish>\n' "${0##*/}" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
case "$1" in -h|--help) usage ;; esac

ROOT=$1
BASE=$2

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

reverted=()
failed=()

# Check and revert every file before reporting. Bailing on the first violation
# would hide the rest and force a second round-trip.
while IFS= read -r file; do
  [ -n "$file" ] || continue

  printf -- '---------- UNAUTHORISED CHANGE: %s ----------\n' "$file"
  printf 'Diff vs last-good state (paste this back to the responsible builder):\n\n'
  git -C "$ROOT" diff "$BASE" -- "$file"
  printf '\n'

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

printf '\nAction: the shared files are owned by the reconcile step. Send the diff\n'
printf 'above back to the builder that produced it and have it re-request the\n'
printf 'change in its completion message instead of editing directly.\n'

exit 1
