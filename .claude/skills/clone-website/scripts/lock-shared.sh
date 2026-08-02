#!/bin/sh
#
# lock-shared.sh <project-root>
#
# Hard-locks the shared/global files that parallel builder agents must never
# touch, verified against all 4 write vectors (direct write, temp-file +
# rename-over, unlink, create-sibling):
#
#   DIR-LOCK  file 0444 + parent directory 0555.
#   `chmod 0444` ALONE IS LEAKY: a temp-file + `mv` over the target bypasses it
#   completely and silently resets the file to 0644. Locking the parent
#   directory to 0555 removes the write permission needed to rename over,
#   unlink, or create a sibling. Both halves are required.
#   Used for src/app/* because builders never create NEW files in src/app/
#   during the parallel phase.
#
# NOT IMPLEMENTED: the manifest also carries a `vaultLocked` key. It is
# reserved and currently a no-op. It used to drive a vault-symlink mechanism
# (canonical content at src/.vault/<f> 0444 inside a 0555 dir, with the real
# path a relative symlink to it) for files whose own directory has to stay
# writable. Its only user, src/components/icons.tsx, is gone, so the code path
# was removed rather than carried dead. Non-empty entries are warned about
# loudly instead of being silently ignored; re-add the mechanism deliberately
# if that need ever comes back.
#
# Idempotent: running it twice in a row is a no-op, not an error.
# Undo with unlock-shared.sh, audit with verify-shared.sh.
#
set -u

PROG=$(basename -- "$0")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MANIFEST=${SHARED_LOCK_MANIFEST:-$SCRIPT_DIR/shared-lock.manifest}

usage() {
	cat <<EOF
usage: $PROG <project-root>

Locks every file listed in the manifest so parallel builder agents cannot
modify it by any means. Idempotent.

  manifest: $MANIFEST
EOF
}

die() {
	printf '%s: error: %s\n' "$PROG" "$*" >&2
	exit 1
}

warn() {
	printf '%s: warn: %s\n' "$PROG" "$*" >&2
}

# ---------------------------------------------------------------- manifest --
# Emits dirLocked entries one per line. Prefers jq, falls back to awk so the
# scripts stay dependency-free.
manifest_read_dir() {
	if command -v jq >/dev/null 2>&1; then
		jq -r '.dirLocked[]? // empty' "$MANIFEST"
		return
	fi
	awk '
		{ buf = buf $0 " " }
		END {
			i = index(buf, "\"dirLocked\"")
			if (i == 0) exit 0
			rest = substr(buf, i)
			s = index(rest, "[")
			e = index(rest, "]")
			if (s == 0 || e == 0 || e < s) exit 0
			seg = substr(rest, s + 1, e - s - 1)
			n = split(seg, arr, ",")
			for (k = 1; k <= n; k++) {
				v = arr[k]
				gsub(/^[ \t]+|[ \t]+$/, "", v)
				gsub(/^"|"$/, "", v)
				if (v != "") print v
			}
		}
	' "$MANIFEST"
}

# Number of vaultLocked entries. Only used to warn that the feature is gone.
manifest_count_vault() {
	if command -v jq >/dev/null 2>&1; then
		jq -r '(.vaultLocked // []) | length' "$MANIFEST" 2>/dev/null || printf '0\n'
		return
	fi
	awk '
		{ buf = buf $0 " " }
		END {
			i = index(buf, "\"vaultLocked\"")
			if (i == 0) { print 0; exit }
			rest = substr(buf, i)
			s = index(rest, "[")
			e = index(rest, "]")
			if (s == 0 || e == 0 || e < s) { print 0; exit }
			seg = substr(rest, s + 1, e - s - 1)
			gsub(/[ \t\r\n]/, "", seg)
			if (seg == "") { print 0; exit }
			c = 0
			n = split(seg, objs, "}")
			for (k = 1; k <= n; k++) if (index(objs[k], "{") > 0) c++
			print (c > 0 ? c : 1)
		}
	' "$MANIFEST"
}

# --------------------------------------------------------------------- run --
case "${1:-}" in
-h | --help)
	usage
	exit 0
	;;
esac

[ $# -ge 1 ] || {
	usage >&2
	exit 2
}
[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
[ -d "$1" ] || die "project root not found: $1"
ROOT=$(CDPATH= cd -- "$1" && pwd) || die "cannot resolve project root: $1"

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/shared-lock.XXXXXX") || die "cannot create tempdir"
trap 'rm -rf "$TMPD"' EXIT
trap 'rm -rf "$TMPD"; exit 130' INT
trap 'rm -rf "$TMPD"; exit 143' TERM

manifest_read_dir >"$TMPD/dir.list" || die "cannot parse manifest"
: >"$TMPD/parents.raw"

n_vault=$(manifest_count_vault)
case "$n_vault" in
'' | 0) : ;;
*)
	warn "manifest lists $n_vault vaultLocked entry(ies), but vault locking is NOT IMPLEMENTED"
	warn "those paths will NOT be protected by this script - see the header comment"
	;;
esac

n_files=0
n_dirs=0
n_skipped=0

# --- pass 0: reopen parent dirs --------------------------------------------
# A re-run over an already-locked tree needs the parents writable again so a
# partially-applied state can be repaired.
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	pdir=$(dirname -- "$rel")
	[ -d "$ROOT/$pdir" ] || die "missing directory: $pdir (under $ROOT)"
	chmod 0755 "$ROOT/$pdir" 2>/dev/null || true
done <"$TMPD/dir.list"

# --- pass 1: dir-locked files -> 0444 --------------------------------------
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	if [ ! -f "$ROOT/$rel" ]; then
		warn "skipping $rel (not present)"
		n_skipped=$((n_skipped + 1))
		continue
	fi
	chmod 0444 "$ROOT/$rel" || die "chmod 0444 failed: $rel"
	n_files=$((n_files + 1))
	dirname -- "$rel" >>"$TMPD/parents.raw"
done <"$TMPD/dir.list"

# --- pass 2: unique parent dirs -> 0555 ------------------------------------
# Once per directory, and only after every file inside it is already 0444.
sort -u "$TMPD/parents.raw" >"$TMPD/parents.list"
while IFS= read -r pdir; do
	[ -n "$pdir" ] || continue
	chmod 0555 "$ROOT/$pdir" || die "chmod 0555 failed: $pdir"
	n_dirs=$((n_dirs + 1))
done <"$TMPD/parents.list"

extra=''
[ "$n_skipped" -gt 0 ] && extra=" ($n_skipped skipped)"
printf 'locked: %d file(s) 0444 + %d dir(s) 0555%s [root: %s]\n' \
	"$n_files" "$n_dirs" "$extra" "$ROOT"
