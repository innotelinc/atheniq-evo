#!/usr/bin/env bash
# Put the repository's infra/ tree into the Coolify application directory, so the
# compose file's relative file bind mounts resolve, and write the SMTP submission
# password file those mounts need at mode 0444.
#
# Run as root on the i3 deploy host (192.168.1.53). Idempotent: a second run
# changes nothing, prints the same three OK lines, and leaves an existing
# password file (and its value) alone.
#
#   ./fix-infra-mounts.sh                                  # fetch the pinned commit
#   ./fix-infra-mounts.sh --source /root/signara-src       # use a checkout you have
#   ./fix-infra-mounts.sh --smtp-password-file /root/smtp  # write the password from a file
#   vault kv get -field=SMTP_PASSWORD cerulean/signara | ./fix-infra-mounts.sh
#
# The password is never echoed or put in shell history: only its byte count is
# reported.
set -euo pipefail

APP="${SIGNARA_APP_DIR:-/data/coolify/applications/4vzo0yw5ipz3m8cx9fuptr4d}"
GIT_URL="${SIGNARA_GIT_URL:-https://github.com/innotelinc/signara.git}"
COMMIT="${SIGNARA_COMMIT:-6555303fce6932bb2118905321b933321a7b369c}"
PW_FILE="$APP/infra/secrets/smtp_password"

# Every relative file mount in docker-compose.prod.yml. Each has to be a regular
# file: Docker creates an empty directory for a missing source, and `up -d` then
# dies on `not a directory` before the rest of the stack starts.
MOUNT_SOURCES=(
  infra/monitoring/alertmanager/alertmanager.yml
  infra/monitoring/alertmanager/entrypoint.sh
  infra/monitoring/alertmanager/email.tmpl
  infra/monitoring/prometheus/prometheus.yml
  infra/monitoring/prometheus/rules.yml
  infra/monitoring/dns_probe.py
  infra/backup/backup_metrics.py
  infra/secrets/smtp_password
)

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

