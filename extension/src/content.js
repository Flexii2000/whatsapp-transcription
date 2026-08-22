/**
 * WhatsApp Sprachmemo-Transkription — Content-Script (Isolated World).
 *
 * Findet empfangene Sprachnachrichten im DOM, holt die entschluesselten
 * Audiobytes aus der blob:-URL des <audio>-Elements, schickt sie an den
 * Service-Worker (der spricht mit dem Backend) und haengt das Ergebnis als
 * Untertext in die Nachrichtenblase.
 *
 * WhatsApp Web hat keine stabilen CSS-Klassen. Alles, was sich an der
 * Oberflaeche aendern kann, steht deshalb gebuendelt in SELECTORS —
 * das ist die einzige Stelle, die bei einem WhatsApp-Redesign angefasst
 * werden muss.
 */
(() => {
  "use strict";

  const SELECTORS = {
    // Anker ist immer das <audio>-Element — das ueberlebt jedes Redesign.
    audio: "audio",
    // Nachrichtenblase, eingehend / ausgehend
    bubbleIn: ".message-in",
    bubbleOut: ".message-out",
    // Traegt die WhatsApp-Message-ID, Format: <fromMe>_<chatId>_<msgId>
    idHolder: "[data-id]",
    // Play/Pause-Knopf innerhalb der Blase (nur fuer den manuellen Nudge)
    playButton: 'button[aria-label], div[role="button"][aria-label]',
  };

  const DEFAULTS = {
    backendUrl: "",
    authToken: "",
    autoTranscribe: true,
    autoForcePlay: false,      // sendet Gelesen-Bestaetigung — bewusst aus
    expandFullByDefault: false,
    maxParallel: 2,
    srcWaitMs: 6000,
    debug: false,
  };

  let cfg = { ...DEFAULTS };

  /** messageKey -> Eintrag */
  const registry = new Map();
  const queue = [];
  let active = 0;
  let bridgeSeq = 0;
  const bridgePending = new Map();

  const log = (...a) => cfg.debug && console.log("[WA-Transkript]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- Utils

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function messageKeyOf(audioEl) {
    const holder = audioEl.closest(SELECTORS.idHolder);
    const id = holder && holder.getAttribute("data-id");
    if (id) return id;
    // Ohne data-id gibt es keinen ueber Reloads stabilen Schluessel —
    // dann eben nur fuer diese Sitzung.
    if (!audioEl.dataset.watFallbackKey) {
      audioEl.dataset.watFallbackKey = "session-" + Math.random().toString(36).slice(2);
    }
    return audioEl.dataset.watFallbackKey;
  }

  /** true = empfangen, false = selbst gesendet, null = unklar */
  function isIncoming(audioEl) {
    if (audioEl.closest(SELECTORS.bubbleIn)) return true;
    if (audioEl.closest(SELECTORS.bubbleOut)) return false;
    const holder = audioEl.closest(SELECTORS.idHolder);
    const id = (holder && holder.getAttribute("data-id")) || "";
    if (id.startsWith("false_")) return true;
    if (id.startsWith("true_")) return false;
    return null;
  }

  function findBubble(audioEl) {
    return (
      audioEl.closest(SELECTORS.bubbleIn) ||
      audioEl.closest(SELECTORS.bubbleOut) ||
      audioEl.closest(SELECTORS.idHolder)
    );
  }

  /** Container innerhalb der Blase, in den das Panel gehaengt wird. */
  function findMountParent(bubble) {
    const inner = bubble.querySelector(":scope > div");
    return inner || bubble;
  }

  /**
   * Die Zeile mit Uhrzeit und Haken. Das Panel gehoert davor, damit die
   * Uhrzeit wie gewohnt unten rechts in der Blase stehen bleibt und nicht
   * mitten in der Nachricht landet.
   *
   * WhatsApp hat dafuer keine stabile Klasse, deshalb ueber den Inhalt:
   * die Meta-Zeile ist kurz und besteht im Kern aus einer Uhrzeit.
   */
  function findMetaRow(parent) {
    const kids = Array.from(parent.children);
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid.dataset && kid.dataset.watPanel) continue;
      const text = (kid.textContent || "").trim();
      if (text.length <= 14 && /^\d{1,2}[:.]\d{2}(\s?[APap][Mm])?$/.test(text)) return kid;
    }
    return null;
  }

  function usableSrc(audioEl) {
    const s = audioEl.currentSrc || audioEl.getAttribute("src") || "";
    return /^(blob:|data:|https?:)/.test(s) ? s : "";
  }

  // ------------------------------------------------- Audiobytes besorgen

  function waitForSrc(audioEl, timeoutMs) {
    const now = usableSrc(audioEl);
    if (now) return Promise.resolve(now);

    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(val);
      };
      const check = () => {
        const s = usableSrc(audioEl);
        if (s) finish(s);
      };
      const obs = new MutationObserver(check);
      obs.observe(audioEl, { attributes: true, attributeFilter: ["src"] });
      // WhatsApp setzt src teils ueber die Property statt ueber das Attribut,
      // was der MutationObserver nicht sieht — deshalb zusaetzlich pollen.
      const poll = setInterval(check, 250);
      const timer = setTimeout(() => finish(""), timeoutMs);
    });
  }

  function bridgeFetch(url) {
    return new Promise((resolve, reject) => {
      const id = "b" + ++bridgeSeq;
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        reject(new Error("Page-Bridge hat nicht geantwortet"));
      }, 20000);

      bridgePending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.ok) resolve({ b64: msg.b64, mime: msg.mime, size: msg.size });
        else reject(new Error(msg.error || "Bridge-Fehler"));
      });

      window.dispatchEvent(
        new CustomEvent("wat:blob-request", { detail: JSON.stringify({ id, url }) })
      );
    });
  }

  window.addEventListener("wat:blob-response", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    const cb = bridgePending.get(msg.id);
    if (!cb) return;
    bridgePending.delete(msg.id);
    cb(msg);
  });

  async function readAudio(audioEl) {
    let src = await waitForSrc(audioEl, cfg.srcWaitMs);

    if (!src && cfg.autoForcePlay) {
      log("kein src — erzwinge Laden ueber Play/Pause");
      await nudgePlay(audioEl);
      src = await waitForSrc(audioEl, cfg.srcWaitMs);
    }
    if (!src) {
      const err = new Error("Audio noch nicht geladen");
      err.code = "needs-play";
      throw err;
    }

    // Erst der direkte Weg, dann die Bruecke im Seitenkontext.
    try {
      const res = await fetch(src);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) {
          const mime = (res.headers.get("content-type") || "audio/ogg").split(";")[0].trim();
          return { b64: arrayBufferToBase64(buf), mime, size: buf.byteLength };
        }
      }
    } catch (e) {
      log("direkter Blob-Fetch fehlgeschlagen, nutze Bridge:", e.message);
    }
    return await bridgeFetch(src);
  }

  /**
   * Stoesst WhatsApps eigenen Media-Download an, indem kurz abgespielt wird.
   * ACHTUNG: markiert die Sprachnachricht fuer den Absender als abgehoert.
   * Wird nur nach ausdruecklicher Freigabe aufgerufen.
   */
  async function nudgePlay(audioEl) {
    const prev = { muted: audioEl.muted, volume: audioEl.volume, time: audioEl.currentTime };
    audioEl.muted = true;
    audioEl.volume = 0;

    const bubble = findBubble(audioEl);
    const btn =
      bubble &&
      Array.from(bubble.querySelectorAll(SELECTORS.playButton)).find((b) =>
        /play|abspielen|wiedergabe/i.test(b.getAttribute("aria-label") || "")
      );

    try {
      if (btn) btn.click();
      else await audioEl.play().catch(() => {});
      await sleep(400);
    } finally {
      try {
        if (btn) btn.click();
        else audioEl.pause();
        audioEl.currentTime = prev.time;
      } catch {}
      audioEl.muted = prev.muted;
      audioEl.volume = prev.volume;
    }
  }

  // ----------------------------------------------------------- UI / Panel

  function buildPanel(entry) {
    const root = document.createElement("div");
    root.className = "wat";
    root.dataset.watPanel = entry.key;
    // Klicks im Panel duerfen nicht die WhatsApp-Nachricht selektieren
    // oder das Kontextmenue der Blase ausloesen.
    ["click", "dblclick", "mousedown", "pointerdown"].forEach((t) =>
      root.addEventListener(t, (e) => e.stopPropagation())
    );

    const head = document.createElement("div");
    head.className = "wat__head";

    const label = document.createElement("span");
    label.className = "wat__label";
    head.appendChild(label);

    const spacer = document.createElement("span");
    spacer.className = "wat__spacer";
    head.appendChild(spacer);

    // Kein Handler hier: welche Aktion der Knopf ausloest, haengt vom
    // Zustand ab und wird deshalb ausschliesslich in render() gesetzt.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wat__toggle";
    head.appendChild(toggle);

    const bullets = document.createElement("ul");
    bullets.className = "wat__bullets";

    const full = document.createElement("div");
    full.className = "wat__full";

    root.append(head, bullets, full);
    entry.nodes = { root, label, toggle, bullets, full };
    return root;
  }

  function render(entry) {
    if (!entry.nodes) return;
    const { root, label, toggle, bullets, full } = entry.nodes;
    root.dataset.watState = entry.state;

    bullets.textContent = "";
    full.textContent = "";
    toggle.hidden = true;
    toggle.className = "wat__toggle";
    toggle.onclick = null;

    if (entry.state === "pending") {
      label.textContent = entry.stage || "Transkribiere";
      root.classList.add("wat--busy");
      return;
    }
    root.classList.remove("wat--busy");

    if (entry.state === "needs-play") {
      label.textContent = "Sprachnachricht noch nicht geladen";
      toggle.hidden = false;
      toggle.textContent = "Laden & transkribieren";
      toggle.classList.add("wat__toggle--action");
      toggle.onclick = () => {
        entry.forcePlayOnce = true;
        entry.state = "idle";
        enqueue(entry.key, true);
      };
      return;
    }

    if (entry.state === "error") {
      label.textContent = entry.error || "Fehler";
      toggle.hidden = false;
      toggle.textContent = "Nochmal";
      toggle.classList.add("wat__toggle--action");
      toggle.onclick = () => {
        entry.state = "idle";
        enqueue(entry.key, true);
      };
      return;
    }

    if (entry.state !== "done") return;

    const data = entry.data || {};
    const hasSummary = Array.isArray(data.summary) && data.summary.length > 0;
    const transcript = (data.transcript || "").trim();

    if (!transcript) {
      label.textContent = "Kein Text erkannt";
      return;
    }

    if (hasSummary) {
      label.textContent = "Zusammenfassung";
      data.summary.forEach((line) => {
        const li = document.createElement("li");
        // Das Modell markiert Handlungsaufforderungen mit "-> ". Das Zeichen
        // selbst zeichnet das CSS, hier wird es aus dem Text entfernt.
        const isAction = /^\s*(->|→)\s*/.test(line);
        // textContent, nicht innerHTML — der Text kommt aus einer fremden
        // Nachricht und darf niemals als Markup interpretiert werden.
        li.textContent = line.replace(/^\s*(->|→)\s*/, "");
        if (isAction) li.className = "wat__action";
        bullets.appendChild(li);
      });

      toggle.hidden = false;
      toggle.textContent = entry.expanded ? "Volltext ausblenden" : "Volltext";
      toggle.onclick = () => {
        entry.expanded = !entry.expanded;
        render(entry);
      };
      if (entry.expanded) full.textContent = transcript;
    } else {
      // Kurze Memos bekommen keine Stichpunkte — dann direkt den Text.
      label.textContent = "Transkript";
      full.textContent = transcript;
    }
  }

  function mount(entry) {
    const parent = findMountParent(entry.bubble);
    if (!parent) return;
    if (!entry.nodes) buildPanel(entry);
    if (entry.nodes.root.parentNode !== parent) {
      const meta = findMetaRow(parent);
      if (meta) parent.insertBefore(entry.nodes.root, meta);
      else parent.appendChild(entry.nodes.root);
      render(entry);
    }
  }

  /**
   * Einmal pro Sekunde: Panels zurueckholen, die React beim Neuaufbau der
   * Blase entfernt hat, und alles einreihen, was sichtbar und noch nicht
   * transkribiert ist.
   *
   * WhatsApp entfernt weit weggescrollte Nachrichten aus dem DOM. Der
   * isConnected-Test siebt die deshalb billig aus, bevor ein
   * getBoundingClientRect ein Layout erzwingt.
   */
  function sweep() {
    for (const entry of registry.values()) {
      if (!entry.bubble || !entry.bubble.isConnected) continue;
      if (!entry.nodes || !entry.nodes.root.isConnected) mount(entry);
      if (cfg.autoTranscribe && entry.state === "idle" && nearViewport(entry.bubble)) {
        enqueue(entry.key);
      }
    }
  }

  // ------------------------------------------------------------- Pipeline

  function enqueue(key, front = false) {
    const entry = registry.get(key);
    if (!entry || entry.state === "pending" || entry.state === "done") return;
    if (queue.includes(key)) return;
    entry.state = "pending";
    entry.stage = "Warte";
    render(entry);
    if (front) queue.unshift(key);
    else queue.push(key);
    pump();
  }

  function pump() {
    while (active < cfg.maxParallel && queue.length > 0) {
      const key = queue.shift();
      const entry = registry.get(key);
      if (!entry) continue;
      active++;
      process(entry).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function process(entry) {
    try {
      entry.stage = "Lade Audio";
      render(entry);

      if (entry.forcePlayOnce) {
        entry.forcePlayOnce = false;
        await nudgePlay(entry.audio);
      }

      const audio = await readAudio(entry.audio);
      log("Audio gelesen", entry.key, audio.size, "Bytes", audio.mime);

      entry.stage = "Transkribiere";
      render(entry);

      const res = await chrome.runtime.sendMessage({
        type: "wat:transcribe",
        key: entry.key,
        audio_b64: audio.b64,
        mime: audio.mime,
      });

      if (!res || !res.ok) throw new Error((res && res.error) || "Keine Antwort vom Backend");

      entry.data = res.data;
      entry.state = "done";
      entry.expanded = cfg.expandFullByDefault;
    } catch (err) {
      if (err && err.code === "needs-play") {
        entry.state = "needs-play";
      } else {
        entry.state = "error";
        entry.error = (err && err.message) || String(err);
        log("Fehler bei", entry.key, entry.error);
      }
    }
    render(entry);
  }

  // ----------------------------------------------------- Entdeckung / Obs

  /**
   * Liegt das Element im oder nahe am sichtbaren Bereich?
   *
   * Bewusst ueber getBoundingClientRect statt IntersectionObserver: der
   * Observer meldet in einem Hintergrundtab keine Schnittmenge, und genau
   * dort steht WhatsApp Web die meiste Zeit. Das Layout existiert dagegen
   * auch im Hintergrund, die Rechtecke stimmen also weiterhin.
   */
  function nearViewport(el, margin = 600) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false; // ausgeblendet
    const h = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -margin && r.top < h + margin;
  }

  function consider(audioEl) {
    if (audioEl.dataset.watSeen === "1") return;

    const incoming = isIncoming(audioEl);
    if (incoming === false) return; // selbst gesendet
    const bubble = findBubble(audioEl);
    if (!bubble) return;

    audioEl.dataset.watSeen = "1";
    const key = messageKeyOf(audioEl);

    const existing = registry.get(key);
    if (existing) {
      // Gleiche Nachricht neu gerendert: DOM-Referenzen auffrischen,
      // Ergebnis behalten.
      existing.audio = audioEl;
      existing.bubble = bubble;
      existing.nodes = null;
      mount(existing);
      bubble.dataset.watKey = key;
      return;
    }

    const entry = {
      key,
      audio: audioEl,
      bubble,
      // Nicht "idle": solange der lokale Cache noch antwortet, darf sweep()
      // die Nachricht nicht einreihen — sonst liest sie das Audio aus und
      // kodiert es, obwohl das Transkript langst vorliegt.
      state: "cache",
      expanded: cfg.expandFullByDefault,
      data: null,
      nodes: null,
    };
    registry.set(key, entry);
    bubble.dataset.watKey = key;
    mount(entry);

    // Bereits transkribiert? Dann sofort anzeigen, ohne Backend.
    chrome.runtime
      .sendMessage({ type: "wat:cache-get", key })
      .then((res) => {
        if (res && res.ok && res.data) {
          entry.data = res.data;
          entry.state = "done";
        } else {
          entry.state = "idle";
        }
      })
      .catch(() => {
        entry.state = "idle";
      })
      .finally(() => render(entry));
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(SELECTORS.audio).forEach((el) => consider(el));
    if (root instanceof HTMLAudioElement) consider(root);
  }

  function start() {
    scan(document);

    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1) scan(node);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setInterval(sweep, 1000);
    sweep(); // nicht erst eine Sekunde warten
    log("gestartet");
  }

  chrome.storage.local.get("settings").then(({ settings }) => {
    cfg = { ...DEFAULTS, ...(settings || {}) };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      cfg = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      log("Einstellungen aktualisiert");
    }
  });
})();
