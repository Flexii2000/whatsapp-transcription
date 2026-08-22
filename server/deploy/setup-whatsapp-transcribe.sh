#!/usr/bin/env bash
#
# Erstinstallation des Sprachmemo-Transkriptions-Dienstes.
# Gehoert auf dem Server nach ~/scripts/setup-whatsapp-transcribe.sh
#
# Gefahrlos wiederholbar: vorhandene .env und bereits geklonte Repos werden
# nicht ueberschrieben, das Skript zieht dann nur nach.
#
# Was es NICHT tut: alles was Root braucht. Der User hat hier kein
# passwortloses sudo, deshalb druckt das Skript die nginx-Schritte am Ende
# nur aus, statt sie auszufuehren.
set -euo pipefail

REPO_URL="git@github.com:Flexii2000/whatsapp-transcription.git"
REPO_DIR="$HOME/services/whatsapp-transcribe"
APP_DIR="$REPO_DIR/server"
SCRIPTS_DIR="$HOME/scripts"
PORT=8099
PUBLIC_URL="https://fherrmann.com/whisper"

DRY_RUN=0
case "${1:-}" in
    --check|-n) DRY_RUN=1 ;;
    "")         ;;
    *)          echo "Aufruf: $0 [--check]" >&2; exit 2 ;;
esac

if [ -t 1 ]; then
    B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
    R=$(printf '\033[31m'); N=$(printf '\033[0m')
else
    B=""; G=""; Y=""; R=""; N=""
fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "  ${G}OK${N}   $*"; }
warn() { echo "  ${Y}!${N}    $*"; }
die()  { echo "  ${R}FEHLER${N} $*" >&2; exit 1; }

# --------------------------------------------------------------- Vorpruefung

step "Vorprüfung"

command -v docker >/dev/null || die "docker nicht gefunden."
docker ps >/dev/null 2>&1 || die "Kein Zugriff auf den Docker-Daemon."
ok "docker erreichbar"

docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) fehlt."
ok "docker compose v2 vorhanden"

if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
    if docker ps --format '{{.Names}}' | grep -qx whatsapp-transcribe; then
        ok "Port $PORT ist vom eigenen Container belegt"
    else
        die "Port $PORT ist von etwas anderem belegt."
    fi
else
    ok "Port $PORT ist frei"
fi

free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
[ "${free_gb:-0}" -ge 10 ] \
    && ok "${free_gb} GB frei (Modell + Image brauchen ~6 GB)" \
    || warn "nur ${free_gb} GB frei — Modell und Image brauchen ~6 GB"

if [ "$DRY_RUN" = 1 ]; then
    step "Bestandsaufnahme (--check: es wird nichts verändert)"
    [ -d "$REPO_DIR/.git" ] && ok "Repo vorhanden: $REPO_DIR" \
                           || warn "Repo fehlt — würde geklont: $REPO_DIR"
    [ -f "$APP_DIR/.env" ]  && ok ".env vorhanden — bliebe unangetastet" \
                           || warn ".env fehlt — würde mit neuem AUTH_TOKEN angelegt"
    if docker ps --format '{{.Names}}' | grep -qx whatsapp-transcribe; then
        ok "Container läuft bereits"
    else
        warn "Container läuft nicht — würde gebaut und gestartet"
    fi
    [ -f /etc/nginx/snippets/whisper.conf ] && ok "nginx-Snippet installiert" \
                                           || warn "nginx-Snippet fehlt (braucht Root)"
    if grep -qs 'snippets/whisper.conf' /etc/nginx/sites-available/fherrmann.com; then
        ok "include-Zeile in fherrmann.com vorhanden"
    else
        warn "include-Zeile in fherrmann.com fehlt (braucht Root)"
    fi
    echo
    echo "  Ohne --check würde das Skript den Rest einrichten."
    exit 0
fi

# ------------------------------------------------------------------- Quellen

step "Quellen"

mkdir -p "$HOME/services" "$SCRIPTS_DIR"

if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" pull --ff-only
    ok "Repo aktualisiert: $REPO_DIR"
else
    [ -e "$REPO_DIR" ] && die "$REPO_DIR existiert, ist aber kein Git-Repo."
    git clone "$REPO_URL" "$REPO_DIR"
    ok "Repo geklont nach $REPO_DIR"
fi

