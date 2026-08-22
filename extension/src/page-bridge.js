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

  /** Bekannte Ablageorte des entschluesselten Blobs, in Reihenfolge der Wahrscheinlichkeit. */
  function mediaBlobOf(msg) {
    const md = msg.mediaData || {};
    const kandidaten = [
      ["mediaData.mediaBlob._blob", md.mediaBlob && md.mediaBlob._blob],
      ["mediaData.mediaBlob", md.mediaBlob],
      ["mediaData._blob", md._blob],
      ["mediaData.blob", md.blob],
      ["msg.mediaBlob", msg.mediaBlob],
    ];
    for (const [weg, wert] of kandidaten) {
      if (wert instanceof Blob) return { blob: wert, weg };
      // Manche Builds verpacken den Blob noch eine Ebene tiefer.
      if (wert && wert._blob instanceof Blob) return { blob: wert._blob, weg: weg + "._blob" };
    }
    return null;
  }

  async function ladeAudio(msg) {
    let treffer = mediaBlobOf(msg);
    if (treffer) return { ...treffer, weg: "bereits geladen (" + treffer.weg + ")" };

    if (typeof msg.downloadMedia === "function") {
      await msg.downloadMedia({ downloadEvenIfExpensive: true, isUserInitiated: false });
      treffer = mediaBlobOf(msg);
      if (treffer) return { ...treffer, weg: "downloadMedia -> " + treffer.weg };
    }

    // Letzter Weg: der DownloadManager direkt. Er stolpert in manchen Builds
    // ueber fehlenden Logging-Kontext, deshalb erst als Rueckfallebene.
    const { dm } = wa();
    if (dm && typeof dm.downloadAndMaybeDecrypt === "function") {
      const res = await dm.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
      });
      if (res instanceof Blob) return { blob: res, weg: "downloadAndMaybeDecrypt" };
      if (res instanceof ArrayBuffer) {
        return { blob: new Blob([res], { type: msg.mimetype || "audio/ogg" }),
                 weg: "downloadAndMaybeDecrypt (ArrayBuffer)" };
      }
    }

    throw new Error("Audiodaten nicht auffindbar — WhatsApp hat vermutlich umgebaut");
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
