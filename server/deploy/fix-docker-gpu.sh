#!/usr/bin/env bash
#
# Repariert die GPU-Durchreichung des Docker-Snaps.
#
# Symptom:
#   docker: Error response from daemon: ... error running createContainer
#   hook #0: fork/exec /snap/docker/3377/usr/bin/nvidia-ctk: no such file
#
# Ursache:
#   Der Docker-Snap bringt das NVIDIA-Container-Toolkit selbst mit. Seine
#   CDI-Spezifikation (/var/snap/docker/current/etc/cdi/nvidia.yaml) wird
#   einmalig erzeugt und enthaelt dabei den *revisionsgenauen* Snap-Pfad zum
#   Hook-Binary. Aktualisiert sich der Snap, zeigt dieser Pfad ins Leere und
#   jeder Containerstart mit --runtime=nvidia scheitert.
#
# Vorgehen:
#   Die Spec wird NICHT neu erzeugt, sondern nur der Pfad korrigiert und auf
#   den stabilen /snap/docker/current/-Symlink umgeschrieben — damit
#   ueberlebt sie kuenftige Snap-Updates.
#
#   Neu erzeugen waere der Lehrbuchweg, aber `nvidia-ctk cdi generate` stuerzt
#   auf diesem Toolkit-Stand beim Aufraeumen reproduzierbar ab
#   ("free(): invalid pointer" in nvSandboxUtilsShutdown). Am Inhalt der Spec
#   ist ohnehin nichts veraltet: alle referenzierten Treiberdateien existieren
#   und die Treiberversion stimmt. Nur wenn beides nicht mehr zutrifft, hilft
#   Umschreiben nicht — dann meldet das Skript das und bricht ab.
#
# --check prueft alles durch, ohne etwas zu veraendern (kein Root noetig).
set -euo pipefail

CDI=/var/snap/docker/current/etc/cdi/nvidia.yaml
SNAP_BIN=/snap/docker/current/usr/bin
TEST_IMAGE=ubuntu:22.04

CHECK=0
case "${1:-}" in
    --check|-n) CHECK=1 ;;
    "")         ;;
    *)          echo "Aufruf: $0 [--check]" >&2; exit 2 ;;
esac

if [ -t 1 ]; then
    B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
    R=$(printf '\033[31m'); N=$(printf '\033[0m')
else B=""; G=""; Y=""; R=""; N=""; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "  ${G}OK${N}   $*"; }
warn() { echo "  ${Y}!${N}    $*"; }
die()  { echo "  ${R}FEHLER${N} $*" >&2; exit 1; }

# Dieses Skript ist das einzige der drei, das Root braucht — es schreibt nach
# /var/snap/docker/. setup- und update-* laufen umgekehrt als flexii.
[ "$CHECK" = 1 ] || [ "$(id -u)" -eq 0 ] || die "Bitte MIT sudo ausfuehren (oder --check ohne)."

# ------------------------------------------------------------------ Befund

step "Befund"

command -v nvidia-smi >/dev/null || die "kein NVIDIA-Treiber auf dem Host."
host_drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d '[:space:]')
ok "Treiber $host_drv — $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

[ -f "$CDI" ] || die "$CDI fehlt. Diese Reparatur setzt eine vorhandene Spec voraus."
[ -x "$SNAP_BIN/nvidia-ctk" ] || die "$SNAP_BIN/nvidia-ctk fehlt. Docker-Snap installiert?"

revs=$(grep -o '/snap/docker/[0-9]*' "$CDI" | sort -u | sed 's|.*/||' | tr '\n' ' ')
cur=$(readlink /snap/docker/current)
if [ -z "$revs" ]; then
    ok "Spec enthaelt keine revisionsgenauen Pfade"
else
    warn "Spec zeigt auf Revision(en): ${revs}— aktuell ist $cur"
fi

# Treiberversion in der Spec: steckt in den Dateinamen der Bibliotheken.
spec_drv=$(grep -oE 'libnvidia-ml\.so\.[0-9]+\.[0-9.]+' "$CDI" | head -1 | sed 's/.*\.so\.//')
if [ "$spec_drv" = "$host_drv" ]; then
    ok "Treiberversion in der Spec passt ($spec_drv)"
