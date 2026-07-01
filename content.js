// Content script.
//
// Primary path — timedtext interception:
//   inject.js patches window.fetch / XMLHttpRequest in the page's main world.
//   Whenever YouTube's own player fetches captions, we get the raw response
//   (JSON3 or SRV3), parse into cues, batch-translate the whole track upfront,
//   and render translated cues synchronously with video.currentTime.
//
// Fallback path — DOM observation:
//   If we never get an intercepted response (e.g., YouTube fetched captions
//   before our patch installed, or format changed), we observe rendered
//   caption text and translate on the fly with a small debounce.

(() => {
  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log("[YDS]", ...a); };

  const STATE = {
    videoId: null,
    settings: {
      enabled: true,
      secondLang: "zh-Hans",
      bottomOffset: 22,     // % from the bottom of the video
      fontSize: 22,
      color: "#ffffff",
      background: "rgba(0,0,0,0.6)"
    }
  };

  let overlayEl = null;
  let currentRenderedText = "";
  const translationCache = new Map();
  let cacheKeyLang = "";

  // Pre-translated cues (intercepted path).
  let preCues = [];             // [{start, end, text}] — translated
  let sourceCuesCache = null;   // raw source cues, kept for re-translation on lang change
  const seenTrackKeys = new Set(); // dedupe timedtext responses by cue-count+first-start

  // Fallback path state.
  let lastNativeText = "";
  let translateTimer = null;
  let pendingText = "";

  // ---------- inject page-world script ----------
  function injectPageScript() {
    if (document.getElementById("yds-inject")) return;
    const s = document.createElement("script");
    s.id = "yds-inject";
    s.src = chrome.runtime.getURL("inject.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  }

  // ---------- settings ----------
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        if (r && r.ydsSettings) Object.assign(STATE.settings, r.ydsSettings);
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.ydsSettings) return;
    const prev = { ...STATE.settings };
    Object.assign(STATE.settings, changes.ydsSettings.newValue || {});
    applyOverlayStyles();
    if (prev.secondLang !== STATE.settings.secondLang) {
      translationCache.clear();
      cacheKeyLang = STATE.settings.secondLang;
      preCues = [];
      currentRenderedText = "";
      lastNativeText = "";
      // Re-translate previously intercepted source cues with the new language.
      if (sourceCuesCache && STATE.settings.secondLang) {
        const tl = toGoogleLang(STATE.settings.secondLang);
        translateCuesProgressive(sourceCuesCache, tl, (partial) => { preCues = partial; });
      }
    }
    if (!STATE.settings.enabled) renderOverlay("");
  });

  // ---------- intercept handler ----------
  window.addEventListener("YDS_TIMEDTEXT", async (e) => {
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    const detail = e.detail || {};
    const url = detail.url || "";
    const text = detail.text || "";

    // Skip YouTube's own translated tracks; we want the source-language track
    // so we can control translation quality via Google Translate.
    if (/[?&]tlang=/.test(url)) {
      log("intercept: skipping tlang track");
      return;
    }

    // YouTube prefetches captions for autoplay/recommended/hover-preview videos.
    // Only accept the track whose v= matches the video the user is watching,
    // otherwise a later prefetch will overwrite preCues and blank the overlay.
    // Read location.search fresh — during SPA nav, STATE.videoId may lag the URL.
    const vMatch = /[?&]v=([^&]+)/.exec(url);
    const trackVideoId = vMatch ? vMatch[1] : null;
    const pageVideoIdMatch = /[?&]v=([^&]+)/.exec(location.search);
    const pageVideoId = pageVideoIdMatch ? pageVideoIdMatch[1] : null;
    if (trackVideoId && pageVideoId && trackVideoId !== pageVideoId) {
      log("intercept: skipping track for other video", trackVideoId, "current", pageVideoId);
      return;
    }

    const rawCues = parseCaptions(text);
    if (!rawCues.length) return;
    // Merge cues that YouTube split mid-sentence so Google Translate sees
    // the full clause and produces coherent output.
    const sourceCues = mergeSplitCues(rawCues);

    const key = `${sourceCues.length}|${sourceCues[0].start.toFixed(3)}|${sourceCues[sourceCues.length-1].end.toFixed(3)}`;
    if (seenTrackKeys.has(key)) return;
    seenTrackKeys.add(key);
    sourceCuesCache = sourceCues;
    log(`intercept: ${rawCues.length} raw → ${sourceCues.length} merged cues from`, url.slice(0, 90));

    const tl = toGoogleLang(STATE.settings.secondLang);
    // Translate in batches; publish partial results as they arrive so the
    // overlay can start showing translations before all batches finish.
    await translateCuesProgressive(sourceCues, tl, (translatedSoFar) => {
      preCues = translatedSoFar;
    });
    log(`intercept: pre-translated ${preCues.length} cues`);
  });

  // ---------- caption parsers ----------
  function parseCaptions(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return [];
    if (trimmed[0] === "{") {
      try { return parseJson3(JSON.parse(trimmed)); }
      catch { return []; }
    }
    if (trimmed[0] === "<") return parseSrv3(trimmed);
    return [];
  }

  function parseJson3(data) {
    const cues = [];
    const events = data?.events || [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const dur = (ev.dDurationMs || 0) / 1000;
      if (dur <= 0) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const text = ev.segs.map(s => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      cues.push({ start, end: start + dur, text });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function mergeSplitCues(cues) {
    // Only merge across CLEARLY mid-clause splits so the Chinese overlay
    // stays as short as the English YouTube displays at any given moment.
    const TERMINATOR = /[.!?…。！？,，;；:：]["'”’)\]]*\s*$/;
    const MAX_MERGED_DURATION = 4;   // seconds
    const MAX_MERGED_CHARS = 70;     // of the *source* text
    const MAX_GAP = 0.4;             // seconds between end of A and start of B
    const MAX_CUES = 2;              // never merge more than 2 cues
    const merged = [];
    let cur = null;
    let count = 1;
    for (const c of cues) {
      if (!cur) { cur = { ...c }; count = 1; continue; }
      const gap = c.start - cur.end;
      const wouldDuration = c.end - cur.start;
      const wouldLen = cur.text.length + 1 + c.text.length;
      const endsWithTerminator = TERMINATOR.test(cur.text);
      if (!endsWithTerminator &&
          count < MAX_CUES &&
          gap <= MAX_GAP &&
          wouldDuration <= MAX_MERGED_DURATION &&
          wouldLen <= MAX_MERGED_CHARS) {
        cur.text = `${cur.text} ${c.text}`.replace(/\s+/g, " ").trim();
        cur.end = c.end;
        count++;
      } else {
        merged.push(cur);
        cur = { ...c };
        count = 1;
      }
    }
    if (cur) merged.push(cur);
    return merged;
  }

  function stripUnwantedPunctuation(text) {
    if (!text) return text;
    // Strip all periods (Chinese 。 and English .) — keep ! ? ！ ？ , 、 …
    // Preserve decimals like "3.14" by only removing English periods that
    // are not sandwiched between two digits.
    return text
      .replace(/。/g, "")
      .replace(/(?<![0-9])\.|\.(?![0-9])/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function parseSrv3(xml) {
    const cues = [];
    try {
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const ps = doc.querySelectorAll("p");
      ps.forEach(p => {
        const t = parseInt(p.getAttribute("t") || "0", 10);
        const d = parseInt(p.getAttribute("d") || "0", 10);
        if (d <= 0) return;
        const text = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return;
        cues.push({ start: t / 1000, end: (t + d) / 1000, text });
      });
      cues.sort((a, b) => a.start - b.start);
    } catch {}
    return cues;
  }

  // ---------- Google Translate ----------
  function toGoogleLang(code) {
    const map = { "zh-hans": "zh-CN", "zh-hant": "zh-TW", "iw": "he", "jw": "jv" };
    const k = (code || "").toLowerCase();
    return map[k] || code;
  }

  async function translateText(text, tl) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", tl);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const out = (data[0] || []).map(seg => seg[0] || "").join("").trim();
    return out || text;
  }

  async function translateBatch(texts, tl) {
    const DELIM = "\n\n888777\n\n";
    const joined = texts.join(DELIM);
    try {
      const url = new URL("https://translate.googleapis.com/translate_a/single");
      url.searchParams.set("client", "gtx");
      url.searchParams.set("sl", "auto");
      url.searchParams.set("tl", tl);
      url.searchParams.set("dt", "t");
      url.searchParams.set("q", joined);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const combined = (data[0] || []).map(seg => seg[0] || "").join("");
      const parts = combined.split(/\n*\s*888777\s*\n*/);
      if (parts.length === texts.length) return parts.map(s => s.trim());
      log("batch delim mismatch, per-line fallback", parts.length, "vs", texts.length);
      return await Promise.all(texts.map(t => translateText(t, tl).catch(() => t)));
    } catch (e) {
      log("translateBatch error", e);
      return texts;
    }
  }

  async function translateCuesProgressive(cues, tl, onPartial) {
    const MAX_CHARS = 1200;
    const batches = [];
    let cur = [], curLen = 0;
    for (const c of cues) {
      const len = c.text.length + 4;
      if (curLen + len > MAX_CHARS && cur.length) {
        batches.push(cur);
        cur = []; curLen = 0;
      }
      cur.push(c);
      curLen += len;
    }
    if (cur.length) batches.push(cur);

    const result = new Array(cues.length);
    const indexOf = new Map(cues.map((c, i) => [c, i]));
    let done = 0;

    const CONCURRENCY = 4;
    let nextBatch = 0;
    async function worker() {
      while (true) {
        const b = nextBatch++;
        if (b >= batches.length) return;
        const batch = batches[b];
        const translated = await translateBatch(batch.map(c => c.text), tl);
        for (let i = 0; i < batch.length; i++) {
          const orig = batch[i];
          const t = stripUnwantedPunctuation(translated[i] || orig.text);
          result[indexOf.get(orig)] = { start: orig.start, end: orig.end, text: t };
        }
        done += batch.length;
        // Publish a sorted, defined-only partial snapshot.
        const partial = result.filter(Boolean).sort((a, b) => a.start - b.start);
        onPartial(partial);
        log(`translate progress: ${done}/${cues.length}`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  // ---------- render loop (uses preCues if available) ----------
  function findCuesAt(cues, t) {
    // Return all cues active at time t, joined by newline.
    const active = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.start && t < c.end) active.push(c.text);
      else if (c.start > t) break;
    }
    return active.join("\n");
  }

  function renderTick() {
    const video = document.querySelector("video.html5-main-video");
    if (video && STATE.settings.enabled && preCues.length) {
      const text = findCuesAt(preCues, video.currentTime);
      if (text !== currentRenderedText) {
        currentRenderedText = text;
        renderOverlay(text);
      }
    }
    requestAnimationFrame(renderTick);
  }

  // ---------- DOM observation fallback ----------
  let captionObserver = null;
  let attachTimer = null;

  function currentNativeText() {
    const selectors = [
      ".ytp-caption-segment",
      ".captions-text .caption-visual-line",
      ".ytp-caption-window-container .caption-window",
      ".ytp-caption-window-container"
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) {
        const text = Array.from(nodes)
          .map(n => n.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text;
      }
    }
    return "";
  }

  function attachCaptionObserver() {
    const target = document.querySelector("#movie_player") || document.body;
    if (!target) return;
    if (captionObserver) { try { captionObserver.disconnect(); } catch {} }
    captionObserver = new MutationObserver(() => pumpFromNative(false));
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    log("caption observer attached");
  }

  function scheduleAttach() {
    if (attachTimer) return;
    attachTimer = setInterval(() => {
      if (document.querySelector("#movie_player")) {
        clearInterval(attachTimer);
        attachTimer = null;
        attachCaptionObserver();
      }
    }, 500);
  }

  async function pumpFromNative(force) {
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    // If we're already rendering from pre-translated cues, skip the fallback.
    if (preCues.length) return;

    const text = currentNativeText();
    if (!force && text === lastNativeText) return;
    lastNativeText = text;

    if (!text) {
      currentRenderedText = "";
      renderOverlay("");
      return;
    }

    const lang = STATE.settings.secondLang;
    if (cacheKeyLang !== lang) {
      translationCache.clear();
      cacheKeyLang = lang;
    }

    if (translationCache.has(text)) {
      currentRenderedText = translationCache.get(text);
      renderOverlay(currentRenderedText);
      return;
    }

    pendingText = text;
    if (translateTimer) clearTimeout(translateTimer);
    translateTimer = setTimeout(async () => {
      translateTimer = null;
      const t = pendingText;
      if (!t || t !== lastNativeText || preCues.length) return;
      if (translationCache.has(t)) {
        currentRenderedText = translationCache.get(t);
        renderOverlay(currentRenderedText);
        return;
      }
      try {
        const raw = await translateText(t, toGoogleLang(lang));
        const translated = stripUnwantedPunctuation(raw);
        translationCache.set(t, translated);
        if (lastNativeText === t && !preCues.length) {
          currentRenderedText = translated;
          renderOverlay(translated);
        }
      } catch (e) { log("translate failed", e); }
    }, 250);
  }

  // ---------- overlay ----------
  function getVideoContainer() {
    return document.querySelector("#movie_player")
        || document.querySelector(".html5-video-container");
  }

  function ensureOverlay() {
    const container = getVideoContainer();
    if (!container) return null;
    if (overlayEl && overlayEl.isConnected && overlayEl.parentElement === container) return overlayEl;
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement("div");
    overlayEl.id = "yt-dual-sub-overlay";
    overlayEl.className = "yds-overlay";
    const textEl = document.createElement("div");
    textEl.className = "yds-text";
    overlayEl.appendChild(textEl);
    container.appendChild(overlayEl);
    attachDragUI(container);
    applyOverlayStyles();
    return overlayEl;
  }

  function attachDragUI(container) {
    // Handle: small draggable pill above the overlay.
    const handle = document.createElement("div");
    handle.className = "yds-drag-handle";
    handle.textContent = "↕";
    handle.title = "上下拖动调整字幕位置";
    overlayEl.appendChild(handle);

    let dragging = false;
    let startY = 0;
    let startOffset = 0;
    let containerH = 1;

    function nearOverlay(x, y) {
      if (!overlayEl.isConnected || overlayEl.style.display === "none") return false;
      const b = overlayEl.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return false;
      // Expand hit area vertically so the small handle is easy to reach.
      return x >= b.left - 30 && x <= b.right + 30 && y >= b.top - 34 && y <= b.bottom + 20;
    }

    // Attach the mousemove listener to the container only once per container.
    if (!container.__ydsDragMoveAttached) {
      container.__ydsDragMoveAttached = true;
      container.addEventListener("mousemove", (e) => {
        if (dragging) return;
        const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
        if (!h) return;
        h.classList.toggle("yds-drag-visible", nearOverlay(e.clientX, e.clientY));
      });
      container.addEventListener("mouseleave", () => {
        if (dragging) return;
        const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
        if (h) h.classList.remove("yds-drag-visible");
      });
    }

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startY = e.clientY;
      startOffset = Number(STATE.settings.bottomOffset) || 0;
      containerH = container.getBoundingClientRect().height || 1;
      overlayEl.classList.add("yds-dragging");
      handle.classList.add("yds-drag-visible");
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      // Mouse moves DOWN in screen → subtitle should move DOWN (bottom % decreases).
      const deltaPct = -((e.clientY - startY) / containerH) * 100;
      const next = Math.max(0, Math.min(95, startOffset + deltaPct));
      STATE.settings.bottomOffset = next;
      applyOverlayStyles();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      overlayEl.classList.remove("yds-dragging");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      // Persist the rounded value.
      const val = Math.round(Number(STATE.settings.bottomOffset) || 0);
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const merged = { ...(r && r.ydsSettings ? r.ydsSettings : {}), bottomOffset: val };
        chrome.storage.sync.set({ ydsSettings: merged });
      });
    }
  }

  function applyOverlayStyles() {
    if (!overlayEl) return;
    const s = STATE.settings;
    overlayEl.style.color = s.color;
    overlayEl.style.background = s.background;
    overlayEl.style.fontSize = `${s.fontSize}px`;
    const offset = Math.max(0, Math.min(95, Number(s.bottomOffset) || 0));
    overlayEl.style.bottom = `${offset}%`;
    overlayEl.style.top = "auto";
  }

  function renderOverlay(text) {
    const el = ensureOverlay();
    if (!el) return;
    const textEl = el.querySelector(".yds-text");
    if (!text || !STATE.settings.enabled) {
      el.style.display = "none";
      if (textEl) textEl.textContent = "";
      return;
    }
    el.style.display = "";
    if (textEl) textEl.textContent = text;
  }

  // ---------- SPA nav handling ----------
  function watchUrlChanges() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const m = /[?&]v=([^&]+)/.exec(location.search);
        const newVid = m ? m[1] : null;
        if (newVid !== STATE.videoId) {
          STATE.videoId = newVid;
          preCues = [];
          sourceCuesCache = null;
          seenTrackKeys.clear();
          translationCache.clear();
          lastNativeText = "";
          currentRenderedText = "";
          renderOverlay("");
        }
      }
    }).observe(document, { subtree: true, childList: true });
  }

  // ---------- messaging with popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "YDS_GET_INFO") {
      const m = /[?&]v=([^&]+)/.exec(location.search);
      sendResponse({
        videoId: m ? m[1] : null,
        tracks: [],
        translations: [],
        settings: STATE.settings,
        nativeCaptionText: currentNativeText(),
        preCuesLoaded: preCues.length
      });
      return true;
    }
  });

  // ---------- boot ----------
  (async function boot() {
    injectPageScript();      // Install fetch/XHR patches ASAP.
    await loadSettings();
    cacheKeyLang = STATE.settings.secondLang;
    const m = /[?&]v=([^&]+)/.exec(location.search);
    STATE.videoId = m ? m[1] : null;
    watchUrlChanges();
    scheduleAttach();
    requestAnimationFrame(renderTick);
    log("booted", { videoId: STATE.videoId, secondLang: STATE.settings.secondLang });
  })();
})();
