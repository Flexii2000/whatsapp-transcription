"use strict";

const DEFAULTS = {
  backendUrl: "",
  authToken: "",
  autoTranscribe: true,
  autoForcePlay: false,
  expandFullByDefault: false,
  maxParallel: 2,
  debug: false,
};

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

function readForm() {
  const out = {};
  for (const key of FIELDS) {
    const el = $(key);
    if (!el) continue;
    if (el.type === "checkbox") out[key] = el.checked;
    else if (el.type === "number") out[key] = Math.min(6, Math.max(1, Number(el.value) || 2));
    else out[key] = el.value.trim();
  }
  out.backendUrl = out.backendUrl.replace(/\/+$/, "");
  return out;
}

function writeForm(cfg) {
  for (const key of FIELDS) {
    const el = $(key);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(cfg[key]);
    else el.value = cfg[key];
  }
}

function flash(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 5000);
}

/**
 * Aus einer Backend-URL das Muster machen, das chrome.permissions erwartet.
 *
 * Der Pfad kommt bewusst mit hinein: bei einer Backend-URL wie
 * https://fherrmann.com/whisper waere ein Muster auf die blosse Origin eine
 * Berechtigung fuer die gesamte Domain. So bleibt sie auf /whisper/ begrenzt.
 */
function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "") + "/*";
  } catch {
    return null;
  }
}

async function refreshPermissionHint() {
  const url = $("backendUrl").value.trim();
  const pattern = originPattern(url);
  const el = $("perm");

  if (!pattern) {
    el.textContent = url ? "Das sieht nicht nach einer gültigen URL aus." : "";
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  el.textContent = granted
    ? `Zugriff auf ${pattern} ist erteilt.`
    : `Chrome muss den Zugriff auf ${pattern} noch erlauben — Knopf „Zugriff erlauben“.`;
}

// ------------------------------------------------------------------ Events

$("grant").addEventListener("click", async () => {
  const pattern = originPattern($("backendUrl").value.trim());
  if (!pattern) return flash("Erst eine gültige Backend-URL eintragen.", "err");
  try {
    // Muss direkt aus der Nutzeraktion heraus laufen, sonst lehnt Chrome ab.
    const ok = await chrome.permissions.request({ origins: [pattern] });
    flash(ok ? "Zugriff erteilt." : "Zugriff abgelehnt.", ok ? "ok" : "err");
  } catch (err) {
    flash(String(err.message || err), "err");
  }
  refreshPermissionHint();
});

$("test").addEventListener("click", async () => {
  const out = $("testOut");
  out.hidden = false;
  out.textContent = "Frage Backend …";

  // Erst speichern — der Service-Worker liest die Zugangsdaten aus dem Storage.
  await chrome.storage.local.set({ settings: readForm() });

  try {
    const res = await chrome.runtime.sendMessage({ type: "wat:health" });
    if (!res || !res.ok) throw new Error((res && res.error) || "Keine Antwort");
    const d = res.data;
    out.textContent =
      `Verbindung steht.\n` +
      `Whisper-Modell : ${d.whisper_model} (${d.device})\n` +
      `Modell geladen : ${d.ok ? "ja" : "noch nicht — Server startet"}\n` +
      `Claude-Summary : ${d.summary ? d.summary_model : "aus (kein API-Key auf dem Server)"}`;
    flash("Backend erreichbar.", "ok");
  } catch (err) {
    out.textContent = String(err.message || err);
    flash("Verbindung fehlgeschlagen.", "err");
  }
});

$("clearCache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "wat:cache-clear" });
  flash("Lokaler Cache geleert.", "ok");
});

$("save").addEventListener("click", async () => {
  const cfg = readForm();
  if (cfg.backendUrl && !originPattern(cfg.backendUrl)) {
    return flash("Backend-URL ist ungültig.", "err");
  }
  await chrome.storage.local.set({ settings: cfg });
  flash("Gespeichert.", "ok");
  refreshPermissionHint();
});

$("backendUrl").addEventListener("input", refreshPermissionHint);

// -------------------------------------------------------------------- Init

chrome.storage.local.get("settings").then(({ settings }) => {
  writeForm({ ...DEFAULTS, ...(settings || {}) });
  refreshPermissionHint();
});