SOURCE=""
PW_SOURCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --smtp-password-file) PW_SOURCE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root on the i3 deploy host"
[ -n "$APP" ] && [ "$APP" != "/" ] || die "refusing an empty application directory"
case "$APP" in
  /data/coolify/applications/*) ;;
  *) [ "${SIGNARA_ALLOW_OTHER_APP_DIR:-0}" = "1" ] \
       || die "refusing $APP: not a Coolify application path (SIGNARA_ALLOW_OTHER_APP_DIR=1 overrides)" ;;
esac
[ -d "$APP" ] || die "no application directory at $APP"

CLONE=""
KEEP_PW=""
cleanup() {
  [ -n "$CLONE" ] && rm -rf -- "$CLONE"
  [ -n "$KEEP_PW" ] && rm -f -- "$KEEP_PW"
  return 0
}
trap cleanup EXIT

# --- work out where the real infra/ tree comes from -------------------------

if [ -n "$SOURCE" ]; then
  [ -d "$SOURCE/infra" ] || die "--source $SOURCE has no infra/ directory"
  SRC="$SOURCE"
  head="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)"
  [ "$head" = "$COMMIT" ] \
    || printf 'WARN: %s is at %s, not the pinned %s\n' \
         "$SRC" "${head:0:12}" "${COMMIT:0:12}" >&2
else
  command -v git >/dev/null || die "git is required to fetch the pinned commit"
  CLONE="$(mktemp -d)"
  git -C "$CLONE" init -q
  git -C "$CLONE" remote add origin "$GIT_URL"
  git -C "$CLONE" fetch -q --depth 1 origin "$COMMIT" \
    || die "could not fetch ${COMMIT:0:12} from $GIT_URL (private repo: pass --source with an existing checkout)"
  git -C "$CLONE" checkout -q FETCH_HEAD
  SRC="$CLONE"
fi
[ -d "$SRC/infra" ] || die "$SRC has no infra/ directory"

# The password file is not committed, so replacing the tree would drop it.
if [ -f "$PW_FILE" ] && [ -s "$PW_FILE" ]; then
  KEEP_PW="$(mktemp)"
  cp -p -- "$PW_FILE" "$KEEP_PW"
fi

# --- step 1: the infra/ tree in the application directory -------------------

poisoned=""
if [ -d "$APP/infra" ]; then
  poisoned="$(find "$APP/infra" -mindepth 1 -type d \
    \( -name '*.yml' -o -name '*.sh' -o -name '*.py' -o -name '*.tmpl' \) \
    -print -quit 2>/dev/null || true)"
fi

same=0
if [ -d "$APP/infra" ] && [ -z "$poisoned" ] \
   && diff -rq -x smtp_password "$SRC/infra" "$APP/infra" >/dev/null 2>&1; then
  same=1
fi

if [ "$same" -eq 1 ]; then
  printf 'leaving %s/infra in place: it already matches %s\n' "$APP" "${COMMIT:0:12}"
else
  if [ -d "$APP/infra" ]; then
    printf 'replacing %s/infra (mount sources that Docker made into directories)\n' "$APP"
    rm -rf -- "$APP/infra"
  fi
  cp -a -- "$SRC/infra" "$APP/infra"
  if [ -n "$KEEP_PW" ]; then
    cp -p -- "$KEEP_PW" "$PW_FILE"
  fi
  printf 'copied infra/ from %s\n' "$SRC"
fi

# Count the tree without the password file, so the line reads the same on every run.
files="$(find "$APP/infra" -type f ! -name smtp_password | wc -l | tr -d ' ')"
printf 'OK 1/3 infra/ tree at %s matches %s (%s files, %s mount sources)\n' \
  "$APP" "${COMMIT:0:12}" "$files" "${#MOUNT_SOURCES[@]}"

# --- step 2: no mount source may be a directory -----------------------------

dirs="$(find "$APP/infra" -mindepth 1 -type d \
  \( -name '*.yml' -o -name '*.sh' -o -name '*.py' -o -name '*.tmpl' \) \
  -print 2>/dev/null || true)"
[ -z "$dirs" ] || die "these mount sources are still directories: $(tr '\n' ' ' <<<"$dirs")"
printf 'OK 2/3 no mount source under %s/infra is a directory\n' "$APP"

# --- step 3: the SMTP password file, mode 0444 ------------------------------

write_pw() {
  local pw="$1" tmp
  [ -n "$pw" ] || die "refusing to write an empty password"
  tmp="$(mktemp "$APP/infra/secrets/.smtp_password.XXXXXX")"
  printf '%s' "$pw" > "$tmp"
  chmod 0444 -- "$tmp"
  mv -f -- "$tmp" "$PW_FILE"
}

if [ -f "$PW_FILE" ] && [ -s "$PW_FILE" ]; then
  printf 'leaving %s in place: already written\n' "$PW_FILE"
  chmod 0444 -- "$PW_FILE"
elif [ -n "$PW_SOURCE" ]; then
  [ -r "$PW_SOURCE" ] || die "cannot read --smtp-password-file $PW_SOURCE"
  write_pw "$(cat -- "$PW_SOURCE")"
elif [ -t 0 ]; then
  printf 'SMTP submission password (input hidden): ' >&2
  read -rs PW
  printf '\n' >&2
  write_pw "${PW:-}"
  unset PW
else
  write_pw "$(cat)"
fi

mode="$(stat -c '%a' -- "$PW_FILE")"
size="$(wc -c < "$PW_FILE" | tr -d ' ')"
[ "$mode" = "444" ] || die "$PW_FILE has mode $mode, expected 444"
[ "$size" -gt 0 ] || die "$PW_FILE is empty"
printf 'OK 3/3 %s is a regular file, mode 0444, %s bytes\n' "$PW_FILE" "$size"

# --- final gate: every mount source resolves to a regular file --------------

for rel in "${MOUNT_SOURCES[@]}"; do
  path="$APP/$rel"
  [ -f "$path" ] || die "$rel is not a regular file after this run"
done

printf 'Done: redeploy signara in Coolify; the log must reach "Deployment successful" with no "not a directory".\n'
