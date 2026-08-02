#!/bin/sh
#
# verify-shared.sh [--expect-locked|--expect-unlocked] <project-root>
#
# Audits the shared-file protection applied by lock-shared.sh. Meant to run as
# a gate before merging builder work.
#
#   --expect-locked   (default)  files 0444, parent dirs 0555
#   --expect-unlocked            files 0644, parent dirs 0755
#
# NOT IMPLEMENTED: the manifest's `vaultLocked` key is reserved and currently
# unverified. The vault-symlink mechanism it used to drive was removed when its
# only user (src/components/icons.tsx) went away. If the manifest ever carries
# non-empty vaultLocked entries again, this script prints a loud warning AND
# counts each one as a SKIP, so the run cannot come back a false-green PASS.
#
# A SKIP means a manifest entry produced NO protection - either its target does
# not exist, or the mechanism it names is not implemented (vaultLocked).
# "Not present" is not the same as "protected", so in --expect-locked mode a
# skip is never folded into a bare PASS: it exits 3 (PARTIAL) with an itemized
# warning. In --expect-unlocked mode there is nothing to lose, so a skip stays
# non-fatal but is still reported explicitly.
#
# Exit codes:
#   0  PASS      every manifest entry verified, nothing skipped
#   1  FAIL      at least one check failed (itemized report)
#   2  usage/environment error
#   3  PARTIAL   no failures, but >=1 manifest entry was unverifiable
#                (--expect-locked only; --expect-unlocked reports and exits 0)
#
set -u

PROG=$(basename -- "$0")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MANIFEST=${SHARED_LOCK_MANIFEST:-$SCRIPT_DIR/shared-lock.manifest}

usage() {
	cat <<EOF
usage: $PROG [--expect-locked|--expect-unlocked] <project-root>

Audits the shared-file protection state. Exits 0 when the actual state matches
the expected one, non-zero otherwise with an itemized report.

  --expect-locked     files 0444 / dirs 0555 (default)
  --expect-unlocked   files 0644 / dirs 0755

exit codes:
  0  PASS     every manifest entry verified, nothing skipped
  1  FAIL     at least one check failed
  2  usage or environment error
  3  PARTIAL  no failures, but a manifest entry was unverifiable (nothing
              there to protect). --expect-locked only.

  manifest: $MANIFEST
EOF
}

die() {
	printf '%s: error: %s\n' "$PROG" "$*" >&2
	exit 2
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

# ----------------------------------------------------------------- helpers --
if stat -f '%Lp' . >/dev/null 2>&1; then
	STAT_FLAVOR=bsd
else
	STAT_FLAVOR=gnu
fi

# Mode of the path itself, never of a symlink's target.
get_mode() {
	if [ "$STAT_FLAVOR" = bsd ]; then
		stat -f '%Lp' -- "$1" 2>/dev/null
	else
		stat -c '%a' -- "$1" 2>/dev/null
	fi
}

n_ok=0
n_fail=0
n_skip=0
SKIP_LIST=''

ok() {
	n_ok=$((n_ok + 1))
	printf '  OK    %s\n' "$*"
}

fail() {
	n_fail=$((n_fail + 1))
	printf '  FAIL  %s\n' "$*"
}

skip() {
	n_skip=$((n_skip + 1))
	SKIP_LIST="$SKIP_LIST$*
"
	printf '  SKIP  %s [NOT PROTECTED]\n' "$*"
}

# --------------------------------------------------------------------- run --
EXPECT=locked
ROOT=''
while [ $# -gt 0 ]; do
	case "$1" in
	--expect-locked) EXPECT=locked ;;
	--expect-unlocked) EXPECT=unlocked ;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		shift
		ROOT=${1:-}
		break
		;;
	-*) die "unknown option: $1" ;;
	*) ROOT=$1 ;;
	esac
	shift
done

[ -n "$ROOT" ] || {
	usage >&2
	exit 2
}
[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
[ -d "$ROOT" ] || die "project root not found: $ROOT"
ROOT=$(CDPATH= cd -- "$ROOT" && pwd) || die "cannot resolve project root: $ROOT"

if [ "$EXPECT" = locked ]; then
	WANT_FILE=444
	WANT_DIR=555
else
	WANT_FILE=644
	WANT_DIR=755
fi

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/shared-verify.XXXXXX") || die "cannot create tempdir"
trap 'rm -rf "$TMPD"' EXIT
trap 'rm -rf "$TMPD"; exit 130' INT
trap 'rm -rf "$TMPD"; exit 143' TERM

manifest_read_dir >"$TMPD/dir.list" || die "cannot parse manifest"
: >"$TMPD/parents.raw"

printf 'verify-shared: expecting %s (files %s, dirs %s) [root: %s]\n' \
	"$EXPECT" "$WANT_FILE" "$WANT_DIR" "$ROOT"

# --- vaultLocked: unimplemented, say so out loud ---------------------------
# A non-empty vaultLocked list is the same class of problem as a dirLocked
# target that is not there: a manifest entry that protected exactly nothing.
# So it goes through the ordinary skip accounting and lands on the shared
# PARTIAL verdict below, rather than warning and then exiting 0.
n_vault=$(manifest_count_vault)
case "$n_vault" in
'' | *[!0-9]*) n_vault=0 ;;
esac
if [ "$n_vault" -gt 0 ]; then
	{
		printf '\n'
		printf '  WARN: manifest lists %s vaultLocked entry(ies), but vault locking is\n' "$n_vault"
		printf '  NOT IMPLEMENTED - it is neither applied by lock-shared.sh nor verified\n'
		printf '  here. Those paths are UNPROTECTED. Use dirLocked, or re-add the\n'
		printf '  vault-symlink mechanism deliberately.\n'
		printf '\n'
	} >&2
	n_v=0
	while [ "$n_v" -lt "$n_vault" ]; do
		n_v=$((n_v + 1))
		skip "vaultLocked entry #$n_v (vault locking NOT IMPLEMENTED - nothing applied, nothing verified)"
	done