for s in setup update; do
    src="$APP_DIR/deploy/$s-whatsapp-transcribe.sh"
    dst="$SCRIPTS_DIR/$s-whatsapp-transcribe.sh"
    # Nur bei Unterschied anfassen: dieses Skript kann sich sonst selbst
    # unter den Füßen wegziehen, während bash noch daraus liest.
    if cmp -s "$src" "$dst"; then
        ok "$dst ist aktuell"
    else
        install -m 755 "$src" "$dst"
        ok "$dst aktualisiert"
    fi
done

# ---------------------------------------------------------------------- .env

step "Konfiguration"

if [ -f "$APP_DIR/.env" ]; then
    ok ".env existiert bereits — bleibt unangetastet"
else
    umask 077
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    token=$(openssl rand -hex 32)
    sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=$token|" "$APP_DIR/.env"
    ok "AUTH_TOKEN erzeugt und eingetragen"

    # Der Key wird nur eingelesen, wenn wirklich jemand am Terminal sitzt,
    # und niemals angezeigt oder protokolliert.
    if [ -t 0 ]; then
        echo
        echo "  Anthropic-API-Key für die Stichpunkt-Zusammenfassung."
        echo "  Leer lassen und Enter drücken = nur Transkripte, keine Stichpunkte."
        printf "  Key (Eingabe bleibt unsichtbar): "
        read -rs key || key=""
        echo
        if [ -n "$key" ]; then
            sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$key|" "$APP_DIR/.env"
            ok "API-Key eingetragen"
        else
            warn "Kein Key — Stichpunkte bleiben aus, Transkripte laufen"
        fi
        unset key
    fi
fi
chmod 600 "$APP_DIR/.env"

grep -q '^AUTH_TOKEN=.\+' "$APP_DIR/.env" || die "AUTH_TOKEN fehlt in $APP_DIR/.env"
grep -q '^ANTHROPIC_API_KEY=.\+' "$APP_DIR/.env" \
    || warn "ANTHROPIC_API_KEY ist leer — es gibt nur Transkripte"

# -------------------------------------------------------------------- Bauen

step "Container bauen und starten"
echo "  Beim ersten Mal dauert das einige Minuten (Image + Whisper-Modell ~1,6 GB)."
cd "$APP_DIR"
docker compose build
docker compose up -d
ok "Container läuft"

step "Warte auf /health"
for i in $(seq 1 90); do
    if body=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null); then
        echo
        ok "Dienst antwortet"
        echo "       $body"
        break
    fi
    printf '.'
    sleep 10
    [ "$i" = 90 ] && { echo; docker compose logs --tail 40; die "Kein /health nach 15 Minuten."; }
done

# --------------------------------------------------------------------- nginx

step "nginx"

need_nginx=0
[ -f /etc/nginx/snippets/whisper.conf ]        || need_nginx=1
[ -f /etc/nginx/conf.d/whisper-limits.conf ]   || need_nginx=1
grep -qs 'snippets/whisper.conf' /etc/nginx/sites-available/fherrmann.com || need_nginx=1

if [ "$need_nginx" = 0 ] && curl -fsS --max-time 10 "$PUBLIC_URL/health" >/dev/null 2>&1; then
    ok "$PUBLIC_URL/health erreichbar — nginx ist fertig verdrahtet"
else
    warn "nginx fehlt noch. Das braucht Root, also bitte selbst ausführen:"
    cat <<NGINX

    sudo cp $APP_DIR/deploy/nginx-whisper-limits.conf \\
            /etc/nginx/conf.d/whisper-limits.conf
    sudo cp $APP_DIR/deploy/nginx-whisper-location.conf \\
            /etc/nginx/snippets/whisper.conf

    # in /etc/nginx/sites-available/fherrmann.com, im 443-Serverblock,
    # direkt unter die vorhandene wahlen-Zeile:
    #     include /etc/nginx/snippets/whisper.conf;

    sudo nginx -t && sudo systemctl reload nginx
NGINX
fi

# ------------------------------------------------------------------- Abschluss

step "Für die Chrome-Extension"
echo
echo "  Adresse : $PUBLIC_URL"
echo "  Token   : $(grep '^AUTH_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)"
echo
echo "  Updates künftig mit: ~/scripts/update-whatsapp-transcribe.sh"
echo
