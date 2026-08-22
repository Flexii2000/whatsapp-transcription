/**
 * WhatsApp Sprachmemo-Transkription — Content-Script (Isolated World).
 *
 * Findet empfangene Sprachnachrichten, holt die entschluesselten Audiodaten
 * ueber page-bridge.js aus WhatsApps eigenem Modulsystem und haengt das
 * Ergebnis als Untertext in die Nachrichtenblase.
 *
 * Warum nicht ueber <audio>: das gibt es in WhatsApp Web nicht mehr. Die
 * Wellenform ist ein <canvas>, abgespielt wird ueber die Web-Audio-API, und
 * im DOM steht keine blob:-URL. Deshalb liefert das DOM hier nur noch die
 * Positionen der Blasen; alles Inhaltliche kommt aus dem Modell.
 *
 * Was sich am DOM aendern kann, steht gebuendelt in SELECTORS.
 */
(() => {
  "use strict";

  const SELECTORS = {
    // Die Nachricht traegt ihre ID — im DOM die blanke Message-ID.
    message: "[data-id]",
    // Sicherster Marker fuer eine Sprachnachricht (ptt = push to talk).
    voiceIcon: '[data-icon="ptt-status"]',
    // Nur fuer den Einhaengepunkt, nicht zum Ausloesen.
    playButton: 'button[aria-label], div[role="button"][aria-label]',
  };

  const DEFAULTS = {
    backendUrl: "",
    authToken: "",
    autoTranscribe: true,
    expandFullByDefault: false,
    maxParallel: 2,
    debug: false,
  };

  let cfg = { ...DEFAULTS };

  /** messageKey -> Eintrag */
  const registry = new Map();
  const queue = [];
  let active = 0;

  const log = (...a) => cfg.debug && console.log("[WA-Transkript]", ...a);

  // ------------------------------------------------------- Seitenbruecke

  let reqSeq = 0;
  const pending = new Map();

  /**
   * Fragt page-bridge.js im Seitenkontext. Nur dort ist window.require und
   * damit WhatsApps Nachrichtenspeicher erreichbar.
   */
  function bridge(op, payload = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const rid = "r" + ++reqSeq;
      const timer = setTimeout(() => {
        pending.delete(rid);
        reject(new Error("Seitenbrücke antwortet nicht"));
      }, timeoutMs);

      pending.set(rid, (msg) => {
        clearTimeout(timer);
        if (msg.ok) resolve(msg);
        else reject(new Error(msg.error || "Brückenfehler"));
      });

      window.dispatchEvent(
        new CustomEvent("wat:request", { detail: JSON.stringify({ rid, op, ...payload }) })
      );
    });
  }

  window.addEventListener("wat:response", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    const cb = pending.get(msg.rid);
    if (!cb) return;
    pending.delete(msg.rid);
    cb(msg);
  });

  // ---------------------------------------------------------------- DOM

  /**
   * Der Container, der Player und Zeitstempel gemeinsam haelt. Dort hinein
   * kommt das Panel, und zwar vor die Zeitstempel-Zeile, damit die Uhrzeit
   * wie gewohnt unten rechts stehen bleibt.
   *
   * Alle Klassennamen in WhatsApp Web sind obfuskiert und wechseln staendig,
   * deshalb ueber die Struktur statt ueber Selektoren.
   */
  function findMount(bubble) {
    const btn = bubble.querySelector(SELECTORS.playButton);
    // Achtung: in der Blase stehen ZWEI Zeitangaben im Format m:ss — die
    // Laenge des Memos im Player ("0:38") und die Uhrzeit der Nachricht
    // ("14:32"). Gebraucht wird die zweite, und die kommt in der
    // Dokumentreihenfolge zuletzt.
    const zeiten = Array.from(bubble.querySelectorAll("span,div")).filter(
      (e) =>
        e.children.length === 0 &&
        /^\d{1,2}[:.]\d{2}(\s?[APap][Mm])?$/.test((e.textContent || "").trim())
    );
    const zeit = zeiten[zeiten.length - 1];

    if (btn && zeit) {
      let parent = zeit.parentElement;
      while (parent && parent !== bubble && !parent.contains(btn)) {
        parent = parent.parentElement;
      }
      if (parent) {
        let meta = zeit;
        while (meta && meta.parentElement !== parent) meta = meta.parentElement;
        return { parent, meta };
      }
    }
    return { parent: bubble.firstElementChild || bubble, meta: null };
  }

  // ----------------------------------------------------------- UI / Panel

  function buildPanel(entry) {
    const root = document.createElement("div");
    root.className = "wat";
    root.dataset.watPanel = entry.key;
    ["click", "dblclick", "mousedown", "pointerdown"].forEach((t) =>
      root.addEventListener(t, (e) => e.stopPropagation())
    );

    const head = document.createElement("div");
    head.className = "wat__head";

    const label = document.createElement("span");
    label.className = "wat__label";

    const spacer = document.createElement("span");
    spacer.className = "wat__spacer";

    // Kein Handler hier: welche Aktion der Knopf ausloest, haengt vom
    // Zustand ab und wird ausschliesslich in render() gesetzt.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wat__toggle";

    head.append(label, spacer, toggle);

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

    if (entry.state === "idle" && !cfg.autoTranscribe) {
      label.textContent = "Sprachnachricht";
      toggle.hidden = false;
      toggle.textContent = "Transkribieren";
      toggle.classList.add("wat__toggle--action");
      toggle.onclick = () => enqueue(entry.key, true);
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
    if (!entry.bubble || !entry.bubble.isConnected) return;
    const { parent, meta } = findMount(entry.bubble);
    if (!parent) return;
    if (!entry.nodes) buildPanel(entry);
    if (entry.nodes.root.parentNode !== parent) {
      if (meta && meta.parentElement === parent) parent.insertBefore(entry.nodes.root, meta);
      else parent.appendChild(entry.nodes.root);
      render(entry);
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

      const audio = await bridge("audio", { id: entry.key });
      log("Audio", entry.key, audio.size, "Bytes", audio.mime, "via", audio.weg);

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
      entry.state = "error";
      entry.error = (err && err.message) || String(err);
      log("Fehler bei", entry.key, entry.error);
    }
    render(entry);
  }

  // ----------------------------------------------------- Entdeckung / Obs

  function nearViewport(el, margin = 600) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const h = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -margin && r.top < h + margin;
  }

  /**
   * Einmal pro Sekunde: Panels zurueckholen, die React beim Neuaufbau der
   * Blase entfernt hat, und alles einreihen, was sichtbar und noch nicht
   * transkribiert ist.
   *
   * getBoundingClientRect statt IntersectionObserver: der meldet in einem
   * Hintergrundtab keine Schnittmenge, und genau dort steht WhatsApp meistens.
   */
  function sweep() {
    for (const entry of registry.values()) {
      // Erst wenn WhatsApps Modell bestaetigt hat, dass es eine empfangene
      // Sprachnachricht ist. Sonst blitzt an jeder Nachricht kurz ein Panel
      // auf, auch an selbst gesendeten.
      if (!entry.ready) continue;
      if (!entry.bubble || !entry.bubble.isConnected) continue;
      if (!entry.nodes || !entry.nodes.root.isConnected) mount(entry);
      if (cfg.autoTranscribe && entry.state === "idle" && nearViewport(entry.bubble)) {
        enqueue(entry.key);
      }
    }
  }

  function consider(bubble) {
    if (bubble.dataset.watSeen === "1") return;
    const key = bubble.getAttribute("data-id");
    if (!key) return;
    bubble.dataset.watSeen = "1";

    const existing = registry.get(key);
    if (existing) {
      // Gleiche Nachricht neu gerendert: DOM-Referenz auffrischen, Ergebnis behalten.
      existing.bubble = bubble;
      existing.nodes = null;
      mount(existing);
      return;
    }

    const entry = {
      key,
      bubble,
      // Nicht "idle": solange Metadaten und Cache noch antworten, darf sweep()
      // die Nachricht nicht einreihen.
      state: "cache",
      expanded: cfg.expandFullByDefault,
      data: null,
      nodes: null,
    };
    registry.set(key, entry);

    Promise.all([
      bridge("info", { id: key }, 15000).catch((e) => {
        log("info fehlgeschlagen", key, e.message);
        return null;
      }),
      chrome.runtime.sendMessage({ type: "wat:cache-get", key }).catch(() => null),
    ]).then(([info, cached]) => {
      // WhatsApps eigenes Modell entscheidet, nicht DOM-Raterei: nur
      // empfangene Sprachnachrichten.
      if (!info || !info.found || info.fromMe || info.type !== "ptt") {
        registry.delete(key);
        return;
      }
      entry.ready = true;
      mount(entry);
      if (cached && cached.ok && cached.data) {
        entry.data = cached.data;
        entry.state = "done";
      } else {
        entry.state = "idle";
      }
      render(entry);
    });
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(SELECTORS.voiceIcon).forEach((icon) => {
      const bubble = icon.closest(SELECTORS.message);
      if (bubble) consider(bubble);
    });
    if (root instanceof Element && root.matches && root.matches(SELECTORS.voiceIcon)) {
      const bubble = root.closest(SELECTORS.message);
      if (bubble) consider(bubble);
    }
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
    sweep();

    // Selbstdiagnose: beantwortet beim Debuggen sofort die Frage, ob der
    // Zugriff auf WhatsApps Modulsystem ueberhaupt noch traegt.
    if (cfg.debug) {
      bridge("selftest", {}, 15000)
        .then((r) => log("Selbsttest:", r))
        .catch((e) => console.warn("[WA-Transkript] Selbsttest fehlgeschlagen:", e.message));
    }
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
