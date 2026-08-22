#!/usr/bin/env bash
#
# Update des Sprachmemo-Transkriptions-Dienstes.
# Gehoert auf dem Server nach ~/scripts/update-whatsapp-transcribe.sh
#
# Erstinstallation macht setup-whatsapp-transcribe.sh — dieses Skript setzt
# ein fertig eingerichtetes Repo samt .env voraus.
#
# Achtung: Docker ist hier die Snap-Variante, Bind-Mounts unterhalb von /opt
# schlagen fehl. Deshalb liegt der Dienst unter ~/services/.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/services/whatsapp-transcribe}"
APP_DIR="$REPO_DIR/server"
PORT=8099

[ -d "$REPO_DIR/.git" ] || {
    echo "FEHLER: $REPO_DIR ist kein Git-Repo. Erst ~/scripts/setup-whatsapp-transcribe.sh laufen lassen." >&2
    exit 1
}
[ -f "$APP_DIR/.env" ] || {
    echo "FEHLER: $APP_DIR/.env fehlt. Erst ~/scripts/setup-whatsapp-transcribe.sh laufen lassen." >&2
    exit 1
}

echo "==> git pull"
git -C "$REPO_DIR" pull --ff-only

cd "$APP_DIR"

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> warte auf /health"
for i in $(seq 1 60); do
    if body=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null); then
        echo
        echo "$body"
        echo "==> OK"
        exit 0
    fi
    printf '.'
    sleep 10
done

echo >&2
echo "FEHLER: /health antwortet nach 10 Minuten nicht. Logs:" >&2
docker compose logs --tail 60 >&2
exit 1
