#!/bin/sh
# Установка kktsite-agent (Linux, macOS) из распакованного архива выпуска:
#   sudo ./install.sh [--user <кто>] [--port 16732] [--https-port N] [--dir /opt/kktsite-agent]
# Ставит в /opt/kktsite-agent (macOS — /usr/local/kktsite-agent) и запускает
# службой от пользователя, вызвавшего sudo. Повторный запуск — переустановка.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
exec "$HERE/node/node" "$HERE/app/src/main.js" install "$@"