else
    die "Spec nennt Treiber $spec_drv, installiert ist $host_drv.
       Ein Pfad-Umschreiben reicht dann nicht — die Spec muss neu erzeugt werden:
         sudo $SNAP_BIN/nvidia-ctk cdi generate --output=$CDI
       Stuerzt das mit 'free(): invalid pointer' ab, ist das ein Bug im
       mitgelieferten Toolkit; dann hilft nur ein Snap-Update abzuwarten."
fi

# Alle referenzierten Treiberdateien pruefen. In der Spec stehen sie mit dem
# Praefix /var/lib/snapd/hostfs (die Sicht aus der Snap-Namespace) — vom Host
# aus liegen sie unter dem Pfad ohne dieses Praefix.
missing=0
while read -r p; do
    [ -e "${p#/var/lib/snapd/hostfs}" ] || { echo "       fehlt: ${p#/var/lib/snapd/hostfs}"; missing=$((missing+1)); }
done < <(grep -oE '(hostPath|path): /var/lib/snapd/hostfs/[^ ]*' "$CDI" | awk '{print $2}' | sort -u)
[ "$missing" -eq 0 ] && ok "alle referenzierten Treiberdateien vorhanden" \
                     || die "$missing referenzierte Treiberdatei(en) fehlen — Spec neu erzeugen noetig."

# --------------------------------------------------------------- Reparatur

step "Reparatur vorbereiten"

TMP=$(mktemp /tmp/nvidia-cdi.XXXXXX.yaml)
trap 'rm -f "$TMP"' EXIT
sed 's#/snap/docker/[0-9][0-9]*/#/snap/docker/current/#g' "$CDI" > "$TMP"

grep -q '/snap/docker/[0-9]' "$TMP" && die "es sind noch revisionsgenaue Pfade uebrig."
ok "alle Snap-Pfade zeigen jetzt auf /snap/docker/current/"

# Jedes referenzierte Snap-Binary muss existieren und ausfuehrbar sein.
bad=0
while read -r p; do
    [ -x "$p" ] || { echo "       nicht ausfuehrbar: $p"; bad=$((bad+1)); }
done < <(grep -oE '/snap/docker/current/[^ ]*' "$TMP" | sort -u)
[ "$bad" -eq 0 ] && ok "alle referenzierten Snap-Binaries sind ausfuehrbar" \
                 || die "$bad referenzierte(s) Binary nicht nutzbar."

if ! diff -q "$CDI" "$TMP" >/dev/null; then
    ok "$(diff "$CDI" "$TMP" | grep -c '^<') Zeile(n) werden geaendert"
else
    ok "Spec ist bereits korrekt — nichts zu tun"
fi

if [ "$CHECK" = 1 ]; then
    echo
    echo "  --check: es wurde nichts veraendert. Ohne --check (und mit sudo)"
    echo "  wuerde das Skript die Spec schreiben und gegentesten."
    exit 0
fi

# ------------------------------------------------------------------ Anwenden

step "Anwenden"

BACKUP="$CDI.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$CDI" "$BACKUP"
ok "Sicherung: $BACKUP"

install -m 644 "$TMP" "$CDI"
ok "$CDI geschrieben"

step "Gegentest"

if ! docker image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "  hole $TEST_IMAGE ..."
    docker pull -q "$TEST_IMAGE" >/dev/null
fi

if out=$(docker run --rm --runtime=nvidia \
            -e NVIDIA_VISIBLE_DEVICES=all \
            -e NVIDIA_DRIVER_CAPABILITIES=compute,utility \
            "$TEST_IMAGE" nvidia-smi -L 2>&1); then
    echo
    echo "  $out"
    echo
    ok "GPU ist aus Containern nutzbar."
    echo
    echo "  Weiter mit: ~/scripts/setup-whatsapp-transcribe.sh"
    exit 0
fi

echo >&2
echo "$out" >&2
echo >&2
warn "Gegentest fehlgeschlagen. Zuruecknehmen mit:"
echo "      sudo cp -a $BACKUP $CDI" >&2
echo >&2
warn "Naechster Versuch waere ein Daemon-Neustart:"
echo "      sudo snap restart docker" >&2
echo "    ACHTUNG: das nimmt kurz alle Container auf diesem Host mit" >&2
echo "    (Jellyfin, Spieleserver, firefly, wahlen ...)." >&2
exit 1
