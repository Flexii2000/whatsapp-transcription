"""
WhatsApp Voice Transcribe — Backend.

Nimmt eine Sprachnachricht (base64) entgegen, transkribiert sie lokal mit
faster-whisper und laesst Claude daraus eine Executive Summary in
Stichpunkten bauen. Der Anthropic-API-Key liegt ausschliesslich hier,
nie in der Browser-Extension.

Datenhaltung, bewusst knapp gehalten:
  - Audio wird nur im Arbeitsspeicher verarbeitet und nie gespeichert.
  - Persistiert werden ausschliesslich sha256(Audio), Transkript und
    Stichpunkte — optional mit Verfallsdatum (CACHE_TTL_DAYS).
  - Es wird nichts protokolliert, woraus sich Absender oder Inhalt
    rekonstruieren lassen.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import io
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

log = logging.getLogger("wat")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)

# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

AUTH_TOKEN = os.getenv("AUTH_TOKEN", "").strip()
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "").strip() or None
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "1"))
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(32 * 1024 * 1024)))

SUMMARY_ENABLED = os.getenv("SUMMARY_ENABLED", "true").lower() not in ("0", "false", "no")
SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", "claude-opus-5")
SUMMARY_EFFORT = os.getenv("SUMMARY_EFFORT", "low")
# Unter dieser Wortzahl lohnt keine Zusammenfassung ("Ja passt, bis gleich").
# Auf 0 setzen, wenn wirklich *jede* Nachricht Stichpunkte bekommen soll.
SUMMARY_MIN_WORDS = int(os.getenv("SUMMARY_MIN_WORDS", "20"))
SUMMARY_MAX_BULLETS = int(os.getenv("SUMMARY_MAX_BULLETS", "5"))

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
CACHE_DB = DATA_DIR / "cache.sqlite3"
# 0 = unbegrenzt aufheben. Sonst werden aeltere Eintraege beim Start und
# nach jedem Schreibvorgang geloescht.
CACHE_TTL_DAYS = int(os.getenv("CACHE_TTL_DAYS", "0"))

# Leer = CORS-Middleware gar nicht erst einhaengen. Die Extension ruft aus
# ihrem Service-Worker heraus auf und braucht kein CORS; ein offenes "*"
# waere nur unnoetige Angriffsflaeche.
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

SYSTEM_PROMPT = """\
Du fasst transkribierte WhatsApp-Sprachnachrichten fuer den Empfaenger zusammen.

- Schreibe {min_b} bis {max_b} knappe Stichpunkte in der Sprache des Transkripts.
- Der erste Stichpunkt ist die Kernaussage der Nachricht.
- Konkretes zuerst: Termine, Uhrzeiten, Orte, Zahlen, Namen, Zusagen, Absagen.
- Was der Empfaenger tun oder beantworten soll, stellst du mit "-> " voran.
- Keine Einleitung, keine Meta-Kommentare ("Die Person sagt ..."), keine Floskeln.
- Offensichtliche Transkriptionsfehler interpretierst du stillschweigend sinnvoll,
  ohne sie zu erwaehnen. Was du nicht verstehst, laesst du weg statt zu raten.
