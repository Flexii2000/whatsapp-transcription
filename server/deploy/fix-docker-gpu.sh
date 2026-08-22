#!/usr/bin/env bash
#
# Macht die GPU aus Docker-Containern nutzbar. Repariert zwei unabhaengige
# Defekte derselben CDI-Spezifikation des Docker-Snaps.
#
# Defekt 1 — veralteter Hook-Pfad
#   Symptom:
#     docker: ... error running createContainer hook #0:
#     fork/exec /snap/docker/3377/usr/bin/nvidia-ctk: no such file
#   Ursache:
#     Der Snap bringt das NVIDIA-Container-Toolkit selbst mit. Die einmalig
#     erzeugte Spec enthaelt den *revisionsgenauen* Snap-Pfad. Nach einem
#     Snap-Update zeigt der ins Leere.
#
# Defekt 2 — fehlende UVM-Geraeteknoten
#   Symptom:
#     nvidia-smi im Container funktioniert, aber jede echte CUDA-Rechnung
#     bricht ab mit "CUDA failed with error unknown error".
#   Ursache:
#     Die Spec listet nur /dev/nvidia0, /dev/nvidiactl und /dev/nvidia-modeset.
#     /dev/nvidia-uvm und /dev/nvidia-uvm-tools fehlen, weil das Kernelmodul
#     nvidia_uvm erst beim ersten CUDA-Zugriff laedt und bei der Erzeugung der
#     Spec noch nicht geladen war. nvidia-smi braucht UVM nicht — deshalb
#     faellt das erst auf, wenn wirklich gerechnet wird.
#
# Warum nicht einfach neu erzeugen:
#   `nvidia-ctk cdi generate` stuerzt auf diesem Toolkit-Stand reproduzierbar
#   beim Aufraeumen ab ("free(): invalid pointer" in nvSandboxUtilsShutdown).
#   Am uebrigen Inhalt der Spec ist ohnehin nichts veraltet — das prueft das
#   Skript nach und bricht ab, falls doch.
#
# --check prueft alles durch, ohne etwas zu veraendern (kein Root noetig).
set -euo pipefail

CDI=/var/snap/docker/current/etc/cdi/nvidia.yaml
SNAP_BIN=/snap/docker/current/usr/bin
TEST_IMAGE=ubuntu:22.04
# Diese Knoten muessen im Container liegen, damit CUDA laeuft.
# Fuers Rechnen zwingend. /dev/nvidia-uvm-tools braucht nur Profiling und
# wird deshalb ergaenzt, aber nicht erzwungen.
NEEDED_NODES="/dev/nvidiactl /dev/nvidia-uvm"
OPTIONAL_NODES="/dev/nvidia-uvm-tools"

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

[ "$CHECK" = 1 ] || [ "$(id -u)" -eq 0 ] || die "Bitte MIT sudo ausfuehren (oder --check ohne)."

# ------------------------------------------------------------------ Befund

step "Befund"

command -v nvidia-smi >/dev/null || die "kein NVIDIA-Treiber auf dem Host."
host_drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d '[:space:]')
ok "Treiber $host_drv — $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

[ -f "$CDI" ] || die "$CDI fehlt. Diese Reparatur setzt eine vorhandene Spec voraus."
[ -x "$SNAP_BIN/nvidia-ctk" ] || die "$SNAP_BIN/nvidia-ctk fehlt. Docker-Snap installiert?"

# `|| true`, weil grep ohne Treffer 1 liefert und pipefail das Skript sonst
# genau dann beendet, wenn alles in Ordnung ist.
revs=$(grep -o '/snap/docker/[0-9][0-9]*' "$CDI" | sort -u | sed 's|.*/||' | tr '\n' ' ' || true)
[ -z "$revs" ] && ok "keine revisionsgenauen Pfade in der Spec" \
               || warn "Spec zeigt auf Revision(en): ${revs}— aktuell ist $(readlink /snap/docker/current)"

spec_drv=$(grep -oE 'libnvidia-ml\.so\.[0-9]+\.[0-9.]+' "$CDI" | head -1 | sed 's/.*\.so\.//' || true)
[ "$spec_drv" = "$host_drv" ] || die "Spec nennt Treiber $spec_drv, installiert ist $host_drv.
       Umschreiben reicht dann nicht, die Spec muss neu erzeugt werden:
         sudo $SNAP_BIN/nvidia-ctk cdi generate --output=$CDI"
ok "Treiberversion in der Spec passt ($spec_drv)"

missing=0
while read -r p; do
    [ -e "${p#/var/lib/snapd/hostfs}" ] || { echo "       fehlt: ${p#/var/lib/snapd/hostfs}"; missing=$((missing+1)); }
done < <(grep -oE '(hostPath|path): /var/lib/snapd/hostfs/[^ ]*' "$CDI" | awk '{print $2}' | sort -u)
[ "$missing" -eq 0 ] && ok "alle referenzierten Treiberdateien vorhanden" \
                     || die "$missing referenzierte Treiberdatei(en) fehlen — Spec neu erzeugen noetig."

for node in $NEEDED_NODES $OPTIONAL_NODES; do
    [ -e "$node" ] || die "$node existiert auf dem Host nicht.
       Fehlt /dev/nvidia-uvm, ist das Kernelmodul nicht geladen:
         sudo modprobe nvidia-uvm"
done
ok "alle noetigen Geraeteknoten existieren auf dem Host"

fehlend=$(for node in $NEEDED_NODES; do
              grep -q "path: $node\$" "$CDI" || printf '%s ' "$node"
          done)
[ -z "$fehlend" ] && ok "Spec listet alle noetigen Geraeteknoten" \
                  || warn "Spec fehlen Geraeteknoten: $fehlend"

