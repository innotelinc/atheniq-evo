#!/usr/bin/env bash
# Bring the estate up the way this repository means it: start, wait for healthy,
# then prove the classroom image serves the frame policy this estate configured.
#
# The classroom's CSP is baked at build time, so a digest pin alone says *which*
# build runs, not that it was made for this estate. A wrong one does not fail
# anything visible — the registrar's iframe is just blank — which is why the
# check has to be part of bring-up rather than a command somebody remembers:
#
#   npm run up
#   bash scripts/up.sh --no-deps      # services already running; re-check only
#
# Exit status: 0 up and matching, 1 a service did not become healthy or the
# image disagrees with OPENMAIC_FRAME_ANCESTORS, 2 Compose itself failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --no-deps) CHECK_ONLY="1" ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [--no-deps]" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "up: docker is not installed" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "up: 'docker compose' is not available" >&2; exit 2; }

# Ask the engine once, under a bound: with the daemon stopped, some Docker
# commands on Windows block on a named pipe instead of failing.
engine_up() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 docker info >/dev/null 2>&1
  else
    docker info >/dev/null 2>&1
  fi
}
engine_up || { echo "up: the Docker engine is not running (start Docker Desktop, or the daemon on this host)" >&2; exit 2; }

if [ -z "$CHECK_ONLY" ]; then
  echo "up: starting the stack and waiting for healthy services"
  # --wait turns a container that never becomes healthy into this command's
  # failure, instead of a "Started" line followed by a broken estate.
  docker compose up -d --wait --wait-timeout "${ATHENIQ_WAIT_TIMEOUT:-300}"
fi

echo
echo "up: checking the classroom image's frame policy"
# --no-deps: the stack is already up; starting the classroom again to check it
# would make the check cheaper than the thing it verifies. The script inside
# retries for a minute, so a classroom still compiling its first request passes.
if ! docker compose run --rm --no-deps csp-check; then
  echo >&2
  echo "up: the stack is running, but the classroom image does not serve this" >&2
  echo "    estate's frame policy, so the registrar's classroom iframe would be" >&2
  echo "    blank. Fix the image, then re-run 'bash scripts/up.sh --no-deps':" >&2
  echo >&2
  echo "      docker compose pull openmaic && docker compose up -d openmaic" >&2
  echo "    or, for a frame origin the published image does not carry:" >&2
  echo "      OPENMAIC_IMAGE=openmaic:local OPENMAIC_FRAME_ANCESTORS=\"\$OPENMAIC_FRAME_ANCESTORS\" \\" >&2
  echo "        docker compose build openmaic" >&2
  echo "      OPENMAIC_IMAGE=openmaic:local docker compose up -d --pull never openmaic" >&2
  exit 1
fi

echo
echo "up: the estate is up and the classroom accepts this estate's frame ancestors"
