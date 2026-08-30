// Platform adapters.
//
// Loaded before content.js in the same isolated world, so content.js just
// reads window.YDS_PLATFORMS off this file.
//
// content.js owns everything platform-independent: cue merging, the five
// translation providers, the paid-API confirmation flow, the overlay and its
// drag UI, the render loop. An adapter only has to answer four questions:
//
//   Where is the <video>?          getVideoEl()
//   Where do I hang the overlay?   getContainer()
//   What caption tracks exist?     start() -> ctx.onTrackList(tracks)
//   Give me a track's cues.        start() / requestTrack() -> ctx.ingest(...)
//
// The two platforms get cues in opposite ways:
//
//   YouTube — passive. Third-party fetches of /api/timedtext come back empty
//   (PoT token check), so inject-youtube.js patches fetch/XHR in the main world
//   and we take whatever the player itself downloads. To read a *different*
//   language we have to ask the player to swap tracks and catch the request.
//
//   Vimeo — active. Caption tracks are ordinary <track> elements pointing at
//   signed .vtt files on captions.vimeo.com, and those fetch fine cross-origin.
//   We can pull any language on demand, so there is no swap dance and no need
//   for the user to turn CC on first.
//
// ---------------------------------------------------------------------------
// Adapter contract
//
//   id                      "youtube" | "vimeo"
//   looksLikeVideoPage()    bool — cheap bail-out for frames with no player
//   getVideoId()            string | null
//   getVideoEl()            HTMLVideoElement | null
//   getContainer()          Element | null — overlay parent, must be positioned
//   isCcOn()                true | false | null (player not ready)
//   requiresCcForTracks     bool — gate track loading on the CC button?
//   nativeLines()           string[] — rendered native caption lines
//   nativeCaptionWidth()    px width of the widest rendered caption line, 0 if none
//   observeTarget()         Element | null — MutationObserver root for fallback
//   start()                 begin track discovery
//   requestTrack(t)         load this specific track (t from onTrackList)
//   reset()                 forget per-video state
//
// ctx, handed to each factory by content.js:
//
//   ctx.log(...)            debug logger
//   ctx.settings()          live STATE.settings
//   ctx.langMatches(a, b)   BCP-47 comparison, Hans/Hant aware
//   ctx.coalesce(cues)      merge adjacent duplicate cues
//   ctx.onTrackList(tracks) [{languageCode, kind, name}] — kind "asr" = machine
//   ctx.ingest(payload)     {cues, lang, isAsr, isNativeTarget, key}
// ---------------------------------------------------------------------------

