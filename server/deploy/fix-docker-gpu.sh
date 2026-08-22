#!/usr/bin/env bash
#
# Repariert die GPU-Durchreichung des Docker-Snaps.
#
# Symptom:
#   docker: Error response from daemon: ... error running createContainer
#   hook #0: fork/exec /snap/docker/3377/usr/bin/nvidia-ctk: no such file
#
# Ursache:
#   Der Docker-Snap bringt das NVIDIA-Container-Toolkit selbst mit. Die
#   CDI-Spezifikation unter /var/snap/docker/current/etc/cdi/nvidia.yaml wird
#   einmalig erzeugt und enthaelt dabei den *revisionsgenauen* Snap-Pfad
#   (z. B. /snap/docker/3377/...). Aktualisiert sich der Snap, zeigt die Spec
#   ins Leere und jeder Containerstart mit --runtime=nvidia scheitert.
#
# Was dieses Skript macht:
#   1. Sicherung der bestehenden Spec
#   2. Neu erzeugen
#   3. Alle revisionsgenauen Pfade auf /snap/docker/current/ umschreiben —
#      damit ueberlebt die Spec kuenftige Snap-Updates
#   4. Gegentest mit einem Wegwerf-Container
#
# Braucht Root. Der Docker-Daemon wird NICHT neu gestartet — CDI-Specs liest
# die Runtime beim Containerstart von der Platte. Nur falls der Gegentest
# scheitert, schlaegt das Skript einen Neustart vor (der wuerde alle
# Container auf dem Host kurz mitnehmen).
set -euo pipefail

CTK=/snap/docker/current/usr/bin/nvidia-ctk
CDI=/var/snap/docker/current/etc/cdi/nvidia.yaml
TEST_IMAGE=ubuntu:22.04

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
[ -x "$CTK" ] || { echo "FEHLER: $CTK fehlt. Ist der Docker-Snap installiert?" >&2; exit 1; }
command -v nvidia-smi >/dev/null || { echo "FEHLER: kein NVIDIA-Treiber auf dem Host." >&2; exit 1; }

echo "==> Treiber"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

if [ -f "$CDI" ]; then
    BACKUP="$CDI.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$CDI" "$BACKUP"
    echo "==> Sicherung: $BACKUP"
    echo "    bisher referenzierte Revisionen: $(grep -o '/snap/docker/[0-9]*' "$CDI" | sort -u | tr '\n' ' ')"
fi

echo "==> CDI-Spezifikation neu erzeugen"
TMP=$(mktemp /tmp/nvidia-cdi.XXXXXX.yaml)
trap 'rm -f "$TMP"' EXIT
"$CTK" cdi generate --output="$TMP"

echo "==> revisionsgenaue Pfade auf den stabilen current-Symlink umschreiben"
sed -i 's#/snap/docker/[0-9][0-9]*/#/snap/docker/current/#g' "$TMP"

if grep -q '/snap/docker/[0-9]' "$TMP"; then
    echo "FEHLER: es sind noch revisionsgenaue Pfade uebrig:" >&2
    grep -n '/snap/docker/[0-9]' "$TMP" | head >&2
    exit 1
fi

# Plausibilitaet: die Spec muss auf ein existierendes nvidia-ctk zeigen
hook=$(grep -m1 -o '/snap/docker/current/usr/bin/nvidia-ctk' "$TMP" || true)
[ -n "$hook" ] && [ -x "$hook" ] || {
    echo "FEHLER: die erzeugte Spec verweist nicht auf ein ausfuehrbares nvidia-ctk." >&2
    exit 1
}

mkdir -p "$(dirname "$CDI")"
install -m 644 "$TMP" "$CDI"
echo "==> $CDI geschrieben"

echo "==> Gegentest"
if ! docker image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "    hole $TEST_IMAGE ..."
    docker pull -q "$TEST_IMAGE" >/dev/null
fi

if out=$(docker run --rm --runtime=nvidia \
            -e NVIDIA_VISIBLE_DEVICES=all \
            -e NVIDIA_DRIVER_CAPABILITIES=compute,utility \
            "$TEST_IMAGE" nvidia-smi -L 2>&1); then
    echo
    echo "    $out"
    echo
    echo "==> GPU ist aus Containern nutzbar."
    exit 0
fi

echo >&2
echo "$out" >&2
echo >&2
echo "==> Gegentest fehlgeschlagen. Naechster Schritt waere ein Daemon-Neustart:" >&2
echo "      sudo snap restart docker" >&2
echo "    ACHTUNG: das nimmt kurz alle Container auf diesem Host mit" >&2
echo "    (Jellyfin, Spieleserver, firefly, wahlen ...)." >&2
exit 1
