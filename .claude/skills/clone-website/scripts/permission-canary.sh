#!/usr/bin/env bash
# permission-canary.sh — prove the shared-file lock actually blocks writes.
#
# Never claim a protection mechanism works because it "loaded correctly".
# This script performs a LIVE write test against the same POSIX primitive
# lock-shared.sh uses (file 0444 + parent dir 0555) and records the verdict.
#
# It deliberately does NOT test the OpenCode agent-permission system, which is
# already proven to have zero effect on bash-level file writes.
#
# Usage: permission-canary.sh <root>
# Exit:  0 = ENFORCED, 1 = NOT_ENFORCED or INCONCLUSIVE (both are failures).

set -uo pipefail

FILE_MODE=0444
DIR_MODE=0555
CANARY_CONTENT="canary-content-v1"
TAMPER_DIRECT="tampered-by-direct-write"
TAMPER_RENAME="tampered-by-temp-rename"
MECHANISM="posix-lock"

usage() {
  printf 'Usage: %s <root>\n' "${0##*/}" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in -h|--help) usage ;; esac

ROOT=$1
if [ ! -d "$ROOT" ]; then
  printf 'permission-canary: <root> is not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
# Normalise to an absolute path so trap-based restore can never target the
# wrong directory if the caller's cwd changes underneath us.
ROOT=$(cd "$ROOT" && pwd)

SCRATCH="$ROOT/.clone-canary-scratch.txt"
TMPFILE="$ROOT/.clone-canary-scratch.tmp"
RUNDIR="$ROOT/.clone-run"
CAPFILE="$RUNDIR/capabilities.json"

# ---------------------------------------------------------------- helpers ---

# Portable "print octal mode of path" (BSD/macOS stat vs GNU stat).
stat_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

# Collapse arbitrary text to a single safe JSON string body.
json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

DIR_MODE_ORIG=""

# Restore the parent dir mode and remove scratch artefacts. Registered on EXIT
# so a crash or Ctrl-C can never leave <root> read-only or a locked file behind.
cleanup() {
  if [ -n "$DIR_MODE_ORIG" ]; then
    chmod "$DIR_MODE_ORIG" "$ROOT" 2>/dev/null || true
    DIR_MODE_ORIG=""
  fi
  if [ -e "$SCRATCH" ]; then
    chmod u+w "$SCRATCH" 2>/dev/null || true
  fi
  rm -f "$SCRATCH" "$TMPFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

write_capabilities() {
  # $1 = enforced (true|false), $2 = detail
  mkdir -p "$RUNDIR" 2>/dev/null || {
    printf 'permission-canary: cannot create %s\n' "$RUNDIR" >&2
    return 1
  }
  cat > "$CAPFILE" <<JSON
{
  "permissions_enforced": $1,
  "mechanism": "$MECHANISM",
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "detail": "$(json_escape "$2")"
}
JSON
}

# ------------------------------------------------------------------ setup ---

rm -f "$SCRATCH" "$TMPFILE" 2>/dev/null || true

if ! printf '%s' "$CANARY_CONTENT" > "$SCRATCH" 2>/dev/null; then
  printf 'permission-canary: cannot create scratch file in %s\n' "$ROOT" >&2
  exit 2
fi
# Staged in the same directory so vector B is a pure same-dir rename(), which
# is exactly the call that defeats a naive file-only chmod 0444.
if ! printf '%s' "$TAMPER_RENAME" > "$TMPFILE" 2>/dev/null; then
  printf 'permission-canary: cannot create temp file in %s\n' "$ROOT" >&2
  exit 2
fi

DIR_MODE_ORIG=$(stat_mode "$ROOT")
if [ -z "$DIR_MODE_ORIG" ]; then
  printf 'permission-canary: cannot read directory mode for %s\n' "$ROOT" >&2
  exit 2
fi

# ------------------------------------------------------------------- lock ---
# Same primitive as lock-shared.sh: read-only file inside a non-writable dir.
chmod "$FILE_MODE" "$SCRATCH" 2>/dev/null || true
chmod "$DIR_MODE" "$ROOT" 2>/dev/null || true

# -------------------------------------------------- vector A: direct write ---
err_direct=$( { printf '%s' "$TAMPER_DIRECT" > "$SCRATCH"; } 2>&1 )
rc_direct=$?
content_after_direct=$(cat "$SCRATCH" 2>/dev/null)

# --------------------------------------------- vector B: temp file + rename ---
# stdin from /dev/null + -f so mv can never block on an interactive
# "override r--r--r--?" prompt when the target is read-only.
err_rename=$( { mv -f "$TMPFILE" "$SCRATCH"; } 2>&1 </dev/null )
rc_rename=$?
content_after_rename=$(cat "$SCRATCH" 2>/dev/null)

# ----------------------------------------------------------------- unlock ---
chmod "$DIR_MODE_ORIG" "$ROOT" 2>/dev/null || true
DIR_MODE_ORIG=""
chmod u+w "$SCRATCH" 2>/dev/null || true
rm -f "$SCRATCH" "$TMPFILE" 2>/dev/null || true

# --------------------------------------------------------------- classify ---
STATE=""
DETAIL=""

if [ "$content_after_direct" != "$CANARY_CONTENT" ]; then
  STATE=NOT_ENFORCED
  DETAIL="direct write modified the locked canary (content became '${content_after_direct}')"
elif [ "$content_after_rename" != "$CANARY_CONTENT" ]; then
  STATE=NOT_ENFORCED
  DETAIL="temp-file+rename replaced the locked canary (content became '${content_after_rename}')"
elif [ "$rc_direct" -eq 0 ]; then
  # Content survived but the writer reported success. A false green here is
  # worse than no canary at all, so this counts as a failure.
  STATE=INCONCLUSIVE
  DETAIL="content unchanged but direct write exited 0 with no error; cannot confirm enforcement"
elif [ "$rc_rename" -eq 0 ]; then
  STATE=INCONCLUSIVE
  DETAIL="content unchanged but temp-rename exited 0 with no error; cannot confirm enforcement"
else
  STATE=ENFORCED
  DETAIL="both vectors blocked (direct write rc=${rc_direct}, temp-rename rc=${rc_rename}) by file ${FILE_MODE} + dir ${DIR_MODE}"
fi

# ----------------------------------------------------------------- report ---
printf 'permission-canary: %s\n' "$STATE"
printf '  mechanism      : %s (file %s, dir %s)\n' "$MECHANISM" "$FILE_MODE" "$DIR_MODE"
printf '  direct write   : rc=%s %s\n' "$rc_direct" "${err_direct:-<no stderr>}"
printf '  temp+rename    : rc=%s %s\n' "$rc_rename" "${err_rename:-<no stderr>}"
printf '  detail         : %s\n' "$DETAIL"

if [ "$STATE" = ENFORCED ]; then
  write_capabilities true "$DETAIL"
  printf '  capabilities   : %s\n' "$CAPFILE"
  exit 0
fi

write_capabilities false "$STATE: $DETAIL"
printf '  capabilities   : %s\n' "$CAPFILE"
printf '=== PERMISSIONS NOT ENFORCED ON THIS INSTALL — falling back to paranoid mode ===\n' >&2
exit 1
