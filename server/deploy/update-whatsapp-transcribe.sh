#!/usr/bin/env bash
# Deploy/Update fuer den Sprachmemo-Transkriptions-Dienst.
# Gehoert auf dem Server nach ~/scripts/update-whatsapp-transcribe.sh
#
# Achtung: Docker ist hier die Snap-Variante — Bind-Mounts unterhalb von /opt
# schlagen fehl. Deshalb liegt der Dienst unter ~/services/.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/services/whatsapp-transcribe}"

cd "$APP_DIR"

if [ ! -f .env ]; then
    echo "FEHLER: $APP_DIR/.env fehlt. Aus .env.example anlegen und AUTH_TOKEN setzen." >&2
    exit 1
fi

if [ -d .git ]; then
    echo "==> git pull"
    git pull --ff-only
fi

echo "==> docker compose build"
docker compose build

echo "==> docker compose up -d"
docker compose up -d

echo "==> warte auf /health (Modell-Ladezeit beim ersten Start: mehrere Minuten)"
for i in $(seq 1 60); do
    if curl -fsS --max-time 5 http://127.0.0.1:8099/health >/dev/null 2>&1; then
        echo
        curl -sS http://127.0.0.1:8099/health
        echo
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
