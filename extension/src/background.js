/**
 * Service-Worker. Einziger Ort, der mit dem Backend spricht.
 *
 * Warum nicht direkt aus dem Content-Script: Fetches aus dem Service-Worker
 * laufen unter der Host-Permission der Extension und damit ohne CORS-Preflight
 * gegen den eigenen Server.
 */

const DEFAULTS = {
  backendUrl: "",
  authToken: "",
  timeoutMs: 240000,
  cacheLimit: 500,
};

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

// ------------------------------------------------------------------ Cache

async function cacheGet(key) {
  const { cache } = await chrome.storage.local.get("cache");
  const hit = cache && cache[key];
  return hit ? hit.data : null;
}

async function cachePut(key, data, limit) {
  const { cache } = await chrome.storage.local.get("cache");
  const next = cache || {};
  next[key] = { data, ts: Date.now() };

  const keys = Object.keys(next);
  if (keys.length > limit) {
    keys
      .sort((a, b) => next[a].ts - next[b].ts)
      .slice(0, keys.length - limit)
      .forEach((k) => delete next[k]);
  }
  await chrome.storage.local.set({ cache: next });
}

// ---------------------------------------------------------------- Backend

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function backendFetch(path, init, timeoutMs) {
  const cfg = await settings();
  const base = normalizeBase(cfg.backendUrl);
  if (!base) throw new Error("Keine Backend-URL konfiguriert (Extension-Optionen)");
  if (!cfg.authToken) throw new Error("Kein Token konfiguriert (Extension-Optionen)");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? cfg.timeoutMs);

  try {
    const res = await fetch(base + path, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.authToken}`,
        ...(init && init.headers),
      },
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.detail || JSON.stringify(body);
      } catch {
        detail = await res.text().catch(() => "");
      }
      if (res.status === 401) throw new Error("Token abgelehnt (401)");
      throw new Error(`Backend ${res.status}: ${String(detail).slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Zeitüberschreitung — Backend zu langsam?");
    if (err instanceof TypeError) {
      throw new Error(
        "Backend nicht erreichbar. URL korrekt und Zugriff in den Optionen erlaubt?"
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function transcribe(msg) {
  const cfg = await settings();

  const cached = await cacheGet(msg.key);
  if (cached) return { ok: true, data: cached, cached: true };

  const data = await backendFetch("/transcribe", {
    method: "POST",
    body: JSON.stringify({
      audio_b64: msg.audio_b64,
      mime: msg.mime || "audio/ogg",
      message_id: msg.key,
    }),
  });

  await cachePut(msg.key, data, cfg.cacheLimit);
  return { ok: true, data };
}

// ---------------------------------------------------------------- Routing

const ROUTES = {
  "wat:transcribe": (msg) => transcribe(msg),
  "wat:cache-get": async (msg) => ({ ok: true, data: await cacheGet(msg.key) }),
  "wat:health": async () => ({ ok: true, data: await backendFetch("/health", { method: "GET" }, 15000) }),
  "wat:cache-clear": async () => {
    await chrome.storage.local.remove("cache");
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && ROUTES[msg.type];
  if (!handler) return false;

  handler(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // asynchrone Antwort
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