fi

# --- dir-locked files ------------------------------------------------------
while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	dirname -- "$rel" >>"$TMPD/parents.raw"

	if [ -L "$ROOT/$rel" ]; then
		fail "$rel is a symlink, expected a regular file"
		continue
	fi
	if [ ! -f "$ROOT/$rel" ]; then
		skip "$rel (not present)"
		continue
	fi
	mode=$(get_mode "$ROOT/$rel")
	if [ "$mode" = "$WANT_FILE" ]; then
		ok "$rel mode 0$mode"
	else
		fail "$rel mode is 0${mode:-?}, expected 0$WANT_FILE"
	fi
done <"$TMPD/dir.list"

# --- parent dirs of dir-locked files ---------------------------------------
sort -u "$TMPD/parents.raw" >"$TMPD/parents.list"
while IFS= read -r pdir; do
	[ -n "$pdir" ] || continue
	if [ ! -d "$ROOT/$pdir" ]; then
		fail "$pdir/ missing (parent of a dir-locked file)"
		continue
	fi
	mode=$(get_mode "$ROOT/$pdir")
	if [ "$mode" = "$WANT_DIR" ]; then
		ok "$pdir/ mode 0$mode"
	else
		fail "$pdir/ mode is 0${mode:-?}, expected 0$WANT_DIR"
	fi
done <"$TMPD/parents.list"

# --- verdict ---------------------------------------------------------------
if [ "$n_skip" -eq 1 ]; then
	ENT="entry"
else
	ENT="entries"
fi

print_skips() {
	printf '%s' "$SKIP_LIST" | while IFS= read -r _s; do
		[ -n "$_s" ] || continue
		printf '    - %s\n' "$_s"
	done
}

# Hard failures win over everything else.
if [ "$n_fail" -gt 0 ]; then
	printf 'verify-shared: FAIL (%d ok, %d bad, %d skipped) - state is NOT %s\n' \
		"$n_ok" "$n_fail" "$n_skip" "$EXPECT" >&2
	if [ "$n_skip" -gt 0 ]; then
		{
			printf '\n'
			printf '  WARN: on top of the failures above, %d manifest %s produced NO\n' \
				"$n_skip" "$ENT"
			printf '  protection at all (nothing there to verify):\n'
			print_skips
		} >&2
	fi
	exit 1
fi

# No failures, but skipped entries are NOT a pass. A manifest entry that could
# not be checked protected exactly nothing.
if [ "$n_skip" -gt 0 ] && [ "$EXPECT" = locked ]; then
	{
		printf 'verify-shared: PARTIAL (%d checks verified, %d SKIPPED) - state is NOT fully %s\n' \
			"$n_ok" "$n_skip" "$EXPECT"
		printf '\n'
		printf '  WARN: %d manifest %s produced no protection. "Not present" is NOT\n' \
			"$n_skip" "$ENT"
		printf '  "protected" - that protection layer is inert right now. Treat this as a\n'
		printf '  partial pass, not a green light to dispatch builders.\n'
		printf '\n'
		printf '  Unprotected manifest %s:\n' "$ENT"
		print_skips
		printf '\n'
		printf '  Fix: create the missing target(s) and re-run lock-shared.sh, move any\n'
		printf '  vaultLocked path to dirLocked, or drop the stale %s from\n' "$ENT"
		printf '  %s\n' "$MANIFEST"
	} >&2
	exit 3
fi

# --expect-unlocked: less at stake (we are asserting the ABSENCE of a lock), so
# a skip is non-fatal, but it still gets said out loud rather than buried.
if [ "$n_skip" -gt 0 ]; then
	printf 'verify-shared: PASS WITH NOTES (%d checks verified, %d skipped) - state is %s\n' \
		"$n_ok" "$n_skip" "$EXPECT"
	printf '\n'
	printf '  NOTE: %d manifest %s produced no verification (target not present).\n' \
		"$n_skip" "$ENT"
	printf '  Non-fatal in --expect-unlocked mode: this mode asserts the ABSENCE of a\n'
	printf '  lock, and a missing file cannot be locked. Listed for the record:\n'
	print_skips
	exit 0
fi

printf 'verify-shared: PASS (%d checks, 0 skipped) - state is %s\n' \
	"$n_ok" "$EXPECT"
exit 0
