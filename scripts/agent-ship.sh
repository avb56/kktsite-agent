#!/usr/bin/env bash
# Выпуск агента на сервер одной командой: артефакт сборки → подпись → узел.
#
#   scripts/agent-ship.sh --ship kkt@prod [--dir /srv/kkt] [артефакт.zip] [--no-prune] [--dry-run]
#
#   артефакт   zip, скачанный из Actions (agent-release → kktsite-agent-release);
#              без аргумента — самый новый kktsite-agent-release*.zip в
#              ~/Загрузки или ~/Downloads
#   --ship     ssh-цель узла, как у scripts/release.sh в claude-test
#   --dir      каталог стека на узле (по умолчанию /srv/kkt); агент ляжет в
#              <dir>/static/agent, страница разделов dl.kktsite.ru — в <dir>/static/dl
#   --dl-index страница разделов dl.kktsite.ru (по умолчанию — из соседнего
#              клона claude-test: ../claude-test/docs/deploy/dl/index.html;
#              нет его — страница разделов не обновляется)
#   --no-prune не убирать с узла прежние выпуски
#   --dry-run  распаковать, подписать и проверить здесь, а команды для узла
#              только напечатать
#   AGENT_SHIP_SSH_OPTS — свои параметры ssh, например '-o Port=2222'
#   AGENT_GH_REPO       — репозиторий выпусков (по умолчанию avb56/kktsite-agent)
#
# Подпись — здесь, ключом ~/.config/kktsite-agent-release/signing-key.pem
# (agent-release.mjs): в CI его нет. Соединение с узлом одно (ControlMaster)
# — пароль спрашивается один раз. Файлы идут через tar | ssh — на узле ничего
# ставить не нужно.
#
# АРХИВ ВЫПУСКОВ — GitHub Releases этого репозитория: их создаёт agent-release
# (v<версия> с архивами). На узле остаётся только текущий выпуск — его берут
# агенты для обновления, и только он попадает в полную копию узла;
# dl.kktsite.ru/agent/archive/ ведёт на Releases.
#
# Порядок:
#   1) архивы на узел (с версией в имени — существующие не трогаются, агенты
#      могут их ещё докачивать) → страницы → latest.json.sig и latest.json через
#      временные имена и mv: агент не прочтёт новый latest.json со старой
#      подписью (в худшем случае — старый со старой, и обновится завтра);
#   2) уборка узла: всё, чего нет в новом latest.json, удаляется — но только
#      если в GitHub Release той версии лежит тот же файл (sha256 из API
#      GitHub, без токена). Чего там нет или что отличается — остаётся на узле,
#      скрипт об этом скажет;
#   3) подписанный latest.json и подпись — в GitHub Release этой версии, если
#      есть gh с входом (gh auth login); нет — печатается команда.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GH_REPO="${AGENT_GH_REPO:-avb56/kktsite-agent}"
SHIP=""
REMOTE_DIR="/srv/kkt"
DL_INDEX="$ROOT/../claude-test/docs/deploy/dl/index.html"
ARTIFACT=""
PRUNE=1
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ship) SHIP="${2:?--ship ЦЕЛЬ}"; shift 2 ;;
    --dir) REMOTE_DIR="${2:?--dir ПУТЬ}"; shift 2 ;;
    --dl-index) DL_INDEX="${2:?--dl-index ФАЙЛ}"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    -*) echo "Неизвестный параметр: $1" >&2; exit 1 ;;
    *) ARTIFACT="$1"; shift ;;
  esac
done
[ -n "$SHIP" ] || [ "$DRY" = 1 ] || { echo "Нужен --ship ЦЕЛЬ (или --dry-run)" >&2; exit 1; }

if [ -z "$ARTIFACT" ]; then
  ARTIFACT="$(ls -t "$HOME"/Загрузки/kktsite-agent-release*.zip "$HOME"/Downloads/kktsite-agent-release*.zip 2>/dev/null | head -1 || true)"
  [ -n "$ARTIFACT" ] || { echo "Нет kktsite-agent-release*.zip в ~/Загрузки и ~/Downloads — укажите путь" >&2; exit 1; }
