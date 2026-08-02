#!/bin/sh
#
# unlock-shared.sh <project-root>
#
# Reverses lock-shared.sh so the orchestrator can edit the shared files during
# the reconcile phase.
#
#   DIR-LOCK entries    parent dir back to 0755, file back to 0644.
#
# NOT IMPLEMENTED: the manifest's `vaultLocked` key is reserved and currently a
# no-op here, matching lock-shared.sh. The vault-symlink mechanism was removed
# when its only user (src/components/icons.tsx) went away. Non-empty entries
# are warned about rather than silently ignored.
#
# Idempotent: running it twice in a row is a no-op, not an error.
#
set -u

PROG=$(basename -- "$0")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MANIFEST=${SHARED_LOCK_MANIFEST:-$SCRIPT_DIR/shared-lock.manifest}

usage() {
	cat <<EOF
usage: $PROG <project-root>

Restores write permissions on every file listed in the manifest. Idempotent.

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

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/shared-unlock.XXXXXX") || die "cannot create tempdir"
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
	warn "nothing was unlocked for those paths - see the header comment"
	;;
esac

n_files=0
n_dirs=0
n_skipped=0

# --- pass 1: parent dirs -> 0755 -------------------------------------------
# Directories first: the files inside them are unreachable for rename/unlink
# until their parent is writable again.
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	dirname -- "$rel" >>"$TMPD/parents.raw"
done <"$TMPD/dir.list"

sort -u "$TMPD/parents.raw" >"$TMPD/parents.list"
while IFS= read -r pdir; do
	[ -n "$pdir" ] || continue
	if [ ! -d "$ROOT/$pdir" ]; then
		warn "skipping $pdir (not present)"
		continue
	fi
	chmod 0755 "$ROOT/$pdir" || die "chmod 0755 failed: $pdir"
	n_dirs=$((n_dirs + 1))
done <"$TMPD/parents.list"

# --- pass 2: dir-locked files -> 0644 --------------------------------------
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	if [ ! -f "$ROOT/$rel" ]; then
		warn "skipping $rel (not present)"
		n_skipped=$((n_skipped + 1))
		continue
	fi
	chmod 0644 "$ROOT/$rel" || die "chmod 0644 failed: $rel"
	n_files=$((n_files + 1))
done <"$TMPD/dir.list"

extra=''
[ "$n_skipped" -gt 0 ] && extra=" ($n_skipped skipped)"
printf 'unlocked: %d file(s) 0644 + %d dir(s) 0755%s [root: %s]\n' \
	"$n_files" "$n_dirs" "$extra" "$ROOT"
