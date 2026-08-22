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

# --------------------------------------------------------------------------
# Dieses Skript laeuft als flexii, NICHT mit sudo.
#
# Gegenstueck: fix-docker-gpu.sh braucht zwingend Root. Die beiden sind also
# genau andersherum — deshalb hier ein harter Wachposten statt einer Notiz.
# --------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
    cat >&2 <<'ROOT'
FEHLER: Bitte OHNE sudo ausfuehren.

  Warum:
    - Der git-Clone braucht den GitHub-SSH-Key des Users. Root hat ihn nicht.
    - Alles, was root hier anlegt, gehoert danach root — spaetere Updates
      ohne sudo waeren damit unmoeglich.
    - Docker laeuft auf diesem Host ohnehin ohne sudo.

  Richtig:
      ~/scripts/update-whatsapp-transcribe.sh

  Mit sudo laeuft nur:
      sudo ~/scripts/fix-docker-gpu.sh
ROOT
    exit 1
fi

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

# COMPOSE_FILE steht in der .env, das Setup-Skript hat es dort hinterlegt.
backend=$(grep -m1 "^SUMMARY_BACKEND=" .env | cut -d= -f2- | tr -d "[:space:]")
llm_model=$(grep -m1 "^LLM_MODEL=" .env | cut -d= -f2- | tr -d "[:space:]")
if [ "$backend" = "local" ] && [ -n "$llm_model" ]; then
    if ! docker compose exec -T llm ollama list 2>/dev/null | awk "NR>1{print \$1}" | grep -qx "$llm_model"; then
        echo "==> Sprachmodell $llm_model fehlt, wird geladen"
        docker compose exec -T llm ollama pull "$llm_model"
    fi
fi

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
