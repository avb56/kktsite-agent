#!/bin/sh
# Удаление kktsite-agent: sudo ./uninstall.sh [--dir /opt/kktsite-agent]
# Данные агента (ККТ, учётки, сертификат) не удаляются.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
exec "$HERE/node/node" "$HERE/app/src/main.js" uninstall "$@"
