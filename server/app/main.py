"""
WhatsApp Voice Transcribe — Backend.

Nimmt eine Sprachnachricht (base64) entgegen, transkribiert sie lokal mit
faster-whisper und laesst Claude daraus eine Executive Summary in
Stichpunkten bauen. Der Anthropic-API-Key liegt ausschliesslich hier,
nie in der Browser-Extension.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import anthropic
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

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
    conn.commit()
    return conn


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


# --------------------------------------------------------------------------
# Whisper
# --------------------------------------------------------------------------

_model: Any = None
_gpu_sema = asyncio.Semaphore(MAX_CONCURRENCY)


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


def _transcribe_sync(path: str, language: str | None) -> tuple[str, str | None, float]:
    assert _model is not None
    segments, info = _model.transcribe(
        path,
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
    """Gibt Stichpunkte zurueck. Bei jedem Problem: leere Liste, nie eine Exception
    nach oben — ein fehlendes Summary darf das Transkript nicht kaputt machen."""
    assert _anthropic is not None
    min_b = 1
    max_b = SUMMARY_MAX_BULLETS
    try:
        resp = _anthropic.beta.messages.create(
            model=SUMMARY_MODEL,
            max_tokens=2000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT.format(min_b=min_b, max_b=max_b),
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
# App
# --------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _model, _anthropic
    _db = _db_init()

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


app = FastAPI(title="WhatsApp Voice Transcribe", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_token(authorization: str = Header(default="")) -> None:
    if not AUTH_TOKEN:
        raise HTTPException(500, "AUTH_TOKEN ist auf dem Server nicht gesetzt.")
    expected = f"Bearer {AUTH_TOKEN}"
    # constant-time, damit der Token nicht ueber Antwortzeiten erratbar ist
    import hmac
    if not hmac.compare_digest(authorization.strip(), expected):
        raise HTTPException(401, "Ungueltiger Token.")


class TranscribeRequest(BaseModel):
    audio_b64: str = Field(..., description="Rohe Audiodatei, base64-kodiert")
    mime: str = "audio/ogg"
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
    }


@app.post("/transcribe", response_model=TranscribeResponse, dependencies=[Depends(require_token)])
async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
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
        log.info("cache hit  %s  (%s)", sha[:12], req.message_id or "-")
        return TranscribeResponse(**hit, cached=True)

    suffix = {"audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
              "audio/aac": ".aac", "audio/wav": ".wav", "audio/webm": ".webm"}.get(req.mime, ".ogg")

    async with _gpu_sema:
        t0 = time.time()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
            tmp.write(audio)
            tmp.flush()
            try:
                transcript, lang, duration = await asyncio.to_thread(
                    _transcribe_sync, tmp.name, req.language or WHISPER_LANGUAGE
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
