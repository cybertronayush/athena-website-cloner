#!/usr/bin/env bash
# scope-check.sh — surface writes that landed OUTSIDE a builder's own section.
#
# Section builders run in parallel and are only supposed to write inside their
# own src/sections/<name>/ folder. Nothing enforced that, and nothing checked it
# either: two builders once both wrote src/components/ui/g-button.css, the
# collision went undetected, and it only surfaced later as a manual hand-merge.
# This script is the missing detection step — run it after a batch of builders
# finishes and BEFORE Reconcile folds their work into a commit, so a shared-file
# write is a decision the orchestrator makes on purpose rather than something
# that gets silently absorbed.
#
# ADVISORY ONLY. It reverts nothing, blocks nothing, and touches nothing on
# disk. It prints an OUT OF SCOPE list for human review and exits 1 so a
# pipeline step can notice. Compare with tripwire-check.sh, which does revert:
# that one guards three specific immutable files, this one asks the broader
# question "did anyone write somewhere they had no business writing?".
#
# Allowed-scope patterns (a changed path matching ANY of these is in scope):
#   src/sections/<name>/...   a builder's own section folder
#   docs/research/...         orchestrator research / spec artifacts
#   src/app/globals.css       codegen-generated target
#   src/app/layout.tsx        codegen-generated target
#   src/app/page.tsx          codegen-generated target
#
# Usage: scope-check.sh <root> <baseline-commit-ish>
# Exit:  0 = every changed path is in scope
#        1 = at least one out-of-scope path (listed for review)
#        2 = cannot check (bad args / no repo / unresolvable baseline)

set -uo pipefail

# Anything not matched by one of these is reported. Bash regex, anchored below.
IN_SCOPE_PATTERNS=(
  '^src/sections/[^/]+/.+$'
  '^docs/research/.+$'
  '^src/app/globals\.css$'
  '^src/app/layout\.tsx$'
  '^src/app/page\.tsx$'
)

usage() {
  cat >&2 <<EOF
Usage: ${0##*/} <root> <baseline-commit-ish>

Lists every file changed since <baseline-commit-ish> (committed, uncommitted and
untracked) and checks each path against the allowed-scope patterns:

  src/sections/<name>/...   a builder's own section folder
  docs/research/...         orchestrator research / spec artifacts
  src/app/globals.css       codegen-generated target
  src/app/layout.tsx        codegen-generated target
  src/app/page.tsx          codegen-generated target

Anything else is printed under an OUT OF SCOPE heading for orchestrator review.
Advisory only: nothing is reverted, blocked, or modified.

  -h, --help    Show this help.

Exit: 0 all in scope | 1 out-of-scope paths found | 2 cannot check
EOF
  exit 2
}

ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --)        shift; while [ "$#" -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    -*)        printf 'scope-check: unknown option: %s\n' "$1" >&2; usage ;;
    *)         ARGS+=("$1"); shift ;;
  esac
done

[ "${#ARGS[@]}" -eq 2 ] || usage

ROOT=${ARGS[0]}
BASE=${ARGS[1]}

if [ ! -d "$ROOT" ]; then
  printf 'scope-check: <root> is not a directory: %s\n' "$ROOT" >&2
  exit 2
fi

# ---------------------------------------------------------- preconditions ---
# Same stance as tripwire-check.sh: git is the ground truth here, so a missing
# repo is a hard failure rather than a silent green pass over nothing.
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'scope-check: %s is not inside a git repository.\n' "$ROOT" >&2
  printf 'scope-check: this check uses git as its ground truth and cannot run without it.\n' >&2
  printf 'scope-check: initialise a repo and commit a baseline before the builders start.\n' >&2
  exit 2
fi

if ! git -C "$ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  printf 'scope-check: cannot resolve baseline commit-ish: %s\n' "$BASE" >&2
  printf 'scope-check: pass a valid commit, tag, or ref reachable from %s.\n' "$ROOT" >&2
  exit 2
fi

# ----------------------------------------------------------------- detect ---
# `git diff --name-only <BASE>` (no second commit) compares the WORKING TREE —
# staged and unstaged both — against the baseline. That is deliberately the same
# form tripwire-check.sh uses, and it is the correct one here: this script runs
# after builders finish but before Reconcile commits, so at that moment their
# work exists only as uncommitted working-tree changes. `<BASE> HEAD` would
# compare commits and see none of it.
#
# --name-only alone still misses BRAND-NEW files, which for this check is the
# most interesting case of all (a builder inventing src/components/ui/foo.css is
# exactly the incident this exists to catch), so untracked files are listed
# separately and folded in. .gitignore is honoured via --exclude-standard so
# node_modules/.next never show up.
# --relative keeps every path relative to <root> so the scope patterns match
# even when <root> is a subdirectory of the repo.
tracked=$(git -C "$ROOT" diff --name-only --relative "$BASE" 2>/dev/null)
untracked=$(git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null)

changed=$(printf '%s\n%s\n' "$tracked" "$untracked" | sed '/^$/d' | sort -u)

if [ -z "$changed" ]; then
  printf 'scope-check: no files changed since %s — nothing to review.\n' "$BASE"
  exit 0
fi

in_scope() {
  local path=$1 pattern
  for pattern in "${IN_SCOPE_PATTERNS[@]}"; do
    [[ $path =~ $pattern ]] && return 0
  done
  return 1
}

ok=()
bad=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if in_scope "$file"; then
    ok+=("$file")
  else
    bad+=("$file")
  fi
done <<< "$changed"

total=$(( ${#ok[@]} + ${#bad[@]} ))

# ----------------------------------------------------------------- report ---
if [ "${#bad[@]}" -eq 0 ]; then
  printf 'scope-check: %d file(s) changed since %s, all in scope.\n' "$total" "$BASE"
  exit 0
fi

printf '=== OUT OF SCOPE ===\n'
printf 'baseline: %s\n' "$BASE"
printf 'root    : %s\n' "$ROOT"
printf '%d of %d changed file(s) fall outside the allowed scope:\n\n' "${#bad[@]}" "$total"
for file in "${bad[@]}"; do printf '  - %s\n' "$file"; done

printf '\nSection builders are scoped to their own src/sections/<name>/ folder.\n'
printf 'A write outside it means one of:\n'
printf '  (a) two builders touched the same shared file and the later write\n'
printf '      silently clobbered the earlier one — diff it before reconciling,\n'
printf '  (b) a builder created a shared component/util that should be promoted\n'
printf '      deliberately by the orchestrator, not smuggled in by whoever ran last,\n'
printf '  (c) legitimate orchestrator work that simply is not in the pattern list.\n'
printf '\nNothing was changed on disk. Review the paths above, then reconcile.\n'

exit 1
