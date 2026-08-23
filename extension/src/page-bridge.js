/**
 * Laeuft im MAIN world (Seitenkontext von web.whatsapp.com).
 *
 * WhatsApp Web haengt Sprachnachrichten seit einem Redesign NICHT mehr an ein
 * <audio>-Element. Die Wellenform ist ein <canvas>, abgespielt wird ueber die
 * Web-Audio-API, und im DOM steht nirgends eine blob:-URL. Aus dem DOM kommt
 * man an die Audiodaten also gar nicht heran.
 *
 * Erreichbar sind sie ueber WhatsApps eigenes Modulsystem: window.require()
 * nimmt Haste-Modulnamen entgegen. Gebraucht werden zwei davon:
 *
 *   WAWebMsgCollection   der Nachrichtenspeicher (MsgCollection)
 *   WAWebDownloadManager Herunterladen und Entschluesseln von Medien
 *
 * Das ist bewusst Reverse Engineering und entsprechend zerbrechlich: WhatsApp
 * kann Modulnamen oder Feldnamen jederzeit aendern. Deshalb probiert
 * mediaBlobOf() mehrere bekannte Ablageorte durch und meldet im Debug-Modus,
 * welcher Weg getragen hat — das macht eine spaetere Anpassung zu einer
 * Frage von Minuten statt einer neuen Fehlersuche.
 *
 * Kommunikation mit dem Content-Script ueber JSON-Strings: Objekte aus dem
 * Isolated World sind im MAIN world nicht immer direkt benutzbar, Strings immer.
 */
