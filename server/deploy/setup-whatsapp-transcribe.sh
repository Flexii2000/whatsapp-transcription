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
# nur aus, statt sie auszufuehren. Fuer die GPU gilt dasselbe —
# ~/scripts/fix-docker-gpu.sh muss einmalig mit sudo laufen.
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
      ~/scripts/setup-whatsapp-transcribe.sh

  Mit sudo laeuft nur:
      sudo ~/scripts/fix-docker-gpu.sh
ROOT
    exit 1
fi

REPO_URL="git@github.com:Flexii2000/whatsapp-transcription.git"
REPO_DIR="$HOME/services/whatsapp-transcribe"
APP_DIR="$REPO_DIR/server"
SCRIPTS_DIR="$HOME/scripts"
PORT=8099
LLM_PORT=11500
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

port_busy() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1 "; }
mine()      { docker ps --format '{{.Names}}' | grep -qx "$1"; }

# Laesst sich die GPU aus einem Container nutzen? Bewusst mit einem Image,
# das ohnehin lokal liegt oder winzig ist — der Test darf nichts kosten.
gpu_usable() {
    docker info 2>/dev/null | grep -q ' nvidia' || return 1
    command -v nvidia-smi >/dev/null 2>&1 || return 1
    docker run --rm --runtime=nvidia \
        -e NVIDIA_VISIBLE_DEVICES=all \
        -e NVIDIA_DRIVER_CAPABILITIES=compute,utility \
        ubuntu:22.04 nvidia-smi -L >/dev/null 2>&1
}

# --------------------------------------------------------------- Vorpruefung

step "Vorprüfung"

command -v docker >/dev/null || die "docker nicht gefunden."
docker ps >/dev/null 2>&1 || die "Kein Zugriff auf den Docker-Daemon."
ok "docker erreichbar"

docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) fehlt."
ok "docker compose v2 vorhanden"

for p in "$PORT:whatsapp-transcribe" "$LLM_PORT:whatsapp-transcribe-llm"; do
    prt=${p%%:*}; name=${p##*:}
    if port_busy "$prt"; then
        mine "$name" && ok "Port $prt gehört dem eigenen Container" \
                     || die "Port $prt ist von etwas anderem belegt."
    else
        ok "Port $prt ist frei"
    fi
done

free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
[ "${free_gb:-0}" -ge 15 ] \
    && ok "${free_gb} GB frei (Images + Whisper- und LLM-Modell brauchen ~12 GB)" \
    || warn "nur ${free_gb} GB frei — Images und Modelle brauchen ~12 GB"

step "GPU"
if gpu_usable; then
    GPU=1
    ok "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)"
    ok "aus Containern nutzbar — Whisper und LLM laufen auf der Karte"
else
    GPU=0
    if command -v nvidia-smi >/dev/null 2>&1; then
        warn "GPU vorhanden, aber aus Containern nicht nutzbar."
        warn "Einmalig reparieren mit:  sudo ~/scripts/fix-docker-gpu.sh"
        warn "Bis dahin läuft alles auf der CPU (langsamer, funktioniert aber)."
    else
        warn "keine NVIDIA-GPU — CPU-Betrieb"
    fi
fi

if [ "$DRY_RUN" = 1 ]; then
    step "Bestandsaufnahme (--check: es wird nichts verändert)"
    [ -d "$REPO_DIR/.git" ] && ok "Repo vorhanden: $REPO_DIR" \
                           || warn "Repo fehlt — würde geklont: $REPO_DIR"
    [ -f "$APP_DIR/.env" ]  && ok ".env vorhanden — bliebe unangetastet" \
                           || warn ".env fehlt — würde mit neuem AUTH_TOKEN angelegt"
    mine whatsapp-transcribe     && ok "Backend-Container läuft"     || warn "Backend-Container läuft nicht"
    mine whatsapp-transcribe-llm && ok "LLM-Container läuft"         || warn "LLM-Container läuft nicht"
    [ -f /etc/nginx/snippets/whisper.conf ] && ok "nginx-Snippet installiert" \
                                           || warn "nginx-Snippet fehlt (braucht Root)"
    grep -qs 'snippets/whisper.conf' /etc/nginx/sites-available/fherrmann.com \
        && ok "include-Zeile in fherrmann.com vorhanden" \
        || warn "include-Zeile in fherrmann.com fehlt (braucht Root)"
    echo
    echo "  Ohne --check würde das Skript den Rest einrichten."
    exit 0
fi

# ------------------------------------------------------------------- Quellen

step "Quellen"

mkdir -p "$HOME/services" "$SCRIPTS_DIR"

# Ein frueherer sudo-Lauf kann root-eigene Reste hinterlassen haben, an denen
# spaeter jedes git pull und jedes Schreiben scheitert.
if [ -e "$REPO_DIR" ]; then
    foreign=$(find "$REPO_DIR" ! -user "$(id -un)" -print -quit 2>/dev/null || true)
    [ -n "$foreign" ] && die "In $REPO_DIR liegen Dateien, die dir nicht gehoeren
       (z. B. $foreign) — vermutlich von einem frueheren sudo-Lauf.
       Einmalig geradeziehen mit:
         sudo chown -R $(id -un):$(id -gn) $REPO_DIR"
fi

if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" pull --ff-only
    ok "Repo aktualisiert: $REPO_DIR"
else
    [ -e "$REPO_DIR" ] && die "$REPO_DIR existiert, ist aber kein Git-Repo."
    git clone "$REPO_URL" "$REPO_DIR"
    ok "Repo geklont nach $REPO_DIR"
fi

for s in setup update fix-docker-gpu; do
    case "$s" in
        fix-docker-gpu) src="$APP_DIR/deploy/fix-docker-gpu.sh"; dst="$SCRIPTS_DIR/fix-docker-gpu.sh" ;;
        *)              src="$APP_DIR/deploy/$s-whatsapp-transcribe.sh"
                        dst="$SCRIPTS_DIR/$s-whatsapp-transcribe.sh" ;;
    esac
    # Nur bei Unterschied anfassen: dieses Skript kann sich sonst selbst
    # unter den Füßen wegziehen, während bash noch daraus liest.
    if cmp -s "$src" "$dst"; then
        ok "$(basename "$dst") ist aktuell"
    else
        install -m 755 "$src" "$dst"
        ok "$(basename "$dst") aktualisiert"
    fi
