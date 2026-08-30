// Runs in the page's main world on player.vimeo.com.
//
// One job: publish window.playerConfig.request.text_tracks, which is the
// authoritative list of every caption track on the clip — id, language, label,
// provenance, and the signed .vtt URL for each.
//
// The <track> elements in the DOM cover the common case, but the player only
// materialises the ones it has decided to use. This global is the full set.
// It only exists on the player origin; on vimeo.com watch pages this script
// finds nothing and the content script falls back to the DOM.
(function () {
  if (window.__ydsVimeoInjected) return;
  window.__ydsVimeoInjected = true;

  function readConfig() {
    const cfg = window.playerConfig || window._playerConfig;
    const list = cfg && cfg.request && cfg.request.text_tracks;
    return Array.isArray(list) && list.length ? list : null;
  }

  let lastSignature = "";

  function publish() {
    const list = readConfig();
    if (!list) return false;
    const tracks = list.map(t => ({
      url: t.url || "",
      lang: t.lang || "",
      kind: t.kind || "",
      label: t.label || "",
      provenance: t.provenance || "",
      isDefault: !!t.default
    }));
    const signature = tracks.map(t => `${t.lang}|${t.url}`).join(",");
    if (signature === lastSignature) return true;
    lastSignature = signature;
    try {
      window.dispatchEvent(new CustomEvent("YDS_VIMEO_TRACKS", { detail: { tracks } }));
    } catch {}
    return true;
  }

  // The config lands during player boot; poll briefly, then keep a slow watch
  // so a re-signed URL or a newly added track still reaches the content script.
  if (!publish()) {
    let attempts = 0;
    const boot = setInterval(() => {
      if (publish() || ++attempts > 30) clearInterval(boot);
    }, 400);
  }
  setInterval(publish, 5000);
})();