fi
echo "артефакт: $ARTIFACT ($(date -r "$ARTIFACT" '+%d.%m.%Y %H:%M'))"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-ship.XXXXXX")"
SSH_DIR=""
cleanup() {
  if [ -n "$SSH_DIR" ]; then
    ssh -o ControlPath="$SSH_DIR/s" -O exit "$SHIP" 2>/dev/null || true
    rm -rf "$SSH_DIR"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

python3 -m zipfile -e "$ARTIFACT" "$WORK"
[ -d "$WORK/files" ] || { echo "В артефакте нет files/ — это не kktsite-agent-release?" >&2; exit 1; }
node "$HERE/agent-release.mjs" sign "$WORK"
node "$HERE/agent-release.mjs" verify "$WORK"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$WORK/latest.json")"
# Имена файлов текущего выпуска — всё, что остаётся на узле после уборки.
KEEP="$(node -e "const o = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  for (const e of [...Object.values(o.files || {}), ...Object.values(o.installers || {})]) console.log(e.file.replace(/^files\//, ''));" "$WORK/latest.json" | sort -u)"
cp "$HERE/../packaging/site/index.html" "$WORK/agent-index.html"
HAVE_DL_INDEX=0
if [ -f "$DL_INDEX" ]; then cp "$DL_INDEX" "$WORK/dl-index.html"; HAVE_DL_INDEX=1
else echo "страница разделов не найдена ($DL_INDEX) — dl.kktsite.ru/ не обновляется"; fi

AGENT="$REMOTE_DIR/static/agent"
DL="$REMOTE_DIR/static/dl"

if [ "$DRY" = 1 ]; then
  echo
  echo "--dry-run: на узел ${SHIP:-<ЦЕЛЬ>} ушло бы:"
  echo "  mkdir -p $AGENT/files $DL"
  echo "  files/ → $AGENT/files/ (только новых, существующие не трогаются):"
  ls -la "$WORK/files" | tail -n +2 | sed 's/^/    /'
  echo "  index.html → $AGENT/index.html$([ "$HAVE_DL_INDEX" = 1 ] && echo ", $DL/index.html")"
  echo "  latest.json.sig, latest.json → $AGENT/ (через .new и mv)"
  if [ "$PRUNE" = 1 ]; then
    echo "  уборка $AGENT/files: остаются только"
    sed 's/^/    /' <<<"$KEEP"
    echo "    остальное удаляется, если в GitHub Release ($GH_REPO) лежит тот же файл"
  fi
  echo "  latest.json, latest.json.sig → GitHub Release v$VERSION ($GH_REPO)"
  exit 0
fi

SSH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-ship-ssh.XXXXXX")"
SSH_OPTS=(-o ControlPath="$SSH_DIR/s")
# Свои параметры ssh (порт, ключ …): AGENT_SHIP_SSH_OPTS='-o Port=2222'.
# shellcheck disable=SC2206
[ -n "${AGENT_SHIP_SSH_OPTS:-}" ] && SSH_OPTS+=(${AGENT_SHIP_SSH_OPTS})
# Мастер-соединение: пароль — здесь, один раз; дальше все ssh/scp через его сокет.
ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -f -N "$SHIP"

P() { ssh "${SSH_OPTS[@]}" "$SHIP" "$@"; }

# sha256 файлов из списка (stdin), которые есть в каталоге $1 узла:
# строки «сумма  имя», отсутствующих нет.
fRemoteSums() {
  P "cd '$1' 2>/dev/null || exit 0; while IFS= read -r f; do [ -n \"\$f\" ] && [ -e \"\$f\" ] && sha256sum -- \"\$f\"; done; true"
}

# Имена, у которых суммы в двух списках «сумма  имя» различаются.
fDiffering() {
  join -j 2 <(sort -k2 <<<"$1") <(sort -k2 <<<"$2") | awk '$2 != $3 {print $1}'
}

P "mkdir -p '$AGENT/files' '$DL'"

# Та же версия, другая сборка: архив на узле не перезапишется, а latest.json
# подписан по новому — агенты отвергнут обновление по sha256. Остановиться
# до любых изменений на узле (пересобрали, не подняв версию).
NEW_NAMES="$(cd "$WORK/files" && ls -1)"
LOCAL_SUMS="$(cd "$WORK/files" && sha256sum -- *)"
CONFLICT="$(fDiffering "$LOCAL_SUMS" "$(fRemoteSums "$AGENT/files" <<<"$NEW_NAMES")")"
if [ -n "$CONFLICT" ]; then
  echo "На узле уже лежат другие файлы с теми же именами — та же версия, другая сборка:" >&2
  sed 's/^/  /' <<<"$CONFLICT" >&2
  echo "Поднимите версию в package.json и соберите выпуск заново. На узле ничего не менялось." >&2
  exit 1
fi

# Во временный каталог и перенос только новых: --skip-old-files есть не у
# всякого tar (busybox его не знает), а это — обычный sh.
tar -C "$WORK/files" -cf - . | P "set -e; T='$AGENT/.incoming'; rm -rf \"\$T\"; mkdir -p \"\$T\"; tar -C \"\$T\" -xf -; for f in \"\$T\"/*; do [ -e \"\$f\" ] || continue; n=\$(basename \"\$f\"); [ -e '$AGENT/files/'\"\$n\" ] || mv \"\$f\" '$AGENT/files/'; done; rm -rf \"\$T\""
scp -q "${SSH_OPTS[@]}" "$WORK/agent-index.html" "$SHIP:$AGENT/index.html"
[ "$HAVE_DL_INDEX" = 1 ] && scp -q "${SSH_OPTS[@]}" "$WORK/dl-index.html" "$SHIP:$DL/index.html"
scp -q "${SSH_OPTS[@]}" "$WORK/latest.json.sig" "$SHIP:$AGENT/latest.json.sig.new"
scp -q "${SSH_OPTS[@]}" "$WORK/latest.json" "$SHIP:$AGENT/latest.json.new"
P "cd '$AGENT' && mv latest.json.sig.new latest.json.sig && mv latest.json.new latest.json"

# --- уборка узла: прежние выпуски — только те, что есть в GitHub Releases ----
if [ "$PRUNE" = 1 ]; then
  OLD="$(comm -23 <(P "cd '$AGENT/files' && ls -1" | sort) <(sort <<<"$KEEP"))"
  if [ -n "$OLD" ]; then
    OLD_SUMS="$(fRemoteSums "$AGENT/files" <<<"$OLD")"
    # «сумма  имя» файлов из GitHub Releases тех версий, что есть в $OLD.
    GH_SUMS=""
    for V in $(sed -nE 's/^kktsite-agent-([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/p' <<<"$OLD" | sort -u); do
      GH_SUMS+="$(curl -fsS "https://api.github.com/repos/$GH_REPO/releases/tags/v$V" 2>/dev/null \
        | node -e "let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
            for (const a of JSON.parse(s).assets || []) if (a.digest?.startsWith('sha256:')) console.log(a.digest.slice(7) + '  ' + a.name); })" || true)"$'\n'
    done
    GONE=""; KEPT=""
    while IFS= read -r LINE; do
      [ -n "$LINE" ] || continue
      SUM="${LINE%%  *}"; NAME="${LINE#*  }"
      if grep -qxF "$SUM  $NAME" <<<"$GH_SUMS"; then GONE+="$NAME"$'\n'
      else KEPT+="$NAME"$'\n'; fi
    done <<<"$OLD_SUMS"
    if [ -n "$GONE" ]; then
      P "cd '$AGENT/files' && rm -f -- $(tr '\n' ' ' <<<"$GONE")"
      echo "с узла убраны прежние выпуски (есть в GitHub Releases): $(grep -c . <<<"$GONE") файл(ов)"
    fi
    if [ -n "$KEPT" ]; then
      echo "остались на узле — в GitHub Releases их нет или они там другие:"
      sed '/^$/d; s/^/  /' <<<"$KEPT"
      echo "  выложить версию в Releases: gh release create vВЕРСИЯ файлы… --repo $GH_REPO; потом agent-ship ещё раз"
    fi
  fi
fi
P "ls -la '$AGENT/files' | tail -n +2"

# --- подписанный latest.json — в GitHub Release этой версии -------------------
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh release upload "v$VERSION" "$WORK/latest.json" "$WORK/latest.json.sig" --repo "$GH_REPO" --clobber; then
    echo "GitHub Release v$VERSION: добавлены latest.json и latest.json.sig"
  else
    echo "GitHub Release v$VERSION не принял latest.json — выпуска с таким тегом нет? (собран не через agent-release)"
  fi
else
  # Рядом с артефактом: временный каталог скрипта удаляется при выходе.
  SIGNED="${ARTIFACT%.zip}-signed"
  mkdir -p "$SIGNED" && cp "$WORK/latest.json" "$WORK/latest.json.sig" "$SIGNED/"
  echo "gh без входа — latest.json в Release не добавлен. Руками (файлы в $SIGNED):"
  echo "  gh release upload v$VERSION '$SIGNED/latest.json' '$SIGNED/latest.json.sig' --repo $GH_REPO --clobber"
fi

echo
echo "Выложено: kktsite-agent $VERSION → $SHIP:$AGENT"
echo "  страница:    https://dl.kktsite.ru/agent/"
echo "  обновления:  https://dl.kktsite.ru/agent/latest.json (агенты проверяют раз в сутки)"
echo "  все выпуски: https://github.com/$GH_REPO/releases"
