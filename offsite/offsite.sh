#!/bin/sh
# Offsite backup of this compose project: encrypted, deduplicated restic snapshots on Google Drive
# through rclone. The project is mounted read-only at /project and backed up whole but for
# offsite/exclude: the code with its git history, the .env files, the data, and the database copies
# the bot makes for it (never the live database, which a copy could catch mid-write). Snapshots carry
# OFFSITE_NAME as their host and /project as their path on any machine, so the project can move to
# another host and its backups go on (README: moving to another host).
#
# Commands: run (the default: daily at OFFSITE_TIME in TZ, or as soon after it as the container runs,
# so a night the host was off or asleep catches up; at once while this volume has no success yet),
# now, init (a new repository), snapshots, restore <empty dir>, health (the Docker healthcheck: a
# success within 36 hours). Settings: .env.offsite (offsite/env.example).
set -eu
umask 077

state=/state
stamp=$state/last-success
: "${RESTIC_REPOSITORY:?is not set (.env.offsite)}" "${RESTIC_PASSWORD:?is not set (.env.offsite)}"
export RESTIC_HOST="${OFFSITE_NAME:?is not set (docker-compose.yml)}"
export RESTIC_CACHE_DIR="$state/cache"
export RCLONE_CONFIG="$state/rclone.conf"

# A command the container's stop reaches: restic then lets go of the repository's lock.
child=
on_stop() {
  [ -z "$child" ] || kill -TERM "$child" 2>/dev/null || true
  wait
  exit 143
}
trap on_stop TERM INT
spawn() {
  "$@" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  return "$status"
}

# The rclone remote `gdrive` from the refresh token in .env.offsite, written anew each time; rclone
# keeps the access tokens it refreshes in this file.
drive() {
  case $RESTIC_REPOSITORY in rclone:*) ;; *) return 0 ;; esac
  printf '[gdrive]\ntype = drive\nscope = drive.file\ntoken = %s\n' \
    "${OFFSITE_DRIVE_TOKEN:?is not set (.env.offsite)}" >"$RCLONE_CONFIG"
}

# A snapshot, the retention, and a check that reads a 31st of the stored data back by the day of the
# month: all of it within a month. restic's exit 3 means files changed or vanished while read (a
# browser cache): the snapshot holds the rest.
backup() {
  drive || return 1
  spawn restic backup --exclude-file=/project/offsite/exclude /project || {
    [ $? -eq 3 ] && echo 'some files changed or vanished while read; the snapshot has the rest' >&2
  } || return 1
  spawn restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune || return 1
  spawn restic check --read-data-subset="$(date +%d | sed 's/^0//')/31"
}

# A failed run: the log, and once a day a message through OFFSITE_DISCORD_WEBHOOK when it is set
# (a webhook of a staff channel).
alert() {
  echo "the offsite backup of $OFFSITE_NAME failed; the next try is in an hour" >&2
  [ -n "${OFFSITE_DISCORD_WEBHOOK:-}" ] || return 0
  [ "$(cat "$state/last-alert" 2>/dev/null || true)" != "$(date +%F)" ] || return 0
  date +%F >"$state/last-alert"
  wget -q -O /dev/null --header 'Content-Type: application/json' \
    --post-data "{\"content\":\"⚠️ The offsite backup of $OFFSITE_NAME failed. Logs: docker compose logs offsite\"}" \
    "$OFFSITE_DISCORD_WEBHOOK" || echo 'the Discord alert failed too' >&2
}

run() {
  at=$((1$(printf %s "${OFFSITE_TIME:-05:30}" | tr -d :) - 10000))
  while :; do
    today=$(date +%F)
    last=$(cat "$stamp" 2>/dev/null || true)
    if [ -z "$last" ] || { [ "$last" != "$today" ] && [ $((1$(date +%H%M) - 10000)) -ge "$at" ]; }; then
      if backup; then
        echo "$today" >"$stamp"
      else
        alert
        spawn sleep 3600 || true
        continue
      fi
    fi
    spawn sleep 600 || true
  done
}

health() {
  [ -s "$stamp" ] && [ $(($(date +%s) - $(stat -c %Y "$stamp"))) -lt $((36 * 3600)) ]
}

# The newest snapshot into an empty directory (never over a live project), then the newest database
# copy in place of the live database the backup leaves out: OFFSITE_DB from OFFSITE_DB_COPIES.
restore() {
  target=${1:?usage: offsite restore <empty directory>}
  if [ ! -d "$target" ] || [ -n "$(ls -A "$target")" ]; then
    echo "$target must be an empty directory" >&2
    return 1
  fi
  drive
  spawn restic restore latest:/project --target "$target"
  [ -n "${OFFSITE_DB:-}" ] || return 0
  # A glob expands sorted, and the copies' names sort by time: the last is the newest.
  newest=
  # shellcheck disable=SC2086 # OFFSITE_DB_COPIES is a glob.
  for copy in "$target"/${OFFSITE_DB_COPIES:?is not set (docker-compose.yml)}; do
    [ ! -e "$copy" ] || newest=$copy
  done
  if [ -z "$newest" ]; then
    echo "no database copy matches $OFFSITE_DB_COPIES" >&2
    return 1
  fi
  cp -p "$newest" "$target/$OFFSITE_DB"
  echo "the live database $OFFSITE_DB is now the copy ${newest#"$target"/}"
}

mkdir -p "$state"
command=${1:-run}
[ $# -eq 0 ] || shift
case $command in
  run) run ;;
  now) backup && date +%F >"$stamp" ;;
  init) drive && spawn restic init ;;
  snapshots) drive && spawn restic snapshots ;;
  restore) restore "$@" ;;
  health) health ;;
  *)
    echo 'usage: offsite [run | now | init | snapshots | restore <empty directory> | health]' >&2
    exit 2
    ;;
esac