done

# ---------------------------------------------------------------------- .env

step "Konfiguration"

cd "$APP_DIR"

if [ -f .env ]; then
    ok ".env existiert bereits — bleibt unangetastet"
else
    umask 077
    cp .env.example .env
    sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=$(openssl rand -hex 32)|" .env
    ok "AUTH_TOKEN erzeugt und eingetragen"
    ok "SUMMARY_BACKEND=local — die Stichpunkte macht das eigene Ollama"
fi
chmod 600 .env

# COMPOSE_FILE in der .env sorgt dafür, dass auch ein blankes
# `docker compose ...` im Ordner die richtige Kombination nimmt.
if [ "$GPU" = 1 ]; then
    want="docker-compose.yml:docker-compose.gpu.yml"
else
    want="docker-compose.yml"
fi
if grep -q '^COMPOSE_FILE=' .env; then
    sed -i "s|^COMPOSE_FILE=.*|COMPOSE_FILE=$want|" .env
else
    printf 'COMPOSE_FILE=%s\n' "$want" >> .env
fi
ok "COMPOSE_FILE=$want"

grep -q '^AUTH_TOKEN=.\+' .env || die "AUTH_TOKEN fehlt in $APP_DIR/.env"

backend=$(grep -m1 '^SUMMARY_BACKEND=' .env | cut -d= -f2- | tr -d '[:space:]')
llm_model=$(grep -m1 '^LLM_MODEL=' .env | cut -d= -f2- | tr -d '[:space:]')
: "${llm_model:=qwen3:4b}"

if [ "$backend" = "claude" ] && ! grep -q '^ANTHROPIC_API_KEY=.\+' .env; then
    warn "SUMMARY_BACKEND=claude, aber kein ANTHROPIC_API_KEY — es gibt nur Transkripte"
fi

# -------------------------------------------------------------------- Bauen

step "Container bauen und starten"
echo "  Beim ersten Mal dauert das einige Minuten (Images + Whisper-Modell ~1,6 GB)."
docker compose build
docker compose up -d
ok "Container laufen"

# ---------------------------------------------------------------- LLM-Modell

if [ "$backend" = "local" ]; then
    step "Sprachmodell $llm_model bereitstellen"

    for i in $(seq 1 30); do
        docker compose exec -T llm ollama list >/dev/null 2>&1 && break
        printf '.'; sleep 2
        [ "$i" = 30 ] && { echo; die "LLM-Container antwortet nicht."; }
    done
    echo

    if docker compose exec -T llm ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$llm_model"; then
        ok "$llm_model liegt bereits vor"
    else
        echo "  Lade $llm_model herunter (einige GB, dauert ein paar Minuten) ..."
        docker compose exec -T llm ollama pull "$llm_model"
        ok "$llm_model geladen"
    fi
fi

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
[ -f /etc/nginx/snippets/whisper.conf ]      || need_nginx=1
[ -f /etc/nginx/conf.d/whisper-limits.conf ] || need_nginx=1
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
echo "  Token   : $(grep '^AUTH_TOKEN=' .env | cut -d= -f2-)"
echo
[ "$GPU" = 0 ] && command -v nvidia-smi >/dev/null 2>&1 && \
    echo "  Tipp: sudo ~/scripts/fix-docker-gpu.sh schaltet die GPU frei, danach" && \
    echo "        nochmal ~/scripts/setup-whatsapp-transcribe.sh laufen lassen." && echo
echo "  Updates künftig mit: ~/scripts/update-whatsapp-transcribe.sh"
echo
