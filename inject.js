// Runs in the page's main world. Patches window.fetch and XMLHttpRequest so
// that whenever YouTube's own player requests a timedtext (caption) URL, we
// forward the raw response body to the content script. This lets us obtain
// the full caption track (with valid PoT token) that we can't fetch ourselves.
(function () {
  if (window.__ydsInjected) return;
  window.__ydsInjected = true;
  const EVT = "YDS_TIMEDTEXT";

  function report(url, text) {
    if (!text || typeof text !== "string") return;
    if (text.length < 5) return;
    try {
      window.dispatchEvent(new CustomEvent(EVT, { detail: { url: String(url), text } }));
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
})();
