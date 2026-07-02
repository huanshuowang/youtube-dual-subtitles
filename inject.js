// Runs in the page's main world.
//
// Two jobs:
//   1) Patch fetch / XMLHttpRequest so we forward YouTube's timedtext responses
//      to the content script (only YouTube's own request carries a valid PoT
//      token — direct fetches from us return empty).
//   2) Read ytInitialPlayerResponse to publish the available caption tracks,
//      and expose a bridge that lets content.js ask YouTube's player to load
//      a specific track (so we can intercept a native second-language track
//      even when the user's CC is set to a different language).
(function () {
  if (window.__ydsInjected) return;
  window.__ydsInjected = true;

  // ---- report helper ----
  function report(url, text) {
    if (!text || typeof text !== "string") return;
    if (text.length < 5) return;
    try {
      window.dispatchEvent(new CustomEvent("YDS_TIMEDTEXT", { detail: { url: String(url), text } }));
    } catch {}
  }

  // ---- fetch patch ----
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          if (url.includes("/api/timedtext")) {
            p.then(res => {
              try {
                const clone = res.clone();
                clone.text().then(t => report(url, t)).catch(() => {});
              } catch {}
            }).catch(() => {});
          }
        } catch {}
        return p;
      };
    }
  } catch {}

  // ---- XMLHttpRequest patch ----
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ydsUrl = String(url || "");
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__ydsUrl && this.__ydsUrl.includes("/api/timedtext")) {
        this.addEventListener("load", () => {
          try {
            const t = this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : (typeof this.response === "string" ? this.response : "");
            report(this.__ydsUrl, t);
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch {}

  // ---- track list from ytInitialPlayerResponse ----
  function publishTracks() {
    try {
      const r = window.ytInitialPlayerResponse;
      const rawTracks = (r && r.captions
        && r.captions.playerCaptionsTracklistRenderer
        && r.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      const tracks = rawTracks.map(t => ({
        languageCode: t.languageCode || "",
        kind: t.kind || "",
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map(x => x.text).join(""))) || t.languageCode || ""
      }));
      const videoId = (r && r.videoDetails && r.videoDetails.videoId) || null;
      window.dispatchEvent(new CustomEvent("YDS_TRACK_LIST", { detail: { videoId, tracks } }));
    } catch {}
  }

  publishTracks();
  setTimeout(publishTracks, 500);
  setTimeout(publishTracks, 1500);

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(publishTracks, 500);
      setTimeout(publishTracks, 1500);
    }
  }).observe(document, { subtree: true, childList: true });

  // ---- bridge to YouTube player's caption API ----
  // Content script dispatches YDS_LOAD_NATIVE_TRACK with { languageCode }.
  // We ask the player to load that track briefly (which triggers YouTube's own
  // fetch, which we intercept above), then restore the user's original CC.
  window.addEventListener("YDS_LOAD_NATIVE_TRACK", async (e) => {
    const langCode = e.detail && e.detail.languageCode;
    if (!langCode) return;
    const player = document.querySelector("#movie_player");
    if (!player || typeof player.setOption !== "function") return;

    let originalTrack = null;
    try { originalTrack = player.getOption("captions", "track"); } catch {}
    const ccWasOff = !originalTrack || !originalTrack.languageCode;

    // Hide YouTube's native caption strip while we're swapping tracks so the
    // user doesn't see a flash of the wrong language.
    document.body.classList.add("yds-suppressing-native");

    try {
      player.setOption("captions", "track", { languageCode: langCode });
      // Give YouTube time to fetch the new track (our interceptor catches it).
      await new Promise(r => setTimeout(r, 900));
    } catch {}

    // Restore whatever the user had before.
    try {
      if (!ccWasOff) {
        player.setOption("captions", "track", originalTrack);
      } else {
        try { player.unloadModule("captions"); } catch {}
      }
    } catch {}

    setTimeout(() => document.body.classList.remove("yds-suppressing-native"), 250);
  });
})();
