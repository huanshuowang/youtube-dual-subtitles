// Options page. Everything here writes to the same chrome.storage.sync record
// the popup uses, so the two stay in step automatically — the popup re-reads on
// open, and content scripts get storage.onChanged.

const $ = (id) => document.getElementById(id);

// Only the keys this page owns; the rest of the record is left untouched.
const DEFAULTS = {
  uiLang: "auto",
  enabled: true,
  translationOnly: false
};

function applyI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = ydsT(el.dataset.i18n);
  }
  document.title = ydsT("optionsTitle");
}

function readSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["ydsSettings"], (r) => {
      resolve({ ...DEFAULTS, ...((r && r.ydsSettings) || {}) });
    });
  });
}

// Merge rather than overwrite: the popup owns most of this record.
function save(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["ydsSettings"], (r) => {
      const merged = { ...((r && r.ydsSettings) || {}), ...patch };
      chrome.storage.sync.set({ ydsSettings: merged }, () => resolve());
    });
  });
}

let savedTimer = null;
function flashSaved() {
  const el = $("saved");
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

(async function main() {
  const settings = await readSettings();

  ydsSetUiLang(settings.uiLang);
  applyI18n();

  $("uiLang").value = settings.uiLang;
  $("enabled").checked = !!settings.enabled;
  $("translationOnly").checked = !!settings.translationOnly;

  $("uiLang").addEventListener("change", async (e) => {
    const value = e.target.value;
    await save({ uiLang: value });
    // Re-render in place so the choice is visible immediately.
    ydsSetUiLang(value);
    applyI18n();
    flashSaved();
  });

  $("enabled").addEventListener("change", async (e) => {
    await save({ enabled: e.target.checked });
    flashSaved();
  });

  $("translationOnly").addEventListener("change", async (e) => {
    await save({ translationOnly: e.target.checked });
    flashSaved();
  });

  // Someone toggling the same switches in the popup while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.ydsSettings) return;
    const next = { ...DEFAULTS, ...(changes.ydsSettings.newValue || {}) };
    if ($("uiLang").value !== next.uiLang) {
      $("uiLang").value = next.uiLang;
      ydsSetUiLang(next.uiLang);
      applyI18n();
    }
    $("enabled").checked = !!next.enabled;
    $("translationOnly").checked = !!next.translationOnly;
  });
})();