# --------------------------------------------------------------- Reparatur

step "Reparatur vorbereiten"

TMP=$(mktemp /tmp/nvidia-cdi.XXXXXX.yaml)
trap 'rm -f "$TMP"' EXIT

sed 's#/snap/docker/[0-9][0-9]*/#/snap/docker/current/#g' "$CDI" > "$TMP"
grep -q '/snap/docker/[0-9]' "$TMP" && die "es sind noch revisionsgenaue Pfade uebrig."
ok "alle Snap-Pfade zeigen auf /snap/docker/current/"

# Fehlende Geraeteknoten ergaenzen.
#
# Bewusst als gezielte Zeileneinfuegung statt ueber einen YAML-Round-Trip:
# pyyaml wuerde die Datei neu formatieren und dabei z. B. aus  name: "0"
# ein  name: 0  machen — aus dem String wuerde eine Zahl und der Geraetename
# waere kaputt.
added=$(NEEDED="$NEEDED_NODES $OPTIONAL_NODES" python3 - "$TMP" <<'PYEOF'
import os, sys

path = sys.argv[1]
wanted = os.environ["NEEDED"].split()
lines = open(path).read().splitlines()

present = {l.strip()[8:] for l in lines if l.strip().startswith("- path: /dev/")}
missing = [d for d in wanted if d not in present]
if not missing:
    sys.exit(0)

try:
    i = lines.index("containerEdits:")                       # top-level Block
    j = next(k for k in range(i + 1, len(lines)) if lines[k] == "  deviceNodes:")
except (ValueError, StopIteration):
    sys.exit("globalen deviceNodes-Block nicht gefunden")

end = j + 1
while end < len(lines) and lines[end].startswith("  - path: "):
    end += 1

lines[end:end] = ["  - path: " + d for d in missing]
open(path, "w").write("\n".join(lines) + "\n")
print(" ".join(missing))
PYEOF
)
[ -n "$added" ] && ok "ergaenzt: $added" || ok "keine Geraeteknoten zu ergaenzen"

# Nachpruefen statt hoffen.
python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$TMP" 2>/dev/null \
    && ok "Spec ist weiterhin gueltiges YAML" \
    || warn "YAML nicht pruefbar (python3-yaml fehlt) — ueberspringe diese Kontrolle"

for node in $NEEDED_NODES; do
    grep -q "path: $node\$" "$TMP" || die "$node steht immer noch nicht in der Spec."
done
ok "Spec listet jetzt alle noetigen Geraeteknoten"

bad=0
while read -r p; do
    [ -x "$p" ] || { echo "       nicht ausfuehrbar: $p"; bad=$((bad+1)); }
done < <(grep -oE '/snap/docker/current/[^ ]*' "$TMP" | sort -u)
[ "$bad" -eq 0 ] && ok "alle referenzierten Snap-Binaries sind ausfuehrbar" \
                 || die "$bad referenzierte(s) Binary nicht nutzbar."

if diff -q "$CDI" "$TMP" >/dev/null; then
    ok "Spec ist bereits korrekt — nichts zu tun"
else
    ok "$(diff "$CDI" "$TMP" | grep -c '^[<>]') Zeile(n) werden geaendert"
fi

if [ "$CHECK" = 1 ]; then
    echo
    echo "  --check: es wurde nichts veraendert."
    exit 0
fi

# ------------------------------------------------------------------ Anwenden

step "Anwenden"

BACKUP="$CDI.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$CDI" "$BACKUP"
ok "Sicherung: $BACKUP"
install -m 644 "$TMP" "$CDI"
ok "$CDI geschrieben"

# ------------------------------------------------------------------ Test

step "Gegentest"

# Zwei Fallen auf einmal umgehen:
#   1. `nvidia-smi -L` allein laeuft auch ohne UVM durch — es sagt also
#      nichts darueber aus, ob CUDA funktioniert.
#   2. nvidia-smi legt /dev/nvidia-uvm im Container selbst an. Wird es vor
#      dem `ls` aufgerufen, bestaetigt sich die Probe selbst.
# Deshalb: erst auflisten, dann nvidia-smi.
if ! docker image inspect "$TEST_IMAGE" >/dev/null 2>&1; then
    echo "  hole $TEST_IMAGE ..."
    docker pull -q "$TEST_IMAGE" >/dev/null
fi

if ! out=$(docker run --rm --runtime=nvidia \
              -e NVIDIA_VISIBLE_DEVICES=all \
              -e NVIDIA_DRIVER_CAPABILITIES=compute,utility \
              "$TEST_IMAGE" sh -c 'ls /dev/nvidia*; nvidia-smi -L' 2>&1); then
    echo >&2; echo "$out" >&2; echo >&2
    warn "Gegentest fehlgeschlagen. Zuruecknehmen mit:"
    echo "      sudo cp -a $BACKUP $CDI" >&2
    exit 1
fi

echo "$out" | grep '^GPU' | sed 's/^/  /'

fehlt=""
for node in $NEEDED_NODES; do
    echo "$out" | grep -qx "$node" || fehlt="$fehlt $node"
done

if [ -n "$fehlt" ]; then
    echo >&2
    die "Im Container fehlen weiterhin:$fehlt
       nvidia-smi laeuft trotzdem, CUDA wird aber scheitern.
       Zuruecknehmen mit:  sudo cp -a $BACKUP $CDI"
fi

ok "alle noetigen Geraeteknoten sind im Container sichtbar"
echo
ok "GPU ist fuer CUDA nutzbar."
echo
echo "  Weiter mit: ~/scripts/setup-whatsapp-transcribe.sh"
