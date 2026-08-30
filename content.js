// Content script. Platform-independent half of the extension.
//
// Everything that knows about a specific site lives in platform.js, which
// loads first and hands us an adapter. The adapter finds the <video>, finds
// the overlay anchor, and pushes caption cues at us; from there the flow is
// the same on every platform.
//
// Primary path — whole-track preload:
//   The adapter delivers a full track's cues at once (YouTube by intercepting
//   the player's own /api/timedtext response, Vimeo by fetching the .vtt).
//   We merge cues that were split mid-clause, batch-translate the entire track
//   upfront, and render synchronously against video.currentTime — no lag.
//
// Fallback path — DOM observation:
//   If cues never arrive (format change, expired URL, captions rendered from a
//   source we can't read), we watch the rendered caption text and translate on
//   the fly with a small debounce.

(() => {
  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log("[YDS]", ...a); };

  let P = null;   // platform adapter, created in boot()

  const STATE = {
    platform: null,
    videoId: null,
    settings: {
      enabled: true,
      secondLang: ydsDefaultSecondLang(),
      bottomOffset: 22,     // % from the bottom of the video
      fontSize: 22,
      color: "#ffffff",
      background: "rgba(0,0,0,0.6)",
      // Translation provider: "google" | "claude" | "openai" | "gemini" | "deepseek".
      // Google is free/anonymous; the others need the user's own API key.
      translationProvider: "google",
      uiLang: "auto",          // panel language: "auto" | "zh" | "en"
      // Off by default the overlay rides along with the player's own caption
      // strip: no native captions, no second language. Turning this on detaches
      // it, so the translation shows on its own with the player's CC closed.
      // Share of the player the overlay may use, as a percentage. Only applies
      // when there is no native caption line to match — see matchNativeCaptionWidth.
      captionWidth: 60,
      translationOnly: false,
      paidApiAskEachVideo: false,
      apiKeys: {}           // { claude?: string, openai?: string, gemini?: string, deepseek?: string }
    }
  };

  let overlayEl = null;
  let currentRenderedText = "";
  const translationCache = new Map();
  let cacheKeyLang = "";

  // Cues we render from. Two independent sources with priority:
  //   preCuesNative — pulled from a native second-language track (highest quality)
  //   preCuesTranslated — Google-translated from the source track (fallback)
  // Render always prefers native if it has any cues.
  let preCuesNative = [];
  let preCuesTranslated = [];
  let sourceCuesCache = null;   // raw source cues, kept for re-translation on lang change
  const seenTrackKeys = new Set(); // dedupe timedtext responses by cue-count+first-start
  let translationStatus = {
    mode: "idle",
    provider: "",
    requestedProvider: "",
    cueCount: 0,
    totalCount: 0,
    translatedCount: 0,
    error: "",
    updatedAt: Date.now()
  };

  function setTranslationStatus(next) {
    translationStatus = { ...translationStatus, ...next, updatedAt: Date.now() };
    log("translation status:", translationStatus);
  }
  const paidApiDecisions = new Map(); // key -> "approved" | "declined"
  let paidApiPromptEl = null;

  // Caption tracks the platform says exist on this video.
  let availableTracks = [];       // [{languageCode, kind, name}]
  let trackRequested = false; // don't ask the player for a track more than once per video
  let sourceRequestAttempts = 0; // translation-only asks are retried once, then we stop
  // Which track the text we are translating came from, so a machine transcript
  // can be upgraded to a human one but never the other way round.
  let sourceLang = "";
  let sourceIsAsr = false;
  let betterSourceRequested = false;

  // Aborts any in-flight LLM/Google Translate calls when we get a better
  // source of cues (native track), a video change, or a settings change.
  // Prevents burning API tokens on translations we're about to discard.
  let translateAbortController = null;
  let translateGeneration = 0;
  function abortInflightTranslation(reason) {
    translateGeneration++;
    if (translateAbortController) {
      log(`abort in-flight translation: ${reason}`);
      translateAbortController.abort();
      translateAbortController = null;
    }
  }

  // Fallback path state.
  let lastNativeText = "";
  let translateTimer = null;
  let pendingText = "";

  // Adapters start before settings finish loading — on YouTube the fetch patch
  // has to be in place at document_start or we miss the caption request. Park
  // anything that arrives in that window and replay it once we know the user's
  // target language, so we never translate into the default one by accident.
  let settingsLoaded = false;
  const pendingTrackLists = [];
  const pendingIngests = [];

  function drainPending() {
    settingsLoaded = true;
    const lists = pendingTrackLists.splice(0);
    const ingests = pendingIngests.splice(0);
    for (const list of lists) handleTrackList(list);
    for (const payload of ingests) ingestCues(payload);
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
    if (typeof ydsSetUiLang === "function") ydsSetUiLang(STATE.settings.uiLang);
    applyOverlayStyles();
    // Width is decided at render time, so nudge the current line to re-measure.
    if (prev.captionWidth !== STATE.settings.captionWidth && currentRenderedText) {
      renderOverlay(currentRenderedText);
    }

    const langChanged = prev.secondLang !== STATE.settings.secondLang;
    const providerChanged = prev.translationProvider !== STATE.settings.translationProvider;
    const translationOnlyChanged = prev.translationOnly !== STATE.settings.translationOnly;
    const keysChanged = JSON.stringify(prev.apiKeys || {}) !== JSON.stringify(STATE.settings.apiKeys || {});

    if (langChanged) {
      abortInflightTranslation("target language changed");
      closePaidApiPrompt();
      setTranslationStatus({
        mode: "idle",
        provider: "",
        requestedProvider: "",
        cueCount: 0,
        error: ""
      });
      // Full reset — new target language means different native track possible.
      translationCache.clear();
      cacheKeyLang = STATE.settings.secondLang;
      preCuesNative = [];
      preCuesTranslated = [];
      trackRequested = false;
      currentRenderedText = "";
      lastNativeText = "";
      // The new target language may be a track we already pulled and filed as
      // source text, so let the adapter fetch it again.
      if (P && P.forgetLoadedCues) P.forgetLoadedCues();
      maybeRequestTrack();
    }

    // Any change to translation config: retranslate from cached source if we
    // aren't already showing a higher-priority native track.
    if ((langChanged || providerChanged || keysChanged)
        && sourceCuesCache
        && STATE.settings.secondLang
        && !preCuesNative.length) {
      preCuesTranslated = [];
      const tl = toGoogleLang(STATE.settings.secondLang);
      startCuesTranslation(sourceCuesCache, tl, chooseSourceTranslationProvider(), "settings changed");
      maybeAskForPaidApi(sourceCuesCache, tl, "settings changed");
    }

    // Switching translation-only on with the player's captions closed means we
    // now need a track the player was never going to fetch — ask for it.
    if (translationOnlyChanged && STATE.settings.translationOnly && !sourceCuesCache && !preCuesNative.length) {
      trackRequested = false;
      maybeRequestTrack();
    }

    if (!STATE.settings.enabled) renderOverlay("");
  });

  // ---------- track list handler ----------
  function handleTrackList(tracks) {
    if (!settingsLoaded) { pendingTrackLists.push(tracks || []); return; }
    availableTracks = tracks || [];
    log("track list:", availableTracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
    maybeRequestTrack();

    const provider = chooseSourceTranslationProvider();
    if (provider !== "google" && sourceCuesCache && !preCuesNative.length) {
      preCuesTranslated = [];
      startCuesTranslation(sourceCuesCache, toGoogleLang(STATE.settings.secondLang), provider, "native unavailable after track list");
    } else if (sourceCuesCache && !preCuesNative.length) {
      maybeAskForPaidApi(sourceCuesCache, toGoogleLang(STATE.settings.secondLang), "native unavailable after track list");
    }
  }

  function isCcOn() {
    // Returns true / false / null (player not ready yet).
    return P ? P.isCcOn() : null;
  }

  // Best track to translate FROM when the player would never fetch one on its
  // own — translation-only mode, where there is no viewer choice to respect.
  //
  // Order: human-authored in the original language, then any human-authored,
  // then machine transcription. Human text beats a machine transcript even at
  // the cost of relaying through a third language, but among human tracks the
  // original language wins because it costs nothing.
  //
  // The machine track is what tells us the original language: players only
  // auto-generate captions for the language actually being spoken, so its
  // language code is the audio's, even when we go on to translate from
  // something else.
  function pickSourceTrack() {
    const human = availableTracks.filter(t => t.kind !== "asr");
    const machine = availableTracks.find(t => t.kind === "asr") || null;
    const originalLang = machine ? machine.languageCode : "";

    if (originalLang) {
      const humanOriginal = human.find(t => langMatches(originalLang, t.languageCode));
      if (humanOriginal) return humanOriginal;
    }
    return human[0] || machine || availableTracks[0] || null;
  }

  function maybeRequestTrack() {
    if (trackRequested) return;
    if (!P) return;
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    if (!availableTracks.length) return;

    const cc = isCcOn();
    const target = getNativeTargetTrack();

    if (target) {
      // On YouTube, pulling another language means asking the player to swap
      // tracks, which flashes captions on and off if CC is currently closed —
      // so wait until the user turns CC on themselves and retry then. Vimeo
      // hands us a URL per track, so there is nothing to wait for. In
      // translation-only mode we go ahead regardless: the swap is hidden, and
      // the player's captions are put back the way we found them.
      if (P.requiresCcForTracks && cc !== true && !STATE.settings.translationOnly) {
        log(`CC is ${cc === false ? "off" : "unknown"}, deferring track request`);
        return;
      }
      trackRequested = true;
      log(`requesting native target track: ${target.languageCode} (${target.name})`);
      P.requestTrack(target);
      return;
    }

    log(`no native track for ${STATE.settings.secondLang}, will translate`);

    // Nothing in the target language, so we have to translate something. With
    // the player's captions closed it never fetches a track by itself, so in
    // translation-only mode ask for one outright — otherwise there is nothing
    // on screen at all.
    if (STATE.settings.translationOnly && P.requiresCcForTracks && cc !== true && !sourceCuesCache) {
      const source = pickSourceTrack();
      if (source) {
        trackRequested = true;
        sourceRequestAttempts++;
        log(`translation-only: requesting source track ${source.languageCode} with CC closed (attempt ${sourceRequestAttempts})`);
        P.requestTrack(source);
        // The player can be too early in its own startup to answer. Give it one
        // more go before we leave the viewer staring at nothing.
        if (sourceRequestAttempts < 2) {
          setTimeout(() => {
            if (!sourceCuesCache && !preCuesNative.length && STATE.settings.translationOnly) {
              trackRequested = false;
              maybeRequestTrack();
            }
          }, 5000);
        }
      }
    }
  }

  function langMatches(target, candidate) {
    if (!target || !candidate) return false;
    const t = String(target).toLowerCase();
    const c = String(candidate).toLowerCase();
    if (t === c) return true;
    // Chinese script variants: don't cross-match Simplified vs Traditional.
    const simplified = new Set(["zh", "zh-hans", "zh-cn", "zh-sg"]);
    const traditional = new Set(["zh-hant", "zh-tw", "zh-hk", "zh-mo"]);
    if (t.startsWith("zh") || c.startsWith("zh")) {
      if (simplified.has(t) && simplified.has(c)) return true;
      if (traditional.has(t) && traditional.has(c)) return true;
      return false;
    }
    // Other languages: coarse match on base language code.
    return t.split("-")[0] === c.split("-")[0];
  }

  function getNativeTargetTrack() {
    if (!STATE.settings.secondLang) return null;
    return availableTracks.find(t => t.kind !== "asr" && langMatches(STATE.settings.secondLang, t.languageCode)) || null;
  }

  function selectedTranslationProvider() {
    return STATE.settings.translationProvider || "google";
  }

  function providerDisplayName(provider) {
    const names = {
      claude: "Claude",
      openai: "OpenAI",
      gemini: "Gemini",
      deepseek: "DeepSeek"
    };
    return names[provider] || provider || "API";
  }

  function paidDecisionKey(provider) {
    return [STATE.videoId || "", STATE.settings.secondLang || "", provider || ""].join("|");
  }

  function isPaidProvider(provider) {
    return provider && provider !== "google";
  }

  function chooseSourceTranslationProvider() {
    const provider = selectedTranslationProvider();
    if (provider === "google") return "google";

    // Paid providers are only allowed after the platform's track list proves
    // that no native target-language track exists. Until then, use free Google as
    // a disposable warm cache while the native-track request races.
    if (!availableTracks.length || getNativeTargetTrack()) return "google";
    return paidApiDecisions.get(paidDecisionKey(provider)) === "approved" ? provider : "google";
  }

  function maybeAskForPaidApi(cues, tl, reason) {
    const provider = selectedTranslationProvider();
    if (!isPaidProvider(provider)) return;
    if (!availableTracks.length || getNativeTargetTrack() || preCuesNative.length) return;

    const key = paidDecisionKey(provider);
    const decision = paidApiDecisions.get(key);
    if (decision === "approved") {
      if (translationStatus.provider !== provider || translationStatus.mode !== "translating") {
        startCuesTranslation(cues, tl, provider, `${reason} (user approved paid API)`);
      }
      return;
    }
    if (decision === "declined" || paidApiPromptEl) return;

    const apiKey = (STATE.settings.apiKeys || {})[provider];
    if (!apiKey) {
      setTranslationStatus({
        mode: "need_api_key",
        provider: "google",
        requestedProvider: provider,
        cueCount: preCuesTranslated.length,
        totalCount: cues.length,
        translatedCount: preCuesTranslated.length,
        error: `${providerDisplayName(provider)} API key not set`
      });
      return;
    }

    setTranslationStatus({
      mode: "awaiting_paid_confirmation",
      provider: "google",
      requestedProvider: provider,
      cueCount: preCuesTranslated.length,
      totalCount: cues.length,
      translatedCount: preCuesTranslated.length,
      error: ""
    });
    if (!STATE.settings.paidApiAskEachVideo) return;
    showPaidApiPrompt(provider, () => {
      closePaidApiPrompt();
      approvePaidApiForCurrentVideo(reason);
    }, () => {
      paidApiDecisions.set(key, "declined");
      closePaidApiPrompt();
      setTranslationStatus({
        mode: "fallback",
        provider: "google",
        requestedProvider: provider,
        cueCount: preCuesTranslated.length,
        totalCount: cues.length,
        translatedCount: preCuesTranslated.length,
        declined: true,
        error: ydsT("paidDeclined")
      });
    });
  }

  function closePaidApiPrompt() {
    if (paidApiPromptEl) paidApiPromptEl.remove();
    paidApiPromptEl = null;
  }

  function showPaidApiPrompt(provider, onApprove, onDecline) {
    closePaidApiPrompt();
    const name = providerDisplayName(provider);
    const root = document.createElement("div");
    root.className = "yds-paid-api-confirm";
    root.innerHTML = `
      <div class="yds-paid-api-card">
        <div class="yds-paid-api-title">${ydsT("paidPromptTitle", { name })}</div>
        <div class="yds-paid-api-body">${ydsT("paidPromptBody", { name })}</div>
        <div class="yds-paid-api-actions">
          <button type="button" class="yds-paid-api-free">${ydsT("paidPromptFree")}</button>
          <button type="button" class="yds-paid-api-use">${ydsT("paidPromptUse", { name })}</button>
        </div>
      </div>`;
    root.querySelector(".yds-paid-api-use").addEventListener("click", onApprove);
    root.querySelector(".yds-paid-api-free").addEventListener("click", onDecline);
    document.documentElement.appendChild(root);
    paidApiPromptEl = root;
  }

  function approvePaidApiForCurrentVideo(reason = "popup approval") {
    const provider = selectedTranslationProvider();
    if (!isPaidProvider(provider)) return { ok: false, error: ydsT("notPaidProvider") };
    if (!sourceCuesCache || preCuesNative.length) return { ok: false, error: ydsT("noSourceCues") };
    const apiKey = (STATE.settings.apiKeys || {})[provider];
    if (!apiKey) return { ok: false, error: `${providerDisplayName(provider)} API key not set` };

    const key = paidDecisionKey(provider);
    paidApiDecisions.set(key, "approved");
    closePaidApiPrompt();
    preCuesTranslated = [];
    startCuesTranslation(sourceCuesCache, toGoogleLang(STATE.settings.secondLang), provider, `${reason} (user approved paid API)`);
    return { ok: true, provider };
  }

  // ---------- cue ingestion ----------
  //
  // Every platform funnels into here: one track's worth of cues, plus what
  // language they are and whether they are already the language the user asked
  // for. Called by the adapter via ctx.ingest.
  function ingestCues(payload) {
    if (!settingsLoaded) { pendingIngests.push(payload); return; }
    const { cues: rawCues, lang: trackLang = "", isAsr = false, key = "" } = payload || {};
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    if (!rawCues || !rawCues.length) return;

    // The adapter passes a hint, but recompute against the settings we have
    // now — the payload may have been parked before those settings loaded.
    const isNativeTarget = trackLang
      ? (!isAsr && langMatches(STATE.settings.secondLang, trackLang))
      : !!payload.isNativeTarget;

    // Dedupe: the same track can arrive more than once (YouTube re-fetches it
    // after a track swap; Vimeo re-publishes its config on a fresh signature).
    // One exception — a track we already saw as *source* text becomes worth
    // re-reading once the user switches their target language to it.
    const dedupeKey = key
      || `${trackLang}|${isAsr ? "asr" : "sub"}|${rawCues.length}|${rawCues[0].start.toFixed(3)}|${rawCues[rawCues.length - 1].end.toFixed(3)}`;
    const nowWantedAsNative = isNativeTarget && !preCuesNative.length;
    if (seenTrackKeys.has(dedupeKey) && !nowWantedAsNative) return;
    seenTrackKeys.add(dedupeKey);

    if (isNativeTarget) {
      // Native second-language track — use directly, no merge / no translate.
      abortInflightTranslation(`native ${trackLang} loaded`);
      preCuesNative = rawCues.map(c => ({ start: c.start, end: c.end, text: stripUnwantedPunctuation(c.text) }));
      preCuesTranslated = [];
      setTranslationStatus({
        mode: "native",
        provider: "native",
        requestedProvider: "",
        cueCount: preCuesNative.length,
        totalCount: preCuesNative.length,
        translatedCount: preCuesNative.length,
        error: ""
      });
      log(`ingest: NATIVE ${trackLang} track, ${preCuesNative.length} cues (no translation needed)`);
      return;
    }

    // Don't fall back down. Once we're translating a human-authored track, a
    // machine transcript of the same language arriving later (the player
    // re-fetching what the viewer actually has selected, say) must not replace
    // it — that would silently undo the upgrade below.
    if (sourceCuesCache && !sourceIsAsr && isAsr && langMatches(sourceLang || trackLang, trackLang)) {
      log(`ingest: keeping the human-authored ${sourceLang} source, ignoring the machine one`);
      return;
    }

    // Source-language track → merge broken cues, translate to target lang.
    const sourceCues = mergeSplitCues(rawCues);
    sourceCuesCache = sourceCues;
    sourceLang = trackLang;
    sourceIsAsr = isAsr;
    log(`ingest: ${rawCues.length} raw → ${sourceCues.length} merged source cues (${trackLang || "?"}${isAsr ? ", asr" : ""})`);

    // The player handed us machine transcription, but the video also carries a
    // human-authored track in the same language — ask for that instead. Same
    // words on screen either way, better text to translate from. Staying inside
    // one language is the point: swapping to a different language would leave
    // the caption strip and the translation talking about different things.
    if (isAsr && !betterSourceRequested && P && trackLang) {
      const better = availableTracks.find(t => t.kind !== "asr" && langMatches(trackLang, t.languageCode));
      if (better) {
        betterSourceRequested = true;
        log(`ingest: upgrading source from ${trackLang}(asr) to the human ${better.languageCode} track`);
        P.requestTrack(better);
        // Carry on translating the machine text meanwhile, so the viewer isn't
        // left with a blank overlay while the better track is on its way.
      }
    }

    // If a native target track has already been loaded, skip translating — the
    // native one is higher quality. We still cache source in case the user
    // later switches to a language with no native track available.
    if (preCuesNative.length) {
      log("ingest: already have native cues, skipping translation");
      return;
    }

    const tl = toGoogleLang(STATE.settings.secondLang);
    // Kick off translation, but also retry the native-track request: on YouTube,
    // cues arriving means CC just turned on, so a request we deferred earlier
    // can go through now.
    maybeRequestTrack();
    startCuesTranslation(sourceCues, tl, chooseSourceTranslationProvider(), "source captions loaded");
    maybeAskForPaidApi(sourceCues, tl, "source captions loaded");
  }

  // ---------- cue post-processing ----------
  function coalesceIdenticalCues(cues) {
    // Players emit the same caption text as multiple overlapping events
    // (continuation / shadow cues). Merge back-to-back cues with
    // identical text into a single longer cue so we don't render the same
    // line twice at overlapping timestamps.
    if (cues.length < 2) return cues;
    const out = [{ ...cues[0] }];
    for (let i = 1; i < cues.length; i++) {
      const prev = out[out.length - 1];
      const c = cues[i];
      if (prev.text === c.text && c.start <= prev.end + 0.1) {
        prev.end = Math.max(prev.end, c.end);
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  function mergeSplitCues(cues) {
    // Only merge across CLEARLY mid-clause splits so the Chinese overlay
    // stays as short as the source line the player shows at any given moment.
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

  // ---------- Translation providers ----------
  //
  // Public entry points: translateText / translateBatch — they dispatch to
  // the chosen provider (Google / Claude / OpenAI / Gemini) and fall back to
  // Google if the LLM call fails.

  function toGoogleLang(code) {
    // Google Translate uses zh-CN / zh-TW etc., the players use zh-Hans / zh-Hant.
    const map = { "zh-hans": "zh-CN", "zh-hant": "zh-TW", "iw": "he", "jw": "jv" };
    const k = (code || "").toLowerCase();
    return map[k] || code;
  }

  // Human-readable names for prompt-driven LLM providers. Falls back to the
  // BCP-47 code so obscure languages still work (just less prettily).
  const LANG_NAMES = {
    "zh-cn": "Simplified Chinese", "zh-hans": "Simplified Chinese",
    "zh-tw": "Traditional Chinese", "zh-hant": "Traditional Chinese",
    "en": "English", "ja": "Japanese", "ko": "Korean",
    "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
    "pt": "Portuguese", "ru": "Russian", "ar": "Arabic", "hi": "Hindi",
    "th": "Thai", "vi": "Vietnamese", "id": "Indonesian", "ms": "Malay",
    "tr": "Turkish", "nl": "Dutch", "pl": "Polish", "sv": "Swedish",
    "no": "Norwegian", "da": "Danish", "fi": "Finnish", "cs": "Czech",
    "el": "Greek", "he": "Hebrew", "uk": "Ukrainian", "ro": "Romanian",
    "hu": "Hungarian", "bg": "Bulgarian", "fa": "Persian", "ur": "Urdu",
    "bn": "Bengali", "ta": "Tamil", "te": "Telugu"
  };
  function langNameForPrompt(code) {
    const k = (code || "").toLowerCase();
    return LANG_NAMES[k] || code;
  }

  function buildLLMPrompt(texts, tl) {
    const name = langNameForPrompt(tl);
    const taggedCaptions = texts.map((text, i) => `[${i + 1}] ${text}`).join("\n");
    return `Translate each of these ${texts.length} YouTube captions to ${name}. Keep one output item for every input item.

Rules:
- Keep translations concise (subtitle-length, not formal writing)
- Preserve tone: questions, exclamations, humor, sarcasm
- Use natural spoken language
- Do NOT add trailing periods (。 or .); keep ! ? , ，
- Do NOT merge, split, omit, or reorder any caption
- Output ONLY ${texts.length} numbered lines in this exact format: [1] translation

Captions:
${taggedCaptions}

Translations:`;
  }

  function parseLLMOutput(text, expectedCount) {
    let lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    const tagged = new Map();
    for (const line of lines) {
      const m = /^\[?(\d+)\]?\s*[.)：:\-]?\s*(.+)$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]);
      if (idx >= 1 && idx <= expectedCount && m[2].trim()) {
        tagged.set(idx, m[2].trim());
      }
    }
    if (tagged.size === expectedCount) {
      return Array.from({ length: expectedCount }, (_, i) => tagged.get(i + 1));
    }

    if (lines.length === expectedCount) return lines;
    // Sometimes LLMs prefix "1. " / "1)" / "1:" despite instructions.
    const stripped = lines
      .map(l => l.replace(/^[\d]+[.\):\-]\s*/, "").trim())
      .filter(l => l.length > 0);
    if (stripped.length === expectedCount) return stripped;
    throw new Error(`LLM returned ${lines.length} lines, expected ${expectedCount}`);
  }

  // ----- Google Translate (free, anonymous) -----
  async function translateTextGoogle(text, tl, signal) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", tl);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const out = (data[0] || []).map(seg => seg[0] || "").join("").trim();
    return out || text;
  }

  async function translateBatchGoogle(texts, tl, signal) {
    const DELIM = "\n\n888777\n\n";
    const joined = texts.join(DELIM);
    try {
      const url = new URL("https://translate.googleapis.com/translate_a/single");
      url.searchParams.set("client", "gtx");
      url.searchParams.set("sl", "auto");
      url.searchParams.set("tl", tl);
      url.searchParams.set("dt", "t");
      url.searchParams.set("q", joined);
      const res = await fetch(url.toString(), { signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const combined = (data[0] || []).map(seg => seg[0] || "").join("");
      const parts = combined.split(/\n*\s*888777\s*\n*/);
      if (parts.length === texts.length) return parts.map(s => s.trim());
      log("google batch delim mismatch, per-line fallback", parts.length, "vs", texts.length);
      return await Promise.all(texts.map(t => translateTextGoogle(t, tl, signal).catch(() => t)));
    } catch (e) {
      if (signal?.aborted) throw e;
      log("translateBatchGoogle error", e);
      return texts;
    }
  }

  // ----- Claude (Anthropic) -----
  async function translateBatchClaude(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }]
      }),
      signal
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return parseLLMOutput(content, texts.length);
  }

  // ----- OpenAI -----
  async function translateBatchOpenAI(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1
      }),
      signal
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- Google Gemini -----
  async function translateBatchGemini(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      }),
      signal
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- DeepSeek -----
  async function translateBatchDeepSeek(texts, tl, apiKey, signal) {
    const prompt = buildLLMPrompt(texts, tl);
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1
      }),
      signal
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return parseLLMOutput(content, texts.length);
  }

  // ----- Dispatch layer -----
  async function translateBatch(texts, tl, options = {}) {
    const provider = options.provider || STATE.settings.translationProvider || "google";
    const signal = options.signal;
    const key = (STATE.settings.apiKeys || {})[provider];
    try {
      if (provider === "claude") {
        if (!key) throw new Error("Claude API key not set");
        const out = await translateBatchClaude(texts, tl, key, signal);
        options.markProviderUsed?.("claude", provider, "");
        return out;
      }
      if (provider === "openai") {
        if (!key) throw new Error("OpenAI API key not set");
        const out = await translateBatchOpenAI(texts, tl, key, signal);
        options.markProviderUsed?.("openai", provider, "");
        return out;
      }
      if (provider === "gemini") {
        if (!key) throw new Error("Gemini API key not set");
        const out = await translateBatchGemini(texts, tl, key, signal);
        options.markProviderUsed?.("gemini", provider, "");
        return out;
      }
      if (provider === "deepseek") {
        if (!key) throw new Error("DeepSeek API key not set");
        const out = await translateBatchDeepSeek(texts, tl, key, signal);
        options.markProviderUsed?.("deepseek", provider, "");
        return out;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      options.markProviderUsed?.("google", provider, e.message || String(e));
      log(`translateBatch (${provider}) failed, falling back to Google:`, e.message);
    }
    const out = await translateBatchGoogle(texts, tl, signal);
    options.markProviderUsed?.("google", provider === "google" ? "google" : provider, "");
    return out;
  }

  async function translateText(text, tl) {
    // For single-string calls (fallback DOM-observation path) just wrap batch.
    // Simpler than maintaining a separate single-string prompt per provider.
    const [out] = await translateBatch([text], tl);
    return out || text;
  }

  async function translateCuesProgressive(cues, tl, onPartial, options = {}) {
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
        if (options.signal?.aborted || preCuesNative.length) return;
        const translated = await translateBatch(batch.map(c => c.text), tl, options);
        if (options.signal?.aborted || preCuesNative.length) return;
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

  async function startCuesTranslation(cues, tl, provider, reason) {
    abortInflightTranslation(`start ${reason}`);
    const controller = new AbortController();
    translateAbortController = controller;
    const generation = translateGeneration;
    let providerUsed = "";
    let fallbackError = "";
    setTranslationStatus({
      mode: "translating",
      provider,
      requestedProvider: provider,
      cueCount: cues.length,
      totalCount: cues.length,
      translatedCount: 0,
      error: ""
    });
    log(`translation start (${provider}): ${reason}`);
    try {
      await translateCuesProgressive(cues, tl, (translatedSoFar) => {
        if (generation !== translateGeneration || controller.signal.aborted || preCuesNative.length) return;
        preCuesTranslated = translatedSoFar;
        setTranslationStatus({
          mode: "translating",
          provider: providerUsed || provider,
          requestedProvider: provider,
          cueCount: cues.length,
          totalCount: cues.length,
          translatedCount: translatedSoFar.length,
          error: fallbackError
        });
      }, {
        provider,
        signal: controller.signal,
        markProviderUsed: (used, requested, error) => {
          providerUsed = used || providerUsed;
          fallbackError = error || fallbackError;
          if (generation === translateGeneration && !controller.signal.aborted && !preCuesNative.length) {
            setTranslationStatus({
              mode: used === requested ? "translating" : "fallback",
              provider: used,
              requestedProvider: requested,
              cueCount: cues.length,
              totalCount: cues.length,
              translatedCount: preCuesTranslated.length,
              error: fallbackError
            });
          }
        }
      });
      if (generation === translateGeneration && !controller.signal.aborted && !preCuesNative.length) {
        setTranslationStatus({
          mode: providerUsed && providerUsed !== provider ? "fallback" : "translated",
          provider: providerUsed || provider,
          requestedProvider: provider,
          cueCount: preCuesTranslated.length,
          totalCount: cues.length,
          translatedCount: preCuesTranslated.length,
          error: fallbackError
        });
        log(`intercept: pre-translated ${preCuesTranslated.length} cues via ${providerUsed || provider}`);
      } else {
        log(`translation discarded (${provider}): ${reason}`);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setTranslationStatus({
          mode: "error",
          provider,
          requestedProvider: provider,
          cueCount: preCuesTranslated.length,
          totalCount: cues.length,
          translatedCount: preCuesTranslated.length,
          error: e?.message || String(e)
        });
        log(`translation failed (${provider})`, e);
      }
    } finally {
      if (translateAbortController === controller) translateAbortController = null;
    }
  }


  // ---------- live transcription ----------
  //
  // A caption source with no timeline. Text arrives as "the sentence being
  // spoken right now", refreshed several times a second, then finalised. We
  // keep the last finished sentence plus the one in progress, and translate
  // both — the finished one once, the in-progress one on a throttle so a
  // sentence being revised mid-flight doesn't fire a request per keystroke.
  //
  // Translation here always goes through Google, never a paid provider, even
  // when one is configured. A partial retranslates roughly once a second for as
  // long as someone is talking; billing that to an LLM API would be a nasty
  // surprise on an hour-long video. Track translation, which runs once over a
  // fixed set of lines, is where the paid providers earn their keep.
  const LIVE_DISPLAY_CHARS = 90;    // trim the visible line; CSS clips the rest
  const LIVE_HIDE_MS = 4000;        // fade out after this much silence
  const LIVE_PAUSE_HOLD_MS = 8000;  // …but hold it longer once the video is paused
  const LIVE_PARTIAL_MS = 900;      // retranslate the sentence in progress this often

  const live = {
    active: false,
    status: "stopped",
    detail: "",
    textBuf: "",         // last finished sentence, with a trailing space
    partial: "",         // sentence in progress
    transBuf: "",        // its translation
    transPartial: "",
    hideTimer: null,
    partialTimer: null,
    partialLastAt: 0,
    pendingPartial: "",
    partialToken: 0,
    finalChain: Promise.resolve(),   // keeps finals in order
    gen: 0,              // bumped on stop / seek / video change to void in-flight work
    cache: new Map()
  };

  // Keep the tail, but don't start mid-word: if there's a space near the cut,
  // start after it instead.
  function tailTrim(text, max) {
    if (text.length <= max) return text;
    const tail = text.slice(-max);
    const sp = tail.search(/\s/);
    return sp >= 0 && sp < 24 ? tail.slice(sp + 1) : tail;
  }

  let liveSourceShown = false;

  function liveRender() {
    if (!live.active) return;
    const heard = (live.textBuf + live.partial).trim();
    const translated = (live.transBuf + live.transPartial).trim();
    liveSourceShown = !!heard;
    renderSourceLine(heard ? tailTrim(heard, LIVE_DISPLAY_CHARS) : "");
    renderOverlay(translated ? tailTrim(translated, LIVE_DISPLAY_CHARS) : "");
    if (heard || translated) {
      if (overlayEl) overlayEl.classList.add("yds-live-visible");
      clearTimeout(live.hideTimer);
      live.hideTimer = setTimeout(() => {
        if (overlayEl) overlayEl.classList.remove("yds-live-visible");
      }, LIVE_HIDE_MS);
    }
  }

  async function liveTranslate(text) {
    const key = `${STATE.settings.secondLang}\n${text}`;
    if (live.cache.has(key)) return live.cache.get(key);
    const out = await translateTextGoogle(text, toGoogleLang(STATE.settings.secondLang));
    const clean = stripUnwantedPunctuation(out || "");
    if (live.cache.size > 500) live.cache.clear();
    live.cache.set(key, clean);
    return clean;
  }

  // Finals go through a promise chain so two of them can't land out of order.
  function queueFinalTranslation(text) {
    if (!STATE.settings.secondLang) return;
    live.transPartial = "";
    live.pendingPartial = "";
    live.partialToken++;                 // void any partial translation in flight
    clearTimeout(live.partialTimer);
    live.partialTimer = null;
    const gen = live.gen;
    live.finalChain = live.finalChain.then(async () => {
      try {
        const out = await liveTranslate(text);
        if (gen !== live.gen) return;
        live.transBuf = out + " ";
        liveRender();
      } catch {}
    });
  }

  // Throttle, NOT debounce. While someone is speaking the recogniser refreshes
  // the sentence several times a second; a debounce timer would keep being
  // pushed back and the translation would not appear until they paused. The
  // first partial opens a window; later ones only update what gets sent when
  // that window closes.
  function queuePartialTranslation(text) {
    if (!STATE.settings.secondLang) return;
    live.pendingPartial = text;
    if (live.partialTimer) return;       // a window is already queued
    const wait = Math.max(0, LIVE_PARTIAL_MS - (Date.now() - live.partialLastAt));
    live.partialTimer = setTimeout(async () => {
      live.partialTimer = null;
      live.partialLastAt = Date.now();
      const current = live.pendingPartial;
      if (!current) return;              // the sentence finalised meanwhile
      const token = ++live.partialToken;
      const gen = live.gen;
      try {
        const out = await liveTranslate(current);
        if (token !== live.partialToken || gen !== live.gen) return;
        live.transPartial = out;
        liveRender();
      } catch {}
    }, wait);
  }

  function liveOnText(text, isFinal) {
    if (!live.active) return;
    if (isFinal) {
      // Keep only the newest finished sentence, or the line grows without end.
      live.textBuf = text + " ";
      live.partial = "";
      queueFinalTranslation(text);
    } else {
      live.partial = text;
      queuePartialTranslation(text);
    }
    liveRender();
  }

  function liveClearText() {
    live.textBuf = live.partial = live.transBuf = live.transPartial = "";
    live.pendingPartial = "";
    clearTimeout(live.partialTimer);
    live.partialTimer = null;
    live.partialToken++;
  }

  function liveOnStatus(status, detail) {
    live.status = status;
    live.detail = detail || "";
    log(`live: ${status}${detail ? " — " + detail : ""}`);
  }

  async function startLive() {
    if (!P) return { ok: false, error: "no-platform" };
    if (live.active) return { ok: true };
    const video = P.getVideoEl();
    if (!video) return { ok: false, error: "no-video" };
    const res = await window.YDS_LIVE.start(video, { onText: liveOnText, onStatus: liveOnStatus });
    if (!res.ok) {
      liveOnStatus("unavailable", res.detail || res.error);
      return res;
    }
    live.active = true;
    live.gen++;
    applyOverlayStyles();
    return { ok: true };
  }

  function stopLive() {
    if (!live.active && live.status === "stopped") return { ok: true };
    live.active = false;
    live.gen++;
    applyOverlayStyles();
    // Force the render loop to repaint from the track rather than skip it as
    // unchanged — the overlay currently holds live text, not currentRenderedText.
    currentRenderedText = "";
    clearTimeout(live.hideTimer);
    clearTimeout(live.partialTimer);
    liveClearText();
    if (overlayEl) overlayEl.classList.remove("yds-live-visible");
    window.YDS_LIVE.stop();
    renderSourceLine("");
    renderOverlay("");
    return { ok: true };
  }

  // Pausing to read is the one moment a viewer wants the line to stay put.
  //
  // Subtitle tracks handle this by themselves: the timeline stops, so the cue
  // under the playhead keeps rendering for as long as the video is paused.
  // Live text has no timeline — it is only ever "the last thing heard" — so
  // without this it fades on the ordinary silence timeout a few seconds after
  // the audio stops, which is exactly when someone paused to read it.
  function watchPlayback() {
    const ours = (e) => e.target instanceof HTMLMediaElement
                     && (!P || P.getVideoEl() === e.target);
    const holdFor = (ms) => {
      clearTimeout(live.hideTimer);
      live.hideTimer = setTimeout(() => {
        if (overlayEl) overlayEl.classList.remove("yds-live-visible");
      }, ms);
    };
    document.addEventListener("pause", (e) => {
      if (live.active && ours(e)) holdFor(LIVE_PAUSE_HOLD_MS);
    }, true);
    document.addEventListener("play", (e) => {
      if (live.active && ours(e)) holdFor(LIVE_HIDE_MS);
    }, true);
  }

  // A seek makes the recogniser's buffered audio meaningless.
  function watchSeeks() {
    document.addEventListener("seeking", (e) => {
      if (!live.active) return;
      if (!(e.target instanceof HTMLMediaElement)) return;
      live.gen++;
      liveClearText();
      window.YDS_LIVE.reset();
      liveRender();
    }, true);
  }

  // ---------- render loop (uses preCues if available) ----------
  function findCuesAt(cues, t) {
    // Return all cues active at time t, joined by newline. Dedupe by text so
    // overlapping identical entries don't render twice (belt-and-suspenders
    // over coalesceIdenticalCues, which handles adjacent-in-time duplicates).
    const seen = new Set();
    const active = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.start && t < c.end) {
        if (!seen.has(c.text)) {
          seen.add(c.text);
          active.push(c.text);
        }
      } else if (c.start > t) break;
    }
    return active.join("\n");
  }

  // Whether the overlay is allowed on screen at all right now.
  //
  // The default is to follow the player: the second language is meant to sit
  // under the original, so closing the player's captions hides both. Users who
  // only want the translation turn on translationOnly, which cuts that tie.
  //
  // A null from isCcOn() means we genuinely could not read the player's caption
  // state, and we stay hidden. Showing on a maybe is the wrong default here —
  // it puts a subtitle on screen the viewer never asked for, which is the one
  // thing this setting exists to prevent. Both adapters have a second signal
  // behind the button, so null should be rare; if it does happen the escape
  // hatch is the translation-only switch.
  function overlayAllowed() {
    if (STATE.settings.translationOnly) return true;
    return isCcOn() === true;
  }

  function renderTick() {
    const video = P ? P.getVideoEl() : null;
    // Native cues always win over translated ones.
    const cues = preCuesNative.length ? preCuesNative : preCuesTranslated;
    // Live transcription owns the overlay whenever it is running, and drives it
    // from its own events rather than from here.
    //
    // A subtitle track is the better source — it is exact where a recogniser
    // guesses — so nothing ever switches to live on its own. But turning live on
    // is an explicit act, and it used to be silently ignored on any video that
    // had a track: the audio was captured, the socket connected, and the screen
    // never changed. Whoever pressed the button gets what they asked for; the
    // track is still in memory and comes straight back when they stop.
    if (live.active) {
      requestAnimationFrame(renderTick);
      return;
    }
    if (video && STATE.settings.enabled && cues.length && overlayAllowed()) {
      const text = findCuesAt(cues, video.currentTime);
      const displayText = alignWithNativeLineBreaks(text);
      if (displayText !== currentRenderedText) {
        currentRenderedText = displayText;
        renderOverlay(displayText);
      }
    } else if (currentRenderedText) {
      currentRenderedText = "";
      renderOverlay("");
    }
    requestAnimationFrame(renderTick);
  }

  // ---------- DOM observation fallback ----------
  let captionObserver = null;
  let attachTimer = null;

  function currentNativeText() {
    return currentNativeLines().join(" ").replace(/\s+/g, " ").trim();
  }

  function currentNativeLines() {
    return P ? P.nativeLines() : [];
  }

  function normalizeForLineMatch(text) {
    return (text || "").replace(/\s+/g, "");
  }

  function alignWithNativeLineBreaks(text) {
    const nativeLines = currentNativeLines();
    if (nativeLines.length < 2) return text.replace(/\n+/g, " ");
    const nativeText = nativeLines.join("");
    if (normalizeForLineMatch(nativeText) !== normalizeForLineMatch(text)) return text.replace(/\n+/g, " ");
    return nativeLines.join("\n");
  }

  function attachCaptionObserver() {
    const target = (P && P.observeTarget()) || document.body;
    if (!target) return;
    if (captionObserver) { try { captionObserver.disconnect(); } catch {} }
    captionObserver = new MutationObserver(() => pumpFromNative(false));
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    log("caption observer attached");
  }

  function scheduleAttach() {
    if (attachTimer) return;
    attachTimer = setInterval(() => {
      if (P && P.observeTarget()) {
        clearInterval(attachTimer);
        attachTimer = null;
        attachCaptionObserver();
      }
    }, 500);
  }

  async function pumpFromNative(force) {
    if (!STATE.settings.enabled || !STATE.settings.secondLang) return;
    // If we're already rendering from any pre-loaded cues, skip the fallback.
    if (preCuesNative.length || preCuesTranslated.length) return;

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
      if (!t || t !== lastNativeText || preCuesNative.length || preCuesTranslated.length) return;
      if (translationCache.has(t)) {
        currentRenderedText = translationCache.get(t);
        renderOverlay(currentRenderedText);
        return;
      }
      try {
        const raw = await translateText(t, toGoogleLang(lang));
        const translated = stripUnwantedPunctuation(raw);
        translationCache.set(t, translated);
        if (lastNativeText === t && !preCuesNative.length && !preCuesTranslated.length) {
          currentRenderedText = translated;
          renderOverlay(translated);
        }
      } catch (e) { log("translate failed", e); }
    }, 250);
  }

  // ---------- overlay ----------
  function getVideoContainer() {
    return P ? P.getContainer() : null;
  }

  function ensureOverlay() {
    const container = getVideoContainer();
    if (!container) return null;
    if (overlayEl && overlayEl.isConnected && overlayEl.parentElement === container) return overlayEl;
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement("div");
    overlayEl.id = "yt-dual-sub-overlay";
    overlayEl.className = "yds-overlay";
    // Two lines, each wrapped in a clip. Normally only the lower one is used:
    // the original is already on screen in the player's own caption strip and we
    // sit under it. Live transcription has no strip to sit under — the
    // recognised speech IS the original — so it fills the upper line too.
    //
    // The clip/wrap nesting only matters in live mode, where it pins the box to
    // two lines and scrolls older text off the top. For a subtitle track the
    // extra elements are inert.
    const makeLine = (cls) => {
      const clip = document.createElement("div");
      clip.className = "yds-clip";
      const wrap = document.createElement("div");
      wrap.className = "yds-wrap";
      const line = document.createElement("span");
      line.className = `yds-line ${cls}`;
      wrap.appendChild(line);
      clip.appendChild(wrap);
      overlayEl.appendChild(clip);
      return line;
    };
    const sourceEl = makeLine("yds-source");
    sourceEl.closest(".yds-clip").style.display = "none";
    makeLine("yds-text");
    container.appendChild(overlayEl);
    attachDragUI();
    applyOverlayStyles();
    // A rebuild mid-drag (player swapped the container out from under us) would
    // otherwise drop the dashed outline that shows the drag is live.
    if (dragging) overlayEl.classList.add("yds-dragging");
    return overlayEl;
  }

  // The whole drag interaction is one window-level capture-phase controller,
  // installed once. Two Vimeo facts force this shape:
  //
  //   1. `.vp-target` is a full-bleed mouse-capture layer sitting *after*
  //      `.vp-video-wrapper` under `.player`, so pointer events over the video
  //      never reach the overlay's own container — a listener there sees
  //      nothing and the handle would never appear.
  //   2. The player toggles play/pause from a listener we can't outrank by
  //      bubbling, so grabbing the handle also paused the video.
  //
  // Capture on window is the earliest point in the propagation path, so we get
  // every event first and can keep the player out of the ones that are ours.
  // nearOverlay() is pure geometry, so none of this is Vimeo-specific — it
  // behaves the same on YouTube.
  let dragging = false;
  let dragWatcherInstalled = false;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let dragContainerH = 1;
  let swallowNextClick = false;

  function nearOverlay(x, y) {
    if (!overlayEl || !overlayEl.isConnected || overlayEl.style.display === "none") return false;
    const b = overlayEl.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return false;
    // Expand hit area vertically so the small handle is easy to reach.
    return x >= b.left - 30 && x <= b.right + 30 && y >= b.top - 34 && y <= b.bottom + 20;
  }

  function isDragHandle(e) {
    const t = e.target;
    if (t && t.classList && t.classList.contains("yds-drag-handle")) return true;
    // Fall back to geometry. A player can float a transparent capture layer
    // above everything (Vimeo's .vp-target, YouTube's chrome), which makes
    // e.target something else entirely even though the pointer is on our
    // handle. Hit-testing by rect doesn't care what is painted on top.
    const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
    if (!h || !h.isConnected) return false;
    const b = h.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    return e.clientX >= b.left && e.clientX <= b.right
        && e.clientY >= b.top && e.clientY <= b.bottom;
  }

  function setHandleVisible(visible) {
    const h = overlayEl && overlayEl.querySelector(".yds-drag-handle");
    if (h) h.classList.toggle("yds-drag-visible", visible);
  }

  function ensureDragWatcher() {
    if (dragWatcherInstalled) return;
    dragWatcherInstalled = true;

    window.addEventListener("mousemove", (e) => {
      if (!dragging) {
        setHandleVisible(nearOverlay(e.clientX, e.clientY));
        return;
      }
      // preventDefault stops text selection mid-drag. We deliberately do NOT
      // stopPropagation here: starving every other mousemove listener on the
      // page breaks player UI (control bars, hover states) for no gain — the
      // click swallow below is what keeps the player from reacting.
      e.preventDefault();
      // Mouse moves DOWN in screen → subtitle should move DOWN (bottom % decreases).
      const deltaPct = -((e.clientY - dragStartY) / dragContainerH) * 100;
      STATE.settings.bottomOffset = Math.max(0, Math.min(95, dragStartOffset + deltaPct));
      applyOverlayStyles();
    }, true);

    window.addEventListener("mousedown", (e) => {
      if (!isDragHandle(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const container = getVideoContainer();
      dragging = true;
      dragStartY = e.clientY;
      dragStartOffset = Number(STATE.settings.bottomOffset) || 0;
      dragContainerH = (container && container.getBoundingClientRect().height) || 1;
      if (overlayEl) overlayEl.classList.add("yds-dragging");
      setHandleVisible(true);
    }, true);

    window.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      // The click generated by this mouseup can land anywhere, including off
      // the handle — swallow that one too so it doesn't reach the player.
      swallowNextClick = true;
      if (overlayEl) overlayEl.classList.remove("yds-dragging");
      // Persist the rounded value.
      const val = Math.round(Number(STATE.settings.bottomOffset) || 0);
      chrome.storage.sync.get(["ydsSettings"], (r) => {
        const merged = { ...(r && r.ydsSettings ? r.ydsSettings : {}), bottomOffset: val };
        chrome.storage.sync.set({ ydsSettings: merged });
      });
    }, true);

    for (const type of ["pointerdown", "pointerup"]) {
      window.addEventListener(type, (e) => {
        // stopPropagation only — preventDefault() on pointerdown would suppress
        // the compatibility mousedown that starts the drag.
        if (isDragHandle(e) || dragging) e.stopPropagation();
      }, true);
    }

    for (const type of ["click", "dblclick"]) {
      window.addEventListener(type, (e) => {
        if (!isDragHandle(e) && !swallowNextClick) return;
        swallowNextClick = false;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }

    // Deliberately no "mouseleave" listener: it does not bubble, but a capture
    // listener on window still fires for every element the pointer exits, so
    // it hid the handle constantly on dense player DOMs. mousemove above
    // already hides the handle whenever the pointer isn't near the overlay;
    // this only covers the pointer leaving the window entirely.
    document.addEventListener("mouseout", (e) => {
      if (!dragging && !e.relatedTarget) setHandleVisible(false);
    });
  }

  function attachDragUI() {
    // Handle: small draggable pill above the overlay. All of its behaviour
    // lives in the window-level watcher above.
    const handle = document.createElement("div");
    handle.className = "yds-drag-handle";
    handle.textContent = "↕";
    handle.title = ydsT("dragHint");
    overlayEl.appendChild(handle);
    ensureDragWatcher();
  }

  function applyOverlayStyles() {
    if (!overlayEl) return;
    const s = STATE.settings;
    overlayEl.style.color = s.color;
    overlayEl.style.fontSize = `${s.fontSize}px`;
    // In live mode the background belongs to the text, not to the box, and the
    // width is fixed rather than measured — both handed to CSS as variables.
    overlayEl.classList.toggle("yds-live", live.active);
    if (live.active) {
      const pct = Math.max(20, Math.min(100, Number(s.captionWidth) || 60));
      overlayEl.style.setProperty("--yds-live-width", `${pct}%`);
      overlayEl.style.setProperty("--yds-live-bg", s.background);
      overlayEl.style.background = "";
      overlayEl.style.width = "";
    } else {
      overlayEl.style.background = s.background;
    }
    const offset = Math.max(0, Math.min(95, Number(s.bottomOffset) || 0));
    overlayEl.style.bottom = `${offset}%`;
    overlayEl.style.top = "auto";
  }

  function renderOverlay(text) {
    const el = ensureOverlay();
    if (!el) return;
    const textEl = el.querySelector(".yds-text");
    const sourceEl = el.querySelector(".yds-source");
    const sourceShown = sourceEl && sourceEl.style.display !== "none" && sourceEl.textContent;
    if (!STATE.settings.enabled || (!text && !sourceShown)) {
      el.style.display = "none";
      if (textEl) textEl.textContent = "";
      return;
    }
    el.style.display = "";
    if (textEl) {
      textEl.textContent = text || "";
      const clip = textEl.closest(".yds-clip");
      if (clip) clip.style.display = text ? "" : "none";
      // Live mode is a stream, not a line: its width is fixed by CSS and its
      // height is clipped, so neither measurement applies. Running them here
      // would also be ruinous — the orphan check builds a Range per character,
      // several times a second, for as long as someone is talking.
      if (text && !live.active) {
        matchNativeCaptionWidth();
        avoidOrphanCaptionLine(textEl, text);
      }
    }
  }

  // The upper line: what is being said, as heard by the local recogniser.
  // Only live transcription uses it.
  function renderSourceLine(text) {
    const el = ensureOverlay();
    if (!el) return;
    const sourceEl = el.querySelector(".yds-source");
    if (!sourceEl) return;
    const clip = sourceEl.closest(".yds-clip");
    if (!text) {
      if (clip) clip.style.display = "none";
      sourceEl.textContent = "";
      return;
    }
    if (clip) clip.style.display = "";
    sourceEl.textContent = text;
    el.style.display = "";
    // Outside live mode the box is sized to its content, and with only the
    // upper line filled it would otherwise keep whatever width the lower line
    // last asked for.
    if (!live.active) matchNativeCaptionWidth();
  }

  // Wrap the translation at roughly the width the player is using for its own
  // caption line, so the two read as a matched pair instead of the translation
  // folding onto an extra line while the original still fits.
  //
  // This has to set `width`, not `max-width`. The overlay is an absolutely
  // positioned shrink-to-fit box, and the browser picks a used width well under
  // max-width — measured on a 32-character line: 320px/3 lines under a 378px
  // max-width, but 2 lines when the width is set outright.
  //
  // Bounded on both sides. Never wider than the text actually needs, so a short
  // line still hugs its text instead of sitting in a wide empty bar; never
  // narrower than 30% of the video, so a stray native fragment ("So,") can't
  // squeeze the translation into a column.
  function matchNativeCaptionWidth() {
    if (!overlayEl) return;
    const textEl = overlayEl.querySelector(".yds-text");
    const container = getVideoContainer();
    const containerW = container ? container.getBoundingClientRect().width : 0;
    if (!textEl || !containerW) {
      overlayEl.style.width = "";      // fall back to the stylesheet's max-width
      return;
    }

    const cs = getComputedStyle(overlayEl);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const nativeWidth = P && P.nativeCaptionWidth ? P.nativeCaptionWidth() : 0;

    // Two ways to decide how wide to wrap, and which one applies depends on
    // whether there is an original on screen to line up with.
    let target;
    if (nativeWidth) {
      // Match the player's own caption line, clamped so a stray fragment
      // ("So,") can't squeeze us into a column.
      target = Math.min(Math.max(nativeWidth, containerW * 0.3), containerW * 0.96 - pad);
    } else {
      // Nothing to match — live transcription, or translation-only with the
      // player's captions closed. Fall back to the viewer's chosen share of the
      // player. This matters when the picture itself is pillarboxed (4:3 footage
      // in a 16:9 player): filling the player would push text past the image.
      const pct = Math.max(20, Math.min(100, Number(STATE.settings.captionWidth) || 100));
      target = containerW * (pct / 100) - pad;
    }

    // Measure both lines: live transcription often has the original up before
    // its translation arrives, and sizing off an empty lower line would collapse
    // the box and then jump when the translation lands.
    const sourceEl = overlayEl.querySelector(".yds-source");
    const needed = Math.max(
      measureUnwrappedWidth(textEl),
      sourceEl && sourceEl.style.display !== "none" ? measureUnwrappedWidth(sourceEl) : 0
    );
    if (!needed) { overlayEl.style.width = ""; return; }
    // Chrome reports content-box widths through `width`; add the padding back
    // when the page has put the element in border-box.
    const extra = cs.boxSizing === "border-box" ? pad : 0;
    overlayEl.style.width = `${Math.round(Math.min(needed, target) + extra)}px`;
  }

  // Width this text would take on a single unwrapped line.
  function measureUnwrappedWidth(textEl) {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
    probe.style.font = getComputedStyle(textEl).font;
    probe.textContent = (textEl.textContent || "").replace(/\n/g, " ");
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }

  function lineLengthsForTextNode(textNode) {
    const rows = [];
    const text = textNode.nodeValue || "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") continue;
      const range = document.createRange();
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (!rect.width || !rect.height) continue;
      let row = rows.find(r => Math.abs(r.top - rect.top) < 6);
      if (!row) {
        row = { top: rect.top, chars: 0 };
        rows.push(row);
      }
      row.chars++;
    }
    return rows.sort((a, b) => a.top - b.top).map(r => r.chars);
  }

  function splitBalancedText(text) {
    const compact = text.replace(/\s*\n+\s*/g, "").trim();
    if (compact.length < 8) return text;
    const target = Math.floor(compact.length / 2);
    const forbiddenStart = /[，。！？、；：,.!?;:）】”’]/;
    let best = target;
    for (let offset = 0; offset <= 4; offset++) {
      for (const idx of [target + offset, target - offset]) {
        if (idx <= 2 || idx >= compact.length - 2) continue;
        if (forbiddenStart.test(compact[idx])) continue;
        best = idx;
        offset = 99;
        break;
      }
    }
    return `${compact.slice(0, best)}\n${compact.slice(best)}`;
  }

  function avoidOrphanCaptionLine(textEl, originalText) {
    if (!originalText || originalText.includes("\n")) return;
    const textNode = textEl.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const lines = lineLengthsForTextNode(textNode);
    if (lines.length !== 2) return;
    const last = lines[lines.length - 1];
    const first = lines[0];
    if (last > 2 || first < 8) return;

    const balanced = splitBalancedText(originalText);
    if (balanced !== originalText) textEl.textContent = balanced;
  }

  // ---------- SPA nav handling ----------
  function watchUrlChanges(tryAttach) {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Landing page → video page is a URL change with no page load, so this
        // is where a session that started with nothing to do comes alive.
        if (tryAttach) tryAttach();
        const newVid = P ? P.getVideoId() : null;
        if (newVid !== STATE.videoId) {
          abortInflightTranslation("video changed");
          closePaidApiPrompt();
          setTranslationStatus({
            mode: "idle",
            provider: "",
            requestedProvider: "",
            cueCount: 0,
            error: ""
          });
          STATE.videoId = newVid;
          preCuesNative = [];
          preCuesTranslated = [];
          sourceCuesCache = null;
          availableTracks = [];
          trackRequested = false;
          sourceRequestAttempts = 0;
          sourceLang = "";
          sourceIsAsr = false;
          betterSourceRequested = false;
          seenTrackKeys.clear();
          translationCache.clear();
          lastNativeText = "";
          currentRenderedText = "";
          if (P) P.reset();
          stopLive();
          renderOverlay("");
        }
      }
    }).observe(document, { subtree: true, childList: true });
  }

  // ---------- messaging with popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // With all_frames on, this script also runs in the player's helper frames.
    // Staying silent there lets the frame that actually holds the video answer
    // the popup — sendMessage takes the first reply it gets.
    if (!P) return;
    if (msg?.type === "YDS_GET_INFO") {
      sendResponse({
        platform: STATE.platform,
        videoId: P ? P.getVideoId() : null,
        tracks: availableTracks,
        translations: [],
        settings: STATE.settings,
        nativeCaptionText: currentNativeText(),
        translationStatus,
        preCuesLoaded: preCuesNative.length + preCuesTranslated.length,
        usingNativeTrack: preCuesNative.length > 0,
        live: { active: live.active, status: live.status, detail: live.detail }
      });
      return true;
    }
    if (msg?.type === "YDS_APPROVE_PAID_API") {
      sendResponse(approvePaidApiForCurrentVideo("popup approval"));
      return true;
    }
    if (msg?.type === "YDS_LIVE_START") {
      startLive().then(sendResponse);
      return true;   // async
    }
    if (msg?.type === "YDS_LIVE_STOP") {
      sendResponse(stopLive());
      return true;
    }
  });

  // ---------- boot ----------
  (async function boot() {
    const platformId = window.YDS_PLATFORMS && window.YDS_PLATFORMS.detect();
    if (!platformId) return;

    const ctx = {
      log,
      settings: () => STATE.settings,
      langMatches,
      coalesce: coalesceIdenticalCues,
      onTrackList: handleTrackList,
      ingest: ingestCues
    };

    // Attaching is deliberately retryable. These sites are single-page apps: the
    // viewer often lands on a home or listing page — where there is no video and
    // nothing for us to do — and clicks through to a video without a page load.
    // Deciding once at document_start and giving up would leave the extension
    // dead for the rest of the session, which is exactly what it used to do.
    function tryAttach() {
      if (P) return true;
      const candidate = window.YDS_PLATFORMS.create(platformId, ctx);
      // Also weeds out the player's helper frames, since we run in all frames.
      if (!candidate || !candidate.looksLikeVideoPage()) return false;
      P = candidate;
      STATE.platform = platformId;
      P.start();          // page-world hooks go in first, before settings load
      STATE.videoId = P.getVideoId();
      scheduleAttach();
      watchSeeks();
      watchPlayback();
      requestAnimationFrame(renderTick);
      log("attached", { platform: platformId, videoId: STATE.videoId });
      return true;
    }

    tryAttach();

    await loadSettings();
    if (typeof ydsSetUiLang === "function") ydsSetUiLang(STATE.settings.uiLang);
    cacheKeyLang = STATE.settings.secondLang;
    if (P) STATE.videoId = P.getVideoId();
    drainPending();

    watchUrlChanges(tryAttach);
    log("booted", { platform: platformId, attached: !!P, secondLang: STATE.settings.secondLang });
  })();
})();