(() => {
  // ---------- shared helpers ----------

  function injectPageScript(file, id) {
    if (document.getElementById(id)) return;
    const s = document.createElement("script");
    s.id = id;
    s.src = chrome.runtime.getURL(file);
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  }

  // Widest rendered line among these nodes, in CSS px. content.js uses it to
  // wrap the translation at about the same width the player wraps its own
  // caption, so the two lines stack up as a matched pair.
  function widestLineWidth(nodes) {
    let width = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width > width && r.height) width = r.width;
    }
    return width;
  }

  // Strip caption markup that no translator should ever see: karaoke
  // timestamps, <v Speaker> / <c.classname> / <i> tags, HTML entities.
  function cleanCueText(s) {
    return String(s || "")
      .replace(/<\d{2}:\d{2}[0-9:.]*>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  // =========================================================================
  // YouTube
  // =========================================================================

  function createYouTube(ctx) {
    function videoIdFromUrl() {
      const m = /[?&]v=([^&]+)/.exec(location.search);
      return m ? m[1] : null;
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
      return ctx.coalesce(cues);
    }

    function parseSrv3(xml) {
      const cues = [];
      try {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        doc.querySelectorAll("p").forEach(p => {
          const t = parseInt(p.getAttribute("t") || "0", 10);
          const d = parseInt(p.getAttribute("d") || "0", 10);
          if (d <= 0) return;
          const text = (p.textContent || "").replace(/\s+/g, " ").trim();
          if (!text) return;
          cues.push({ start: t / 1000, end: (t + d) / 1000, text });
        });
        cues.sort((a, b) => a.start - b.start);
      } catch {}
      return ctx.coalesce(cues);
    }

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

    function onTimedText(e) {
      const detail = e.detail || {};
      const url = detail.url || "";
      const text = detail.text || "";

      // Skip YouTube's own auto-translated tracks; we prefer either a real
      // native track OR our own translation.
      if (/[?&]tlang=/.test(url)) {
        ctx.log("intercept: skipping tlang track");
        return;
      }

      // YouTube prefetches captions for autoplay / hover-preview videos.
      // Only accept the track whose v= matches the video the user is watching.
      const vMatch = /[?&]v=([^&]+)/.exec(url);
      const trackVideoId = vMatch ? vMatch[1] : null;
      const pageVideoId = videoIdFromUrl();
      if (trackVideoId && pageVideoId && trackVideoId !== pageVideoId) {
        ctx.log("intercept: skipping track for other video", trackVideoId, "current", pageVideoId);
        return;
      }

      const langMatch = /[?&]lang=([^&]+)/.exec(url);
      const trackLang = langMatch ? decodeURIComponent(langMatch[1]) : "";
      const isAsr = /[?&]kind=asr/.test(url);

      const cues = parseCaptions(text);
      if (!cues.length) return;

      ctx.ingest({
        cues,
        lang: trackLang,
        isAsr,
        isNativeTarget: !isAsr && !!trackLang && ctx.langMatches(ctx.settings().secondLang, trackLang),
        key: `${trackLang}|${isAsr ? "asr" : "sub"}|${cues.length}|${cues[0].start.toFixed(3)}|${cues[cues.length - 1].end.toFixed(3)}`
      });
    }

    function nativeLines() {
      const captionWindows = Array.from(document.querySelectorAll(".ytp-caption-window-container .caption-window"));
      for (const win of captionWindows) {
        const lineNodes = Array.from(win.querySelectorAll(".caption-visual-line, .ytp-caption-segment"));
        if (!lineNodes.length) continue;
        const rows = [];
        for (const node of lineNodes) {
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          const rect = node.getBoundingClientRect();
          if (!text || !rect.width || !rect.height) continue;
          const row = rows.find(r => Math.abs(r.top - rect.top) < 8);
          if (row) {
            row.parts.push({ text, left: rect.left });
            row.top = Math.min(row.top, rect.top);
          } else {
            rows.push({ top: rect.top, parts: [{ text, left: rect.left }] });
          }
        }
        const lines = rows
          .sort((a, b) => a.top - b.top)
          .map(r => r.parts.sort((a, b) => a.left - b.left).map(p => p.text).join(" ").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (lines.length > 1) return lines;
      }

      const visualLines = Array.from(document.querySelectorAll(".captions-text .caption-visual-line"))
        .map(n => (n.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (visualLines.length) return visualLines;

      const segments = Array.from(document.querySelectorAll(".ytp-caption-segment"))
        .map(n => ({ text: (n.textContent || "").trim(), rect: n.getBoundingClientRect() }))
        .filter(s => s.text && s.rect.width && s.rect.height)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

      if (segments.length) {
        const rows = [];
        for (const seg of segments) {
          const row = rows.find(r => Math.abs(r.top - seg.rect.top) < 6);
          if (row) row.parts.push(seg);
          else rows.push({ top: seg.rect.top, parts: [seg] });
        }
        return rows
          .sort((a, b) => a.top - b.top)
          .map(r => r.parts.sort((a, b) => a.rect.left - b.rect.left).map(p => p.text).join(" ").replace(/\s+/g, " ").trim())
          .filter(Boolean);
      }

      for (const sel of [".ytp-caption-window-container .caption-window", ".ytp-caption-window-container"]) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length) {
          const text = Array.from(nodes).map(n => n.textContent || "").join(" ").replace(/\s+/g, " ").trim();
          if (text) return [text];
        }
      }
      return [];
    }

    return {
      id: "youtube",
      requiresCcForTracks: true,
      looksLikeVideoPage: () => true,
      getVideoId: videoIdFromUrl,
      getVideoEl: () => document.querySelector("video.html5-main-video"),
      getContainer: () => document.querySelector("#movie_player") || document.querySelector(".html5-video-container"),
      isCcOn() {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (!btn || !btn.hasAttribute("aria-pressed")) return null;
        return btn.getAttribute("aria-pressed") === "true";
      },
      nativeLines,
      nativeCaptionWidth() {
        const nodes = document.querySelectorAll(
          ".ytp-caption-window-container .caption-visual-line, .ytp-caption-window-container .ytp-caption-segment"
        );
        return widestLineWidth(nodes);
      },
      observeTarget: () => document.querySelector("#movie_player"),
      start() {
        injectPageScript("inject-youtube.js", "yds-inject-youtube");
        window.addEventListener("YDS_TRACK_LIST", (e) => {
          ctx.onTrackList((e.detail && e.detail.tracks) || []);
        });
        window.addEventListener("YDS_TIMEDTEXT", onTimedText);
      },
      requestTrack(track) {
        window.dispatchEvent(new CustomEvent("YDS_LOAD_NATIVE_TRACK", {
          detail: { languageCode: track.languageCode }
        }));
      },
      // Nothing memoised on this side — every request goes back to the player.
      forgetLoadedCues() {},
      reset() {}
    };
  }

  // =========================================================================
  // Vimeo
  // =========================================================================

  function createVimeo(ctx) {
    let tracks = [];            // [{languageCode, kind, name, url, rawLang}]
    let configTracks = [];      // from playerConfig, published by inject-vimeo.js
    let lastSignature = "";
    let pollTimer = null;
    let probingTextTrack = false;   // true while cuesFromTextTrack owns a track mode
    const loadedKeys = new Set();

    // "en-x-autogen" is Vimeo's marker for a machine transcript.
    function normLang(code) {
      return String(code || "").replace(/-x-autogen$/i, "").trim();
    }
    function isMachine(rawLang, provenance) {
      return /-x-autogen$/i.test(rawLang || "") || provenance === "ai_generated";
    }

    function videoEl() {
      return document.querySelector(".vp-video video") || document.querySelector("video");
    }

    // ----- WebVTT -----

    function vttTime(s) {
      const parts = String(s).trim().replace(",", ".").split(":").map(Number);
      if (parts.some(n => Number.isNaN(n))) return NaN;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0];
    }

    function parseVtt(raw) {
      const cues = [];
      const blocks = String(raw || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
      for (const block of blocks) {
        const lines = block.split("\n").filter(l => l.trim() !== "");
        if (!lines.length) continue;
        if (/^﻿?WEBVTT/.test(lines[0])) continue;
        if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
        // An optional cue identifier can precede the timing line.
        let i = lines[0].includes("-->") ? 0 : 1;
        if (i >= lines.length || !lines[i].includes("-->")) continue;
        const m = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
        if (!m) continue;
        const start = vttTime(m[1]);
        const end = vttTime(m[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const text = cleanCueText(lines.slice(i + 1).join(" "));
        if (!text) continue;
        cues.push({ start, end, text });
      }
      cues.sort((a, b) => a.start - b.start);
      return ctx.coalesce(cues);
    }

    // ----- track discovery -----

    function domTracks() {
      const out = [];
      document.querySelectorAll("track").forEach(t => {
        const url = t.src || t.getAttribute("src") || "";
        const rawLang = t.srclang || t.getAttribute("srclang") || "";
        if (!url && !rawLang) return;
        out.push({
          url,
          rawLang,
          languageCode: normLang(rawLang),
          kind: isMachine(rawLang, "") ? "asr" : "",
          name: t.label || rawLang || ""
        });
      });
      return out;
    }

    function refreshTracks() {
      const merged = new Map();
      // playerConfig first — it is the authoritative list. DOM <track> elements
      // fill in on vimeo.com watch pages, where playerConfig isn't exposed.
      for (const t of [...configTracks, ...domTracks()]) {
        if (!t.languageCode) continue;
        const key = `${t.languageCode}|${t.kind}`;
        const prev = merged.get(key);
        if (!prev) merged.set(key, t);
        else if (!prev.url && t.url) merged.set(key, { ...prev, url: t.url });
      }
      const next = [...merged.values()];
      const signature = next.map(t => `${t.languageCode}|${t.kind}|${t.url ? 1 : 0}`).join(",");
      if (signature === lastSignature) return;
      lastSignature = signature;
      tracks = next;
      ctx.log("vimeo: tracks →", tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
      ctx.onTrackList(tracks.map(t => ({ languageCode: t.languageCode, kind: t.kind, name: t.name })));
      loadSourceTrack();
    }

    // The track the viewer is actually watching, which becomes our source text:
    // whatever text track the player has switched on, else the config default,
    // else the first one we know about.
    function pickSourceTrack() {
      const v = videoEl();
      if (v && v.textTracks) {
        for (const tt of v.textTracks) {
          if (tt.mode === "disabled") continue;
          const match = tracks.find(t => t.languageCode === normLang(tt.language));
          if (match) return match;
        }
      }
      return tracks.find(t => t.isDefault) || tracks[0] || null;
    }

    function loadSourceTrack() {
      const track = pickSourceTrack();
      if (track) loadTrack(track, "source track");
    }

    // ----- cue loading -----

    async function fetchCues(track) {
      if (track.url) {
        try {
          const res = await fetch(track.url, { credentials: "omit" });
          if (res.ok) {
            const cues = parseVtt(await res.text());
            if (cues.length) return cues;
          }
          ctx.log("vimeo: vtt fetch returned", res.status, "- trying textTracks");
        } catch (e) {
          ctx.log("vimeo: vtt fetch failed, trying textTracks", e);
        }
      }
      return cuesFromTextTrack(track);
    }

    // Fallback for when the signed .vtt URL is expired or unreachable: let the
    // browser parse the track for us. Vimeo draws its own caption strip from a
    // track it keeps at mode "hidden", so nudging a disabled track to "hidden"
    // never puts text on screen — we still restore the original mode after.
    function cuesFromTextTrack(track) {
      return new Promise((resolve) => {
        const v = videoEl();
        if (!v || !v.textTracks || !v.textTracks.length) return resolve([]);
        const tt = Array.from(v.textTracks).find(t => normLang(t.language) === track.languageCode);
        if (!tt) return resolve([]);

        const originalMode = tt.mode;
        probingTextTrack = true;
        if (tt.mode === "disabled") tt.mode = "hidden";

        let waited = 0;
        const iv = setInterval(() => {
          const list = tt.cues ? Array.from(tt.cues) : [];
          waited += 200;
          if (!list.length && waited < 6000) return;
          clearInterval(iv);
          if (originalMode === "disabled" && tt.mode !== "disabled") tt.mode = "disabled";
          probingTextTrack = false;
          resolve(ctx.coalesce(
            list
              .map(c => ({ start: c.startTime, end: c.endTime, text: cleanCueText(c.text || "") }))
              .filter(c => c.text && c.end > c.start)
              .sort((a, b) => a.start - b.start)
          ));
        }, 200);
      });
    }

    async function loadTrack(track, reason) {
      const key = `${track.languageCode}|${track.kind}`;
      if (loadedKeys.has(key)) return;
      loadedKeys.add(key);
      const cues = await fetchCues(track);
      if (!cues.length) {
        loadedKeys.delete(key);   // let a later attempt retry
        ctx.log(`vimeo: no cues for ${track.languageCode} (${reason})`);
        return;
      }
      ctx.log(`vimeo: ${cues.length} cues for ${track.languageCode} (${reason})`);
      ctx.ingest({
        cues,
        lang: track.languageCode,
        isAsr: track.kind === "asr",
        isNativeTarget: track.kind !== "asr" && ctx.langMatches(ctx.settings().secondLang, track.languageCode),
        key: `${key}|${cues.length}|${cues[0].start.toFixed(3)}`
      });
    }

    function nativeLines() {
      const cap = document.querySelector(".vp-captions");
      if (!cap) return [];
      const nodes = cap.querySelectorAll('[class*="captionsLine"]');
      const lines = Array.from(nodes)
        .map(n => (n.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (lines.length) return lines;
      const text = (cap.textContent || "").replace(/\s+/g, " ").trim();
      return text ? [text] : [];
    }

    return {
      id: "vimeo",
      // Vimeo hands us signed .vtt URLs, so we never need the viewer to turn
      // CC on before we can pull a track.
      requiresCcForTracks: false,
      looksLikeVideoPage() {
        // Skips helper frames like player.vimeo.com/static/proxy.html.
        return /^\/(video\/)?\d{6,}/.test(location.pathname)
            || /\/(?:channels|groups|album|showcase)\/[^/]+\/(?:videos\/)?\d{6,}/.test(location.pathname)
            || !!document.querySelector(".vp-video-wrapper, .player.js-player");
      },
      getVideoId() {
        // vimeo.com/859881652/37578b4a4e, player.vimeo.com/video/859881652,
        // vimeo.com/channels/staffpicks/859881652 — take the first long number.
        const seg = location.pathname.split("/").find(s => /^\d{6,}$/.test(s));
        return seg || null;
      },
      getVideoEl: videoEl,
      getContainer() {
        return document.querySelector(".vp-video-wrapper")
            || document.querySelector(".player.js-player")
            || document.querySelector(".player");
      },
      isCcOn() {
        const btn = document.querySelector("#cc-control-bar-button, [data-cc-button], button.cc");
        if (btn && btn.hasAttribute("aria-pressed")) return btn.getAttribute("aria-pressed") === "true";
        // No control bar to read — an embed configured without controls, or a
        // markup change. The player's own track state says the same thing:
        // measured on a live player, captions closed leaves every track
        // "disabled", and opening them puts the active one at "hidden"
        // (Vimeo draws the strip itself rather than letting the browser do it).
        if (probingTextTrack) return null;      // we moved a mode ourselves; don't read it
        const v = videoEl();
        if (v && v.textTracks && v.textTracks.length) {
          return Array.from(v.textTracks).some(t => t.mode !== "disabled");
        }
        return null;
      },
      nativeLines,
      nativeCaptionWidth() {
        const cap = document.querySelector(".vp-captions");
        if (!cap) return 0;
        const lines = cap.querySelectorAll('[class*="captionsLine"]');
        return widestLineWidth(lines.length ? lines : [cap]);
      },
      observeTarget() {
        return document.querySelector(".vp-video-wrapper") || document.querySelector(".player");
      },
      start() {
        injectPageScript("inject-vimeo.js", "yds-inject-vimeo");
        window.addEventListener("YDS_VIMEO_TRACKS", (e) => {
          const list = (e.detail && e.detail.tracks) || [];
          configTracks = list.map(t => ({
            url: t.url || "",
            rawLang: t.lang || "",
            languageCode: normLang(t.lang),
            kind: isMachine(t.lang, t.provenance) ? "asr" : "",
            name: t.label || t.lang || "",
            isDefault: !!t.isDefault
          }));
          refreshTracks();
        });
        // The <track> elements appear once the player boots, and the viewer can
        // switch tracks at any time, so keep looking. The check is one cheap
        // querySelectorAll per second.
        refreshTracks();
        if (!pollTimer) pollTimer = setInterval(refreshTracks, 1000);
      },
      requestTrack(plain) {
        const track = tracks.find(t => t.languageCode === plain.languageCode && t.kind === plain.kind);
        if (track) loadTrack(track, "native target requested");
      },
      // Target language changed: drop the "already fetched" memo so a track we
      // pulled as source text can be pulled again as the target. Keeps the
      // track list, so the next poll re-offers it within a second.
      forgetLoadedCues() {
        loadedKeys.clear();
        lastSignature = "";
      },
      reset() {
        tracks = [];
        configTracks = [];
        lastSignature = "";
        loadedKeys.clear();
      }
    };
  }

  // =========================================================================

  // =========================================================================
  // Bilibili
  // =========================================================================
  //
  // A third way of getting captions, different again from the other two.
  // Bilibili publishes a per-video subtitle index through its own web API
  // rather than putting <track> elements in the page or making the player
  // fetch anything we could intercept, so we ask the API directly and then
  // fetch the track's JSON. Both calls need the viewer's cookies, which is why
  // they run here in the content script rather than anywhere else.
  //
  // Note the subtitle index is usually empty for logged-out viewers — that is
  // the site's behaviour, not a failure on our side. A video with no track at
  // all is exactly the case live transcription exists for.

  function createBilibili(ctx) {
    let tracks = [];          // [{languageCode, kind, name, url}]
    let lastSignature = "";
    let loadTimer = null;
    const loadedKeys = new Set();

    function videoEl() {
      return document.querySelector("#bilibili-player video")
          || document.querySelector(".bpx-player-video-wrap video")
          || document.querySelector("video");
    }

    // BV id plus the part number, so multi-part videos count as separate videos.
    function videoKey() {
      const params = new URL(location.href).searchParams;
      // A BV id is the identity when there is one; otherwise fall back to
      // whatever the URL does identify, so bangumi and festival pages still
      // count as distinct videos rather than as "no video at all".
      const bv = (location.pathname.match(/\/video\/(BV\w+|av\d+)/) || [])[1]
              || (location.pathname.match(/\/bangumi\/play\/(\w+)/) || [])[1]
              || params.get("bvid")
              || (/\/(festival|list)\//.test(location.pathname) ? location.pathname : null);
      if (!bv) return null;
      const p = params.get("p");
      return p && p !== "1" ? `${bv}#p${p}` : bv;
    }

    async function json(url) {
      const r = await fetch(url, { credentials: "include" });
      return r.json();
    }

    // Two hops: the view endpoint gives the cid for this part, the player
    // endpoint gives that part's subtitle list.
    async function fetchTracks() {
      // The subtitle API is keyed by BV id. Bangumi and festival pages don't
      // expose one in the path, so there are no tracks to look up — live
      // transcription is the answer there.
      const bv = (location.pathname.match(/\/video\/(BV\w+)/) || [])[1]
              || new URL(location.href).searchParams.get("bvid");
      if (!bv) return [];
      const view = await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
      let cid = view && view.data && view.data.cid;
      const part = Number(new URL(location.href).searchParams.get("p")) || 1;
      const pages = view && view.data && view.data.pages;
      if (pages && pages[part - 1]) cid = pages[part - 1].cid;
      if (!cid) return [];

      const player = await json(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${cid}`);
      const subs = (player && player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
      return subs.map(sub => {
        let url = String(sub.subtitle_url || "");
        if (url.startsWith("//")) url = "https:" + url;
        url = url.replace(/^http:/, "https:");
        const lan = String(sub.lan || "");
        return {
          url,
          // "ai-zh" marks machine transcription; strip the prefix but keep the
          // rest of the code ("zh-CN", "en-US") so Hans/Hant still separate.
          languageCode: lan.replace(/^ai-/, ""),
          kind: /^ai-/.test(lan) ? "asr" : "",
          name: String(sub.lan_doc || lan)
        };
      }).filter(t => t.url && t.languageCode);
    }

    async function refreshTracks() {
      let next = [];
      try {
        next = await fetchTracks();
      } catch (e) {
        ctx.log("bilibili: subtitle index unavailable", e);
        return;
      }
      const signature = next.map(t => `${t.languageCode}|${t.kind}`).join(",");
      if (signature === lastSignature) return;
      lastSignature = signature;
      tracks = next;
      ctx.log("bilibili: tracks →", tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(", ") || "(none)");
      ctx.onTrackList(tracks.map(t => ({ languageCode: t.languageCode, kind: t.kind, name: t.name })));
    }

    async function loadTrack(track, reason) {
      const key = `${track.languageCode}|${track.kind}`;
      if (loadedKeys.has(key)) return;
      loadedKeys.add(key);
      let data;
      try {
        data = await json(track.url);
      } catch (e) {
        loadedKeys.delete(key);
        ctx.log(`bilibili: could not fetch ${track.languageCode}`, e);
        return;
      }
      // Bilibili's format: { body: [{ from, to, content }] }, times in seconds.
      const cues = ((data && data.body) || [])
        .map(c => ({
          start: Number(c.from) || 0,
          end: Number(c.to) || 0,
          text: cleanCueText(c.content || "")
        }))
        .filter(c => c.text && c.end > c.start)
        .sort((a, b) => a.start - b.start);
      if (!cues.length) {
        loadedKeys.delete(key);
        return;
      }
      ctx.log(`bilibili: ${cues.length} cues for ${track.languageCode} (${reason})`);
      ctx.ingest({
        cues: ctx.coalesce(cues),
        lang: track.languageCode,
        isAsr: track.kind === "asr",
        key: `${key}|${cues.length}|${cues[0].start.toFixed(3)}`
      });
    }

    function subtitleEl() {
      return document.querySelector(".bpx-player-subtitle-panel-wrap")
          || document.querySelector(".bpx-player-subtitle-wrap")
          || document.querySelector(".bilibili-player-video-subtitle");
    }

    return {
      id: "bilibili",
      // We pull tracks straight from the API, so the player's own subtitle
      // switch has no say in whether we can get them.
      requiresCcForTracks: false,
      looksLikeVideoPage() {
        // /video/BV… is the common one, but the same player also serves
        // bangumi episodes, festival pages and playlist views.
        return /\/video\/(BV\w+|av\d+)/.test(location.pathname)
            || /\/(bangumi\/play|festival|list)\//.test(location.pathname);
      },
      getVideoId: videoKey,
      getVideoEl: videoEl,
      getContainer() {
        const v = videoEl();
        if (!v) return null;
        return v.closest(".bpx-player-video-area")
            || v.closest("#bilibili-player")
            || v.parentElement;
      },
      isCcOn() {
        const el = subtitleEl();
        if (!el) return false;
        // The panel stays in the DOM with the switch off, so presence alone
        // proves nothing — go by whether it is actually showing anything.
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        return !!(el.innerText || "").trim();
      },
      nativeLines() {
        const el = subtitleEl();
        if (!el) return [];
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        return text ? [text] : [];
      },
      nativeCaptionWidth() {
        const el = subtitleEl();
        if (!el) return 0;
        const inner = el.querySelectorAll("span, div");
        return widestLineWidth(inner.length ? inner : [el]);
      },
      observeTarget() {
        return document.querySelector("#bilibili-player") || document.body;
      },
      start() {
        refreshTracks();
        // Bilibili is a SPA and the index only appears once the player boots;
        // a slow re-check also picks up a part switch on multi-part videos.
        if (!loadTimer) loadTimer = setInterval(refreshTracks, 3000);
      },
      requestTrack(plain) {
        const track = tracks.find(t => t.languageCode === plain.languageCode && t.kind === plain.kind);
        if (track) loadTrack(track, "requested");
      },
      forgetLoadedCues() {
        loadedKeys.clear();
        lastSignature = "";
      },
      reset() {
        tracks = [];
        lastSignature = "";
        loadedKeys.clear();
      }
    };
  }

  // =========================================================================

  window.YDS_PLATFORMS = {
    detect() {
      const h = location.hostname;
      if (/(^|\.)youtube\.com$/.test(h)) return "youtube";
      if (/(^|\.)vimeo\.com$/.test(h)) return "vimeo";
      if (/(^|\.)bilibili\.com$/.test(h)) return "bilibili";
      return null;
    },
    create(id, ctx) {
      if (id === "youtube") return createYouTube(ctx);
      if (id === "vimeo") return createVimeo(ctx);
      if (id === "bilibili") return createBilibili(ctx);
      return null;
    }
  };
})();
