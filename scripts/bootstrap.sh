#!/usr/bin/env bash
# Fetch the four upstream repositories at the commits this repo was built
# against, then apply the integration patches.
#
# Why not submodules: three of these repositories are large (Open edX is a
# monolith), and a submodule pins a *tree*, not the patches this repo carries on
# top of it. A lock file plus a patch series makes the delta reviewable in a pull
# request and keeps `git clone atheniq-evo` fast.
#
#   bash scripts/bootstrap.sh            # fetch + patch
#   bash scripts/bootstrap.sh --fetch    # fetch only
#   bash scripts/bootstrap.sh --check    # verify patches still apply, change nothing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="all"
case "${1:-}" in
  --fetch) MODE="fetch" ;;
  --check) MODE="check" ;;
  "") ;;
  *) echo "usage: $0 [--fetch|--check]" >&2; exit 2 ;;
esac

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

# name<TAB>path<TAB>repo<TAB>commit, one per line.
LOCK="$(node -e '
const lock = require("./upstream.lock.json");
for (const u of lock.upstreams) console.log([u.name, u.path, u.repo, u.commit].join("\t"));
')"

fetch_one() {
  local name="$1" path="$2" repo="$3" commit="$4"
  if [ -d "$path/.git" ]; then
    local current
    current="$(git -C "$path" rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$current" = "$commit" ]; then
      echo "  $name: already at ${commit:0:12}"
      return 0
    fi
    echo "  $name: fetching ${commit:0:12}"
    git -C "$path" fetch --depth 1 origin "$commit"
    git -C "$path" checkout -q FETCH_HEAD
    return 0
  fi

  echo "  $name: cloning ${commit:0:12}"
  mkdir -p "$path"
  git -C "$path" init -q
  git -C "$path" remote add origin "$repo"
  # A shallow fetch of the exact commit: enough to build and patch, without
  # pulling a decade of history for four repositories.
  git -C "$path" fetch --depth 1 origin "$commit"
  git -C "$path" checkout -q FETCH_HEAD
}

patch_one() {
  local name="$1" dir="patches/$1"
  [ -d "$dir" ] || return 0
  shopt -s nullglob
  local patches=("$dir"/*.patch)
  shopt -u nullglob
  [ ${#patches[@]} -gt 0 ] || return 0

  for patch in "${patches[@]}"; do
    local target="upstream/$name"
    if git -C "$target" apply --reverse --check "$patch" >/dev/null 2>&1; then
      echo "  $name: $(basename "$patch") already applied"
      continue
    fi
    if ! git -C "$target" apply --check "$patch" >/dev/null 2>&1; then
      echo "  $name: $(basename "$patch") does NOT apply — the upstream commit moved" >&2
      return 1
    fi
    if [ "$MODE" = "check" ]; then
      echo "  $name: $(basename "$patch") applies cleanly"
      continue
    fi
    git -C "$target" apply "$patch"
    echo "  $name: applied $(basename "$patch")"
  done
}

echo "atheniq-evo bootstrap ($MODE)"
while IFS=$'\t' read -r name path repo commit; do
  [ -n "$name" ] || continue
  fetch_one "$name" "$path" "$repo" "$commit"
done <<< "$LOCK"

if [ "$MODE" = "fetch" ]; then
  echo "Fetched. Run without --fetch to apply patches."
  exit 0
fi

echo "Applying integration patches"
while IFS=$'\t' read -r name _path _repo _commit; do
  [ -n "$name" ] || continue
  patch_one "$name"
done <<< "$LOCK"

echo
echo "Next:"
echo "  cp .env.example .env      # then fill in the secrets"
echo "  npm test                  # the bridge's integration suite"
echo "  docker compose up --build # bridge + classroom + console"