(() => {
  "use strict";

  const REQ = "wat:request";
  const RES = "wat:response";

  let cache = null;

  function wa() {
    if (cache) return cache;
    if (typeof window.require !== "function") {
      throw new Error("WhatsApps Modulsystem (window.require) nicht gefunden");
    }
    const mod = window.require("WAWebMsgCollection");
    const store = mod.MsgCollection || mod.default || mod;
    if (!store) throw new Error("WAWebMsgCollection liefert keinen Store");

    let dm = null;
    try {
      dm = window.require("WAWebDownloadManager").downloadManager;
    } catch {
      /* optional — der Weg ueber msg.downloadMedia() reicht meistens */
    }
    cache = { store, dm };
    return cache;
  }

  function models() {
    const { store } = wa();
    return store.getModelsArray ? store.getModelsArray() : store.models || [];
  }

  /** Das data-id aus dem DOM ist die blanke Message-ID, nicht der serialisierte Key. */
  function findMsg(id) {
    return models().find(
      (m) => m && m.id && (m.id.id === id || m.id._serialized === id)
    );
  }

  /**
   * Sucht den entschluesselten Blob in mediaData.
   *
   * Bewusst als begrenzte Tiefensuche statt fester Feldnamen: welches Feld
   * WhatsApp benutzt, hat sich schon mehrfach geaendert. Gemeldet wird der
   * gefundene Pfad, damit im Debug-Log steht, wo er diesmal lag.
   */
  function mediaBlobOf(msg) {
    const wurzeln = [
      ["mediaData", msg.mediaData],
      ["msg", msg],
    ];
    for (const [name, wurzel] of wurzeln) {
      const treffer = sucheBlob(wurzel, name, 2, new Set());
      if (treffer) return treffer;
    }
    return null;
  }

  function sucheBlob(obj, pfad, tiefe, gesehen) {
    if (!obj || typeof obj !== "object" || tiefe < 0 || gesehen.has(obj)) return null;
    gesehen.add(obj);
    if (obj instanceof Blob) return { blob: obj, weg: pfad };

    for (const key of Object.keys(obj)) {
      // Interne Model-Felder und Funktionen ueberspringen — dort liegt nie ein Blob.
      if (key.startsWith("__") || key === "_collections" || key === "_definition") continue;
      let wert;
      try {
        wert = obj[key];
      } catch {
        continue;
      }
      if (wert instanceof Blob) return { blob: wert, weg: pfad + "." + key };
      if (wert && typeof wert === "object") {
        const t = sucheBlob(wert, pfad + "." + key, tiefe - 1, gesehen);
        if (t) return t;
      }
    }
    return null;
  }

  const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Der Download laeuft asynchron ins Modell — danach erscheint der Blob erst. */
  async function warteAufBlob(msg, timeoutMs) {
    const bis = Date.now() + timeoutMs;
    while (Date.now() < bis) {
      const t = mediaBlobOf(msg);
      if (t) return t;
      await schlaf(200);
    }
    return null;
  }

  /**
   * Attrappe fuer Metas Performance-Logger. downloadAndMaybeDecrypt ruft
   * darauf addAnnotations() auf; ohne ein solches Objekt stirbt der Aufruf mit
   * "Cannot read properties of undefined (reading 'addAnnotations')".
   * Ein Proxy fangt auch weitere Logger-Methoden ab, die spaeter dazukommen.
   */
  function qplAttrappe() {
    return new Proxy({}, { get: () => () => undefined });
  }

  function kurz(err) {
    return String((err && err.message) || err).slice(0, 120);
  }

  async function ladeAudio(msg) {
    const schon = mediaBlobOf(msg);
    if (schon) return { ...schon, weg: "bereits geladen (" + schon.weg + ")" };

    const { dm } = wa();
    const wege = [];

    // Eigens dafuer gebaute Methode am Modell — erster Versuch.
    if (typeof msg.forceDownloadMediaEvenIfExpensive === "function") {
      wege.push(["forceDownloadMediaEvenIfExpensive",
                 () => msg.forceDownloadMediaEvenIfExpensive()]);
    }
    // Vollstaendiger Optionssatz: mit nur zwei der sechs Felder blieb der
    // Logger-Kontext undefiniert.
    if (typeof msg.downloadMedia === "function") {
      wege.push(["downloadMedia", () => msg.downloadMedia({
        downloadEvenIfExpensive: true,
        isAutoDownload: false,
        isUserInitiated: true,
        rmrReason: 1,
        shouldSequenceDownload: false,
        shouldThrowAbortError: true,
      })]);
    }
    // Rueckfallebene: der DownloadManager direkt, mit Logger-Attrappe.
    if (dm && typeof dm.downloadAndMaybeDecrypt === "function") {
      wege.push(["downloadAndMaybeDecrypt", () => dm.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        mimetype: msg.mimetype,
        signal: new AbortController().signal,
        downloadOrigin: 1,
        downloadQpl: qplAttrappe(),
        partialVideoOpts: null,
      })]);
    }

    const fehler = [];
    for (const [name, fn] of wege) {
      try {
        const res = await fn();
        if (res instanceof Blob) return { blob: res, weg: name };
        if (res instanceof ArrayBuffer) {
          return { blob: new Blob([res], { type: msg.mimetype || "audio/ogg" }),
                   weg: name + " (ArrayBuffer)" };
        }
        const t = await warteAufBlob(msg, 20000);
        if (t) return { blob: t.blob, weg: name + " -> " + t.weg };
        fehler.push(name + ": kein Blob nach 20s (mediaStage=" +
                    (msg.mediaData && msg.mediaData.mediaStage) + ")");
      } catch (err) {
        fehler.push(name + ": " + kurz(err));
      }
    }

    throw new Error("Kein Weg lieferte Audiodaten — " + fehler.join(" | "));
  }

  function bytesToBase64(bytes) {
    // In Bloecken, sonst sprengen lange Memos den Argument-Stack.
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  const HANDLER = {
    /** Metadaten aus WhatsApps eigenem Modell — verlaesslicher als DOM-Raterei. */
    async info({ id }) {
      const msg = findMsg(id);
      if (!msg) return { ok: true, found: false };
      return {
        ok: true,
        found: true,
        fromMe: !!(msg.id && msg.id.fromMe),
        type: msg.type,
        durationSec: typeof msg.duration === "number" ? msg.duration : null,
        mime: msg.mimetype || null,
      };
    },

    async audio({ id }) {
      const msg = findMsg(id);
      if (!msg) return { ok: false, error: "Nachricht nicht im Speicher gefunden" };
      const { blob, weg } = await ladeAudio(msg);
      const buf = await blob.arrayBuffer();
      return {
        ok: true,
        b64: bytesToBase64(new Uint8Array(buf)),
        mime: (blob.type || msg.mimetype || "audio/ogg").split(";")[0].trim(),
        size: buf.byteLength,
        weg,
      };
    },

    /** Fuer die Diagnose in den Extension-Optionen. */
    async selftest() {
      const alle = models();
      const ptt = alle.filter((m) => m && m.type === "ptt");
      return {
        ok: true,
        modulsystem: typeof window.require === "function",
        nachrichten: alle.length,
        sprachnachrichten: ptt.length,
        davonEingehend: ptt.filter((m) => m.id && !m.id.fromMe).length,
        downloadManager: !!wa().dm,
      };
    },
  };

  window.addEventListener(REQ, (event) => {
    let req;
    try {
      req = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!req || !req.rid || !HANDLER[req.op]) return;

    const antwort = (payload) =>
      window.dispatchEvent(
        new CustomEvent(RES, { detail: JSON.stringify({ rid: req.rid, ...payload }) })
      );

    Promise.resolve()
      .then(() => HANDLER[req.op](req))
      .then(antwort)
      .catch((err) => antwort({ ok: false, error: String((err && err.message) || err) }));
  });
})();
