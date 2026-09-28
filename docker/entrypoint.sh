#!/bin/sh
# Точка входа контейнера wtbot.
# 1. Готовит каталог данных: том с хоста часто принадлежит root.
# 2. Поднимает виртуальный X-дисплей для браузера (Cloudflare не пропускает
#    headless) и, если задан WT_VNC_PASSWORD, VNC-доступ к нему на порту 5900
#    для ручной проверки Cloudflare или входа на warthunder.com.
# 3. Запускает команду от непривилегированного пользователя node.
set -eu

DATA_DIR="$(dirname "${DB_PATH:-/app/data/wtbot.db}")"
AS_NODE=""
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    echo "[entrypoint] передаю каталог $DATA_DIR пользователю node"
    chown -R node:node "$DATA_DIR" || echo "[entrypoint] chown $DATA_DIR не удался — проверьте права тома" >&2
  fi
  # setpriv не меняет окружение: без HOME=/home/node Chromium писал бы в /root.
  AS_NODE="setpriv --reuid=node --regid=node --init-groups -- env HOME=/home/node USER=node"
fi

if [ -n "${DISPLAY:-}" ] && [ "${WT_BROWSER_ENABLED:-true}" != "false" ]; then
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  # Lock прошлого контейнера мешает Xvfb занять тот же номер дисплея.
  rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
  $AS_NODE Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp -ac >/dev/null 2>&1 &
  attempt=0
  while [ ! -S "/tmp/.X11-unix/X${display_number}" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 100 ]; then
      echo "[entrypoint] Xvfb не запустился на $DISPLAY" >&2
      exit 1
    fi
    sleep 0.1
  done

  if [ -n "${WT_VNC_PASSWORD:-}" ]; then
    vnc_dir=/tmp/wtbot-vnc
    mkdir -p "$vnc_dir"
    if [ -n "$AS_NODE" ]; then
      chown node:node "$vnc_dir"
    fi
    $AS_NODE x11vnc -storepasswd "$WT_VNC_PASSWORD" "$vnc_dir/passwd" >/dev/null 2>&1
    $AS_NODE x11vnc -display "$DISPLAY" -rfbauth "$vnc_dir/passwd" -rfbport 5900 \
      -forever -shared -quiet -bg -o "$vnc_dir/x11vnc.log"
    echo "[entrypoint] VNC-доступ к дисплею $DISPLAY включён на порту 5900"
  fi
fi

exec $AS_NODE "$@"
