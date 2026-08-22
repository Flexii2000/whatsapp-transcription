"""
Zusammenfassung des Transkripts — austauschbares Backend.

Drei Varianten, per SUMMARY_BACKEND umschaltbar:

  local   Eigenes Ollama daneben im Compose-Stack. Kostet nichts, und das
          Transkript verlaesst den Server nicht. Standard.
  claude  Anthropic-API. Beste Qualitaet, braucht einen API-Key, und der
          Transkript-Text geht an Anthropic.
  none    Nur Transkript, keine Stichpunkte.

Gemeinsame Regel fuer alle: Ein Fehler beim Zusammenfassen gibt eine leere
Liste zurueck, niemals eine Exception. Die Stichpunkte sind das Extra, das
Transkript ist das Produkt.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Protocol

log = logging.getLogger("wat.summary")

MAX_BULLETS = int(os.getenv("SUMMARY_MAX_BULLETS", "5"))

# Ollama ab 0.5 und die Anthropic-API akzeptieren beide ein JSON-Schema.
SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "maxItems": MAX_BULLETS,
        }
    },
    "required": ["summary"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """\
Du fasst transkribierte WhatsApp-Sprachnachrichten fuer den Empfaenger zusammen.

- Schreibe 1 bis {max_b} knappe Stichpunkte in der Sprache des Transkripts.
- Der erste Stichpunkt ist die Kernaussage der Nachricht.
- Konkretes zuerst: Termine, Uhrzeiten, Orte, Zahlen, Namen, Zusagen, Absagen.
- Was der Empfaenger tun oder beantworten soll, stellst du mit "-> " voran.
- Duze den Empfaenger, so wie die Nachricht selbst es tut. Niemals siezen.
- Keine Einleitung, keine Meta-Kommentare ("Die Person sagt ..."), keine Floskeln.
- Offensichtliche Transkriptionsfehler interpretierst du stillschweigend sinnvoll,
  ohne sie zu erwaehnen. Was du nicht verstehst, laesst du weg statt zu raten.