- Jeder Stichpunkt steht ohne Aufzaehlungszeichen da, die Darstellung uebernimmt das UI.
"""

SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "maxItems": SUMMARY_MAX_BULLETS,
        }
    },
    "required": ["summary"],
    "additionalProperties": False,
}

# --------------------------------------------------------------------------
# Cache (SQLite, Key = sha256 der Audiobytes)
# --------------------------------------------------------------------------

_db_lock = threading.Lock()
_db: sqlite3.Connection | None = None


def _db_init() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CACHE_DB, check_same_thread=False)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS transcripts (
               sha256      TEXT PRIMARY KEY,
               transcript  TEXT NOT NULL,
               summary     TEXT NOT NULL,
               language    TEXT,
               duration    REAL,
               created_at  REAL NOT NULL
           )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_created ON transcripts(created_at)")
    conn.commit()
    return conn


def cache_purge() -> int:
    """Loescht abgelaufene Eintraege. Ohne TTL passiert nichts."""
    if CACHE_TTL_DAYS <= 0 or _db is None:
        return 0
    cutoff = time.time() - CACHE_TTL_DAYS * 86400
    with _db_lock:
        cur = _db.execute("DELETE FROM transcripts WHERE created_at < ?", (cutoff,))
        _db.commit()
    return cur.rowcount or 0


def cache_get(sha: str) -> dict[str, Any] | None:
    assert _db is not None
    with _db_lock:
        row = _db.execute(
            "SELECT transcript, summary, language, duration FROM transcripts WHERE sha256 = ?",
            (sha,),
        ).fetchone()
    if not row:
        return None
    return {
        "transcript": row[0],
        "summary": json.loads(row[1]),
        "language": row[2],
        "duration_sec": row[3],
    }


def cache_put(sha: str, payload: dict[str, Any]) -> None:
    assert _db is not None
    with _db_lock:
        _db.execute(
            "INSERT OR REPLACE INTO transcripts VALUES (?,?,?,?,?,?)",
            (
                sha,
                payload["transcript"],
                json.dumps(payload["summary"], ensure_ascii=False),
                payload.get("language"),
                payload.get("duration_sec"),
                time.time(),
            ),
        )
        _db.commit()
    cache_purge()


# --------------------------------------------------------------------------
# Whisper
# --------------------------------------------------------------------------

_model: Any = None
_slots = asyncio.Semaphore(MAX_CONCURRENCY)


def _load_model() -> Any:
    from faster_whisper import WhisperModel

    log.info(
        "Lade Whisper-Modell %s (device=%s, compute=%s) ...",
        WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE,
    )
    t0 = time.time()
    m = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
    log.info("Modell geladen in %.1fs", time.time() - t0)
    return m


def _transcribe_sync(audio: bytes, language: str | None) -> tuple[str, str | None, float]:
    """faster-whisper nimmt ein file-like object entgegen. Die Sprachnachricht
    bleibt damit im Arbeitsspeicher und landet nie auf der Platte."""
    assert _model is not None
    segments, info = _model.transcribe(
        io.BytesIO(audio),
        language=language,
        beam_size=WHISPER_BEAM_SIZE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        # Verhindert die typischen Whisper-Endlosschleifen bei Stille/Rauschen.
        condition_on_previous_text=False,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text, getattr(info, "language", None), float(getattr(info, "duration", 0.0))


# --------------------------------------------------------------------------
# Claude — Executive Summary
# --------------------------------------------------------------------------

_anthropic: anthropic.Anthropic | None = None


def _summary_available() -> bool:
    return SUMMARY_ENABLED and _anthropic is not None


def _summarize_sync(transcript: str) -> list[str]:
    """Gibt Stichpunkte zurueck. Bei jedem Problem: leere Liste, nie eine
    Exception nach oben — ein fehlendes Summary darf das Transkript nicht
    kaputt machen."""
    assert _anthropic is not None
    try:
        resp = _anthropic.beta.messages.create(
            model=SUMMARY_MODEL,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT.format(min_b=1, max_b=SUMMARY_MAX_BULLETS),
            output_config={
                "effort": SUMMARY_EFFORT,
                "format": {"type": "json_schema", "schema": SUMMARY_SCHEMA},
            },
            messages=[{"role": "user", "content": f"<transkript>\n{transcript}\n</transkript>"}],
        )
    except anthropic.APIError as exc:
        log.warning("Claude-Aufruf fehlgeschlagen: %s", exc)
        return []
    except Exception as exc:  # noqa: BLE001
        # Bewusst breit: ein aelteres SDK ohne `fallbacks`-Parameter wirft
        # TypeError, kein APIError. Ein fertiges Transkript darf daran nicht
        # sterben — die Stichpunkte sind das Extra, nicht das Produkt.
        log.warning("Claude-Aufruf unerwartet gescheitert: %r", exc)
        return []

    if resp.stop_reason == "refusal":
        detail = getattr(resp, "stop_details", None)
        log.warning("Claude hat abgelehnt (%s)", getattr(detail, "category", None))
        return []

    try:
        text = next(b.text for b in resp.content if b.type == "text")
        bullets = json.loads(text)["summary"]
    except (StopIteration, json.JSONDecodeError, KeyError, TypeError) as exc:
        log.warning("Summary-Antwort nicht verwertbar: %s", exc)
        return []

    return [b.strip() for b in bullets if isinstance(b, str) and b.strip()]


# --------------------------------------------------------------------------
# Zugangsschutz
# --------------------------------------------------------------------------

PROTECTED_PREFIXES = ("/transcribe",)
# base64 blaeht um 4/3 auf, dazu etwas JSON-Rahmen.
MAX_BODY_BYTES = MAX_AUDIO_BYTES * 4 // 3 + 4096


class BearerAuthMiddleware:
    """Prueft Token und Groesse, *bevor* der Request-Body gelesen wird.

    Als Dependency im Endpunkt waere der Body zum Pruefzeitpunkt laengst
    eingelesen — ein unauthentifizierter Aufrufer koennte den Server also
    zwingen, zig Megabyte entgegenzunehmen, nur um dann 401 zu bekommen.
    """

    def __init__(self, app: Any) -> None:
        self.app = app
        self.expected = f"Bearer {AUTH_TOKEN}"

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PROTECTED_PREFIXES):
            return await self.app(scope, receive, send)

        headers = {k.lower(): v for k, v in scope.get("headers", [])}

        given = headers.get(b"authorization", b"").decode("latin-1").strip()
        if not hmac.compare_digest(given, self.expected):
            log.warning("Abgelehnt: ungueltiger Token von %s", _client_of(scope))
            return await JSONResponse({"detail": "Ungueltiger Token."}, 401)(scope, receive, send)

        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            return await JSONResponse({"detail": "Anfrage zu gross."}, 413)(scope, receive, send)

        await self.app(scope, receive, send)


def _client_of(scope: Any) -> str:
    client = scope.get("client")
    return client[0] if client else "?"


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _model, _anthropic
    _db = _db_init()
    if (purged := cache_purge()):
        log.info("Cache: %d abgelaufene Eintraege entfernt", purged)

    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if SUMMARY_ENABLED and key:
        _anthropic = anthropic.Anthropic(api_key=key)
        log.info("Claude-Summary aktiv (%s, effort=%s)", SUMMARY_MODEL, SUMMARY_EFFORT)
    elif SUMMARY_ENABLED:
        log.warning("SUMMARY_ENABLED, aber ANTHROPIC_API_KEY fehlt — nur Transkript.")

    _model = await asyncio.to_thread(_load_model)
    yield
    if _db is not None:
        _db.close()


if not AUTH_TOKEN:
    # Lieber gar nicht starten als offen im Netz stehen.
    raise RuntimeError("AUTH_TOKEN ist nicht gesetzt — Start abgebrochen.")
if len(AUTH_TOKEN) < 20:
    log.warning("AUTH_TOKEN ist kurz. Empfohlen: openssl rand -hex 32")

app = FastAPI(title="WhatsApp Voice Transcribe", version="1.1.0", lifespan=lifespan)
app.add_middleware(BearerAuthMiddleware)
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["POST", "GET"],
        allow_headers=["Authorization", "Content-Type"],
    )


class TranscribeRequest(BaseModel):
    audio_b64: str = Field(..., description="Rohe Audiodatei, base64-kodiert")
    mime: str = "audio/ogg"
    # Wird entgegengenommen, damit die Extension ihre Anfragen zuordnen kann,
    # aber bewusst nirgends gespeichert oder protokolliert: die WhatsApp-ID
    # enthaelt die Telefonnummer des Chatpartners.
    message_id: str | None = None
    language: str | None = Field(default=None, description="ISO-639-1, None = auto")


class TranscribeResponse(BaseModel):
    transcript: str
    summary: list[str]
    language: str | None = None
    duration_sec: float | None = None
    cached: bool = False
    source: Literal["whisper"] = "whisper"


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": _model is not None,
        "whisper_model": WHISPER_MODEL,
        "device": WHISPER_DEVICE,
        "summary": _summary_available(),
        "summary_model": SUMMARY_MODEL if _summary_available() else None,
        "cache_ttl_days": CACHE_TTL_DAYS or None,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    if len(req.audio_b64) > MAX_BODY_BYTES:
        raise HTTPException(413, "Audio zu gross.")

    try:
        audio = base64.b64decode(req.audio_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "audio_b64 ist kein gueltiges Base64.")

    if not audio:
        raise HTTPException(400, "Leere Audiodaten.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(413, f"Audio groesser als {MAX_AUDIO_BYTES} Bytes.")

    sha = hashlib.sha256(audio).hexdigest()
    if (hit := cache_get(sha)) is not None:
        log.info("cache hit  %s", sha[:12])
        return TranscribeResponse(**hit, cached=True)

    async with _slots:
        t0 = time.time()
        try:
            transcript, lang, duration = await asyncio.to_thread(
                _transcribe_sync, audio, req.language or WHISPER_LANGUAGE
            )
        except Exception as exc:  # noqa: BLE001 — Decoder-Fehler sind vielfaeltig
            log.exception("Transkription fehlgeschlagen")
            raise HTTPException(422, f"Transkription fehlgeschlagen: {exc}") from exc
        whisper_sec = time.time() - t0

    if not transcript:
        return TranscribeResponse(transcript="", summary=[], language=lang, duration_sec=duration)

    summary: list[str] = []
    if _summary_available() and len(transcript.split()) >= SUMMARY_MIN_WORDS:
        try:
            summary = await asyncio.to_thread(_summarize_sync, transcript)
        except Exception:  # noqa: BLE001
            log.exception("Summary-Schritt uebersprungen")

    # Bewusst ohne Transkript-Inhalt und ohne message_id im Log.
    log.info(
        "transkribiert %s  %.1fs Audio  %.1fs Whisper  %d Woerter  %d Stichpunkte",
        sha[:12], duration, whisper_sec, len(transcript.split()), len(summary),
    )

    payload = {
        "transcript": transcript,
        "summary": summary,
        "language": lang,
        "duration_sec": duration,
    }
    cache_put(sha, payload)
    return TranscribeResponse(**payload)
