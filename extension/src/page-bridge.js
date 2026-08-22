/**
 * Laeuft im MAIN world (Seitenkontext von web.whatsapp.com).
 *
 * Warum es das braucht: WhatsApp entschluesselt Sprachmemos und legt sie als
 * blob:-URL ab. Blob-URLs sind an den Realm gebunden, der sie erzeugt hat.
 * Der Zugriff aus dem Isolated World des Content-Scripts klappt meistens,
 * aber nicht zuverlaessig ueber alle Chrome-Versionen. Diese Bruecke holt die
 * Bytes notfalls dort ab, wo sie garantiert lesbar sind.
 *
 * Kommunikation laeuft ueber JSON-Strings: Objekte aus dem Isolated World
 * sind im MAIN world nicht immer direkt benutzbar, Strings immer.
 */
(() => {
  "use strict";

  const REQ = "wat:blob-request";
  const RES = "wat:blob-response";

  function bytesToBase64(bytes) {
    // In Bloecken, sonst sprengen lange Memos den Argument-Stack von
    // String.fromCharCode.
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  window.addEventListener(REQ, (event) => {
    let req;
    try {
      req = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!req || !req.id || !req.url) return;

    const reply = (payload) => {
      window.dispatchEvent(
        new CustomEvent(RES, { detail: JSON.stringify({ id: req.id, ...payload }) })
      );
    };

    fetch(req.url)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
        return res.arrayBuffer().then((buf) => ({ buf, mime }));
      })
      .then(({ buf, mime }) => {
        reply({
          ok: true,
          b64: bytesToBase64(new Uint8Array(buf)),
          mime: mime || "audio/ogg",
          size: buf.byteLength,
        });
      })
      .catch((err) => reply({ ok: false, error: String((err && err.message) || err) }));
  });
})();