- Erfinde nichts, was nicht im Transkript steht.
- Jeder Stichpunkt steht ohne Aufzaehlungszeichen da, die Darstellung uebernimmt das UI.
"""


def _clean(bullets: Any) -> list[str]:
    if not isinstance(bullets, list):
        return []
    out = [b.strip() for b in bullets if isinstance(b, str) and b.strip()]
    return out[:MAX_BULLETS]


class Summarizer(Protocol):
    name: str
    model: str | None

    def summarize(self, transcript: str) -> list[str]: ...
    def health(self) -> dict[str, Any]: ...


# --------------------------------------------------------------------------
# Kein Backend
# --------------------------------------------------------------------------

class NullSummarizer:
    name = "none"
    model = None

    def summarize(self, transcript: str) -> list[str]:
        return []

    def health(self) -> dict[str, Any]:
        return {"backend": "none", "ready": True}


# --------------------------------------------------------------------------
# Lokal (eigenes Ollama)
# --------------------------------------------------------------------------

class LocalSummarizer:
    """Spricht mit dem Ollama, das im selben Compose-Stack liegt.

    Bewusst ueber urllib statt einer weiteren Abhaengigkeit: es ist ein
    einzelner JSON-POST gegen einen Dienst im selben Docker-Netz.
    """

    name = "local"

    def __init__(self, base_url: str, model: str, timeout: int = 120) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def _post(self, path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)

    def summarize(self, transcript: str) -> list[str]:
        try:
            resp = self._post(
                "/api/chat",
                {
                    "model": self.model,
                    "stream": False,
                    # Schema-erzwungenes JSON — erspart das Herumraten an
                    # Freitext-Antworten kleiner Modelle.
                    "format": SCHEMA,
                    "options": {
                        "temperature": 0.2,
                        "num_ctx": 8192,
                        "num_predict": 400,
                    },
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT.format(max_b=MAX_BULLETS)},
                        {"role": "user", "content": f"<transkript>\n{transcript}\n</transkript>"},
                    ],
                },
                self.timeout,
            )
        except urllib.error.HTTPError as exc:
            body = exc.read(500).decode("utf-8", "replace")
            if exc.code == 404:
                log.warning("Modell %s ist nicht geladen: %s", self.model, body)
            else:
                log.warning("Ollama antwortete %s: %s", exc.code, body)
            return []
        except Exception as exc:  # noqa: BLE001 — Netz, Timeout, kaputtes JSON
            log.warning("Ollama nicht erreichbar: %r", exc)
            return []

        content = (resp.get("message") or {}).get("content", "")
        try:
            return _clean(json.loads(content).get("summary"))
        except (json.JSONDecodeError, AttributeError, TypeError) as exc:
            log.warning("Antwort war kein verwertbares JSON (%s): %.200s", exc, content)
            return []

    def health(self) -> dict[str, Any]:
        info: dict[str, Any] = {"backend": "local", "model": self.model, "ready": False}
        try:
            req = urllib.request.Request(self.base_url + "/api/tags")
            with urllib.request.urlopen(req, timeout=5) as resp:
                tags = json.load(resp)
            names = [m.get("name", "") for m in tags.get("models", [])]
            # Ollama fuehrt "qwen3:4b" auch als "qwen3:4b" — aber ein ohne Tag
            # angefragtes Modell heisst intern ":latest".
            wanted = self.model if ":" in self.model else f"{self.model}:latest"
            info["ready"] = wanted in names or self.model in names
            info["available"] = names
        except Exception as exc:  # noqa: BLE001
            info["error"] = str(exc)
        return info


# --------------------------------------------------------------------------
# Claude
# --------------------------------------------------------------------------

class ClaudeSummarizer:
    name = "claude"

    def __init__(self, api_key: str, model: str, effort: str) -> None:
        import anthropic

        self._anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model
        self.effort = effort

    def summarize(self, transcript: str) -> list[str]:
        try:
            resp = self.client.beta.messages.create(
                model=self.model,
                max_tokens=2000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=SYSTEM_PROMPT.format(max_b=MAX_BULLETS),
                output_config={
                    "effort": self.effort,
                    "format": {"type": "json_schema", "schema": SCHEMA},
                },
                messages=[
                    {"role": "user", "content": f"<transkript>\n{transcript}\n</transkript>"}
                ],
            )
        except self._anthropic.APIError as exc:
            log.warning("Claude-Aufruf fehlgeschlagen: %s", exc)
            return []
        except Exception as exc:  # noqa: BLE001
            # Bewusst breit: ein aelteres SDK ohne `fallbacks`-Parameter wirft
            # TypeError, kein APIError.
            log.warning("Claude-Aufruf unerwartet gescheitert: %r", exc)
            return []

        if resp.stop_reason == "refusal":
            detail = getattr(resp, "stop_details", None)
            log.warning("Claude hat abgelehnt (%s)", getattr(detail, "category", None))
            return []

        try:
            text = next(b.text for b in resp.content if b.type == "text")
            return _clean(json.loads(text).get("summary"))
        except (StopIteration, json.JSONDecodeError, AttributeError, TypeError) as exc:
            log.warning("Summary-Antwort nicht verwertbar: %s", exc)
            return []

    def health(self) -> dict[str, Any]:
        return {"backend": "claude", "model": self.model, "ready": True, "effort": self.effort}


# --------------------------------------------------------------------------
# Auswahl
# --------------------------------------------------------------------------

def build_summarizer() -> Summarizer:
    backend = os.getenv("SUMMARY_BACKEND", "local").strip().lower()

    if backend in ("none", "off", "false", ""):
        log.info("Zusammenfassung deaktiviert")
        return NullSummarizer()

    if backend == "claude":
        key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        if not key:
            log.warning("SUMMARY_BACKEND=claude, aber ANTHROPIC_API_KEY fehlt — nur Transkript.")
            return NullSummarizer()
        s = ClaudeSummarizer(
            api_key=key,
            model=os.getenv("SUMMARY_MODEL", "claude-opus-5"),
            effort=os.getenv("SUMMARY_EFFORT", "low"),
        )
        log.info("Zusammenfassung ueber Claude (%s, effort=%s)", s.model, s.effort)
        return s

    if backend == "local":
        s = LocalSummarizer(
            base_url=os.getenv("LLM_URL", "http://llm:11434"),
            model=os.getenv("LLM_MODEL", "qwen3:4b"),
            timeout=int(os.getenv("LLM_TIMEOUT", "120")),
        )
        log.info("Zusammenfassung lokal ueber %s (%s)", s.base_url, s.model)
        return s

    log.warning("Unbekanntes SUMMARY_BACKEND=%r — Zusammenfassung aus.", backend)
    return NullSummarizer()
