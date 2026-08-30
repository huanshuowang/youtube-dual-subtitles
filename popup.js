// Popup: reads current tab's caption info, lets the user pick a second
// language and adjust overlay styling. Persists to chrome.storage.sync.

const DEFAULTS = {
  enabled: true,
  secondLang: ydsDefaultSecondLang(),
  bottomOffset: 22,
  captionWidth: 60,
  fontSize: 22,
  color: "#ffffff",
  background: "rgba(0,0,0,0.6)",
  translationProvider: "google",
  uiLang: "auto",
  translationOnly: false,
  paidApiAskEachVideo: false,
  apiKeys: {}
};

// Where users go to grab a key for each provider.
const KEY_LINKS = {
  claude: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  deepseek: "https://platform.deepseek.com/api_keys"
};

const KEY_PLACEHOLDERS = {
  claude: "sk-ant-...",
  openai: "sk-...",
  gemini: "AIza...",
  deepseek: "sk-..."
};

const PROVIDER_NAMES = {
  google: "Google Translate",
  claude: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  get native() { return ydsT("providerNative"); }
};

// Swap static popup text to the active UI language (see ydsSetUiLang).
function localizeStaticDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = ydsT(el.dataset.i18n);
  }
  document.title = ydsT("appTitle");
  $("apiKey").placeholder = ydsT("pasteHere");
  $("apiKeyState").title = ydsT("keyStateTitle");
  $("editApiKey").textContent = ydsT("edit");
}

let activeTabId = null;
let apiKeySaveTimer = null;
let statusPollTimer = null;
let apiKeyEditing = false;

const $ = (id) => document.getElementById(id);

function bgToAlpha(bg) {
  const m = /rgba?\([^)]*,\s*([0-9.]+)\s*\)/.exec(bg || "");
  if (m) return Math.round(parseFloat(m[1]) * 100);
  return 60;
}
function alphaToBg(a) {
  const v = Math.max(0, Math.min(100, a)) / 100;
  return `rgba(0,0,0,${v.toFixed(2)})`;
}

const SUPPORTED_URL = /^https?:\/\/(www\.youtube\.com|(player\.)?vimeo\.com|www\.bilibili\.com)\//;

// Info from the last probe in getActiveSupportedTab, so we don't message the
// page twice on open.
let probedInfo = null;

async function getActiveSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  activeTabUrl = tab.url || "";
  if (tab.url && SUPPORTED_URL.test(tab.url)) return tab;
  // A YouTube/Vimeo player embedded in someone else's page — a course site, a
  // blog. The tab's own URL is not ours, but the content script is alive in the
  // player's frame and answers, so ask before giving up.
  probedInfo = await askContent(tab.id);
  return probedInfo && probedInfo.videoId ? tab : null;
}

// The content script reports which adapter booted; fall back to YouTube so a
// page we can't reach still reads sensibly.
const PLATFORM_NAMES = { youtube: "YouTube", vimeo: "Vimeo", bilibili: "Bilibili" };

// The tab we last found, so a name is still available when the page never
// answered — which is exactly when we most need to name it, since "refresh the
// YouTube page" on a Bilibili tab is worse than saying nothing.
let activeTabUrl = "";

function platformFromUrl(url) {
  if (/^https?:\/\/(www\.)?bilibili\.com\//.test(url || "")) return "bilibili";
  if (/^https?:\/\/(player\.)?vimeo\.com\//.test(url || "")) return "vimeo";
  if (/^https?:\/\/(www\.)?youtube\.com\//.test(url || "")) return "youtube";
  return "";
}

function platformName(info) {
  const id = (info && info.platform) || platformFromUrl(activeTabUrl);
  return PLATFORM_NAMES[id] || "YouTube";
}

async function askContent(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "YDS_GET_INFO" }, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch { resolve(null); }
  });
}

async function sendContent(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch { resolve(null); }
  });
}

function populateLanguages(info) {
  const sel = $("lang");
  sel.innerHTML = "";

  const seen = new Set();
  const add = (code, label) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    sel.appendChild(opt);
  };

  add("", ydsT("offSecondSub"));

  // Native tracks on this video first.
  if (info?.tracks?.length) {
    const group = document.createElement("optgroup");
    group.label = ydsT("groupNative");
    sel.appendChild(group);
    for (const t of info.tracks) {
      const opt = document.createElement("option");
      opt.value = t.languageCode;
      opt.textContent = `${t.name} (${t.languageCode})${t.kind === "asr" ? ydsT("asrSuffix") : ""}`;
      group.appendChild(opt);
      seen.add(t.languageCode);
    }
  }

  // Auto-translation targets.
  if (info?.translations?.length) {
    const group = document.createElement("optgroup");
    group.label = ydsT("groupAutoTranslate");
    sel.appendChild(group);
    for (const t of info.translations) {
      if (seen.has(t.languageCode)) continue;
      const opt = document.createElement("option");
      opt.value = t.languageCode;
      opt.textContent = `${t.languageName} (${t.languageCode})`;
      group.appendChild(opt);
      seen.add(t.languageCode);
    }
  }

  // Common fallbacks so the picker isn't empty on non-video pages.
  const commons = [
    ["zh-Hans", "中文（简体）"],
    ["zh-Hant", "中文（繁體）"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["es", "Español"],
    ["fr", "Français"],
    ["de", "Deutsch"]
  ];
  const commonGroup = document.createElement("optgroup");
  commonGroup.label = ydsT("groupCommon");
  sel.appendChild(commonGroup);
  for (const [c, n] of commons) {
    if (seen.has(c)) continue;
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${n} (${c})`;
    commonGroup.appendChild(opt);
    seen.add(c);
  }

  // Full Google Translate language list.
  const allGroup = document.createElement("optgroup");
  allGroup.label = ydsT("groupAll");
  sel.appendChild(allGroup);
  for (const [c, n] of ALL_LANGS) {
    if (seen.has(c)) continue;
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${n} (${c})`;
    allGroup.appendChild(opt);
    seen.add(c);
  }
}

// Google Translate supported languages. Local name + English name for
// recognition. Codes are the ones Google Translate accepts (a few — zh-Hans,
// zh-Hant, iw, jw — are remapped in content.js's toGoogleLang).
const ALL_LANGS = [
  ["af", "Afrikaans"],
  ["sq", "Shqip · Albanian"],
  ["am", "አማርኛ · Amharic"],
  ["ar", "العربية · Arabic"],
  ["hy", "Հայերեն · Armenian"],
  ["as", "অসমীয়া · Assamese"],
  ["ay", "Aymar · Aymara"],
  ["az", "Azərbaycan · Azerbaijani"],
  ["bm", "Bamanankan · Bambara"],
  ["eu", "Euskara · Basque"],
  ["be", "Беларуская · Belarusian"],
  ["bn", "বাংলা · Bengali"],
  ["bho", "भोजपुरी · Bhojpuri"],
  ["bs", "Bosanski · Bosnian"],
  ["bg", "Български · Bulgarian"],
  ["ca", "Català · Catalan"],
  ["ceb", "Cebuano"],
  ["ny", "Chichewa"],
  ["co", "Corsu · Corsican"],
  ["hr", "Hrvatski · Croatian"],
  ["cs", "Čeština · Czech"],
  ["da", "Dansk · Danish"],
  ["dv", "ދިވެހި · Dhivehi"],
  ["doi", "डोगरी · Dogri"],
  ["nl", "Nederlands · Dutch"],
  ["eo", "Esperanto"],
  ["et", "Eesti · Estonian"],
  ["ee", "Eʋegbe · Ewe"],
  ["fil", "Filipino / Tagalog"],
  ["fi", "Suomi · Finnish"],
  ["fy", "Frysk · Frisian"],
  ["gl", "Galego · Galician"],
  ["ka", "ქართული · Georgian"],
  ["el", "Ελληνικά · Greek"],
  ["gn", "Avañe'ẽ · Guarani"],
  ["gu", "ગુજરાતી · Gujarati"],
  ["ht", "Kreyòl · Haitian Creole"],
  ["ha", "Hausa"],
  ["haw", "ʻŌlelo Hawaiʻi · Hawaiian"],
  ["he", "עברית · Hebrew"],
  ["hi", "हिन्दी · Hindi"],
  ["hmn", "Hmoob · Hmong"],
  ["hu", "Magyar · Hungarian"],
  ["is", "Íslenska · Icelandic"],
  ["ig", "Igbo"],
  ["ilo", "Ilokano · Ilocano"],
  ["id", "Bahasa Indonesia · Indonesian"],
  ["ga", "Gaeilge · Irish"],
  ["it", "Italiano · Italian"],
  ["jv", "Basa Jawa · Javanese"],
  ["kn", "ಕನ್ನಡ · Kannada"],
  ["kk", "Қазақша · Kazakh"],
  ["km", "ខ្មែរ · Khmer"],
  ["rw", "Kinyarwanda"],
  ["gom", "कोंकणी · Konkani"],
  ["kri", "Krio"],
  ["ku", "Kurdî · Kurdish (Kurmanji)"],
  ["ckb", "کوردی · Kurdish (Sorani)"],
  ["ky", "Кыргызча · Kyrgyz"],
  ["lo", "ລາວ · Lao"],
  ["la", "Latina · Latin"],
  ["lv", "Latviešu · Latvian"],
  ["ln", "Lingála · Lingala"],
  ["lt", "Lietuvių · Lithuanian"],
  ["lg", "Luganda"],
  ["lb", "Lëtzebuergesch · Luxembourgish"],
  ["mk", "Македонски · Macedonian"],
  ["mai", "मैथिली · Maithili"],
  ["mg", "Malagasy"],
  ["ms", "Bahasa Melayu · Malay"],
  ["ml", "മലയാളം · Malayalam"],
  ["mt", "Malti · Maltese"],
  ["mi", "Māori"],
  ["mr", "मराठी · Marathi"],
  ["mni-Mtei", "ꯃꯤꯇꯩ ꯂꯣꯟ · Meiteilon"],
  ["lus", "Mizo"],
  ["mn", "Монгол · Mongolian"],
  ["my", "မြန်မာ · Myanmar (Burmese)"],
  ["ne", "नेपाली · Nepali"],
  ["no", "Norsk · Norwegian"],
  ["or", "ଓଡ଼ିଆ · Odia (Oriya)"],
  ["om", "Afaan Oromoo · Oromo"],
  ["ps", "پښتو · Pashto"],
  ["fa", "فارسی · Persian"],
  ["pl", "Polski · Polish"],
  ["pt", "Português · Portuguese"],
  ["pa", "ਪੰਜਾਬੀ · Punjabi"],
  ["qu", "Runa Simi · Quechua"],
  ["ro", "Română · Romanian"],
  ["ru", "Русский · Russian"],
  ["sm", "Gagana Samoa · Samoan"],
  ["sa", "संस्कृतम् · Sanskrit"],
  ["gd", "Gàidhlig · Scots Gaelic"],
  ["nso", "Sepedi"],
  ["sr", "Српски · Serbian"],
  ["st", "Sesotho"],
  ["sn", "Shona"],
  ["sd", "سنڌي · Sindhi"],
  ["si", "සිංහල · Sinhala"],
  ["sk", "Slovenčina · Slovak"],
  ["sl", "Slovenščina · Slovenian"],
  ["so", "Soomaali · Somali"],
  ["su", "Basa Sunda · Sundanese"],
  ["sw", "Kiswahili · Swahili"],
  ["sv", "Svenska · Swedish"],
  ["tg", "Тоҷикӣ · Tajik"],
  ["ta", "தமிழ் · Tamil"],
  ["tt", "Татарча · Tatar"],
  ["te", "తెలుగు · Telugu"],
  ["th", "ไทย · Thai"],
  ["ti", "ትግርኛ · Tigrinya"],
  ["ts", "Xitsonga · Tsonga"],
  ["tr", "Türkçe · Turkish"],
  ["tk", "Türkmen · Turkmen"],
  ["ak", "Twi (Akan)"],
  ["uk", "Українська · Ukrainian"],
  ["ur", "اردو · Urdu"],
  ["ug", "ئۇيغۇرچە · Uyghur"],
  ["uz", "Oʻzbek · Uzbek"],
  ["vi", "Tiếng Việt · Vietnamese"],
  ["cy", "Cymraeg · Welsh"],
  ["xh", "isiXhosa · Xhosa"],
  ["yi", "ייִדיש · Yiddish"],
  ["yo", "Yorùbá · Yoruba"],
  ["zu", "isiZulu · Zulu"]
];

async function save(partial) {
  const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const merged = { ...DEFAULTS, ...cur, ...partial };
  await chrome.storage.sync.set({ ydsSettings: merged });
}

// Update just the API key for the currently selected provider.
async function saveApiKey(provider, value) {
  const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const apiKeys = { ...(cur.apiKeys || {}) };
  if (value) apiKeys[provider] = value;
  else delete apiKeys[provider];
  await chrome.storage.sync.set({ ydsSettings: { ...DEFAULTS, ...cur, apiKeys } });
}

function applyProviderUI(settings) {
  const p = $("provider").value;
  const needsKey = p !== "google";
  $("apiKeyRow").style.display = needsKey ? "" : "none";
  $("apiKeyHelp").style.display = needsKey ? "" : "none";
  $("paidControls").style.display = needsKey ? "block" : "none";
  $("askPaidRow").style.display = needsKey ? "flex" : "none";
  $("askPaidApi").checked = !!settings.paidApiAskEachVideo;
  $("translationOnly").checked = !!settings.translationOnly;
  if (needsKey) {
    const keys = settings.apiKeys || {};
    const key = keys[p] || "";
    $("apiKey").value = key;
    $("apiKey").placeholder = KEY_PLACEHOLDERS[p] || ydsT("pasteHere");
    $("apiKeyLink").href = KEY_LINKS[p] || "#";
    $("apiKeyLink").textContent = ydsT("getKeyLink", { name: PROVIDER_NAMES[p] || p });
    $("usePaidApi").textContent = ydsT("usePaidApiBtn", { name: providerName(p) });
    setApiKeyEditing(!key);
    updateApiKeyState(!!key);
  }
}

function setApiKeyEditing(editing) {
  apiKeyEditing = editing;
  const input = $("apiKey");
  input.disabled = !editing && !!input.value;
  $("editApiKey").textContent = editing ? ydsT("done") : ydsT("edit");
  if (editing) setTimeout(() => input.focus(), 0);
}

function updateApiKeyState(hasKey) {
  const el = $("apiKeyState");
  el.textContent = hasKey ? "✓" : "!";
  el.className = `keyState ${hasKey ? "ok" : "missing"}`;
  el.title = hasKey ? ydsT("keySavedTitle") : ydsT("keyMissingTitle");
}

function providerName(provider) {
  return PROVIDER_NAMES[provider] || provider || ydsT("providerUnknown");
}

function statusTextFor(info, tab) {
  if (!tab) return ydsT("statusNoTab");
  if (!info || !info.videoId) return ydsT("statusNoComm", { platform: platformName(info) });

  // Live transcription owns the overlay while it runs, so every message below
  // would be describing a subtitle track the viewer isn't looking at — saying
  // "no subtitles picked up yet" while captions are visibly on screen.
  if (info.live && info.live.active) {
    if (info.live.status === "connecting") return ydsT("liveConnecting");
    if (info.live.status === "listening") return ydsT("statusLiveRunning");
    return ydsT("liveUnavailable");
  }

  const st = info.translationStatus || {};
  if (st.mode === "native" || info.usingNativeTrack) {
    return ydsT("statusNative", { lang: $("lang").value || ydsT("statusNativeFallbackLang") });
  }
  if (st.mode === "translated") {
    return ydsT("statusDone", { name: providerName(st.provider), count: st.cueCount || 0 });
  }
  if (st.mode === "translating") {
    const done = st.translatedCount || 0;
    const total = st.totalCount || st.cueCount || 0;
    const progress = total ? ydsT("progressFmt", { done, total }) : "";
    return ydsT("statusTranslating", { name: providerName(st.provider), progress });
  }
  if (st.mode === "fallback") {
    if (st.declined || (st.error || "").startsWith("用户取消")) {
      return ydsT("statusCancelledFallback", { name: providerName(st.requestedProvider) });
    }
    return ydsT("statusFallback", {
      name: providerName(st.requestedProvider),
      error: st.error ? ydsT("errorPrefix") + st.error : ""
    });
  }
  if (st.mode === "awaiting_paid_confirmation") {
    return ydsT("statusAwaiting", { name: providerName(st.requestedProvider) });
  }
  if (st.mode === "need_api_key") {
    return ydsT("statusNeedKey", { name: providerName(st.requestedProvider) });
  }
  if (st.mode === "error") {
    return ydsT("statusError", {
      name: providerName(st.requestedProvider || st.provider),
      error: st.error || ydsT("unknownError")
    });
  }
  if (info.nativeCaptionText) {
    return ydsT("statusDetected", { platform: platformName(info) });
  }
  // In translation-only mode the CC prompt would be wrong — that's the whole
  // point of the mode. But if we still have no subtitles, say so plainly and
  // give the one workaround that always works.
  if ($("translationOnly").checked) {
    return info.preCuesLoaded ? ydsT("statusTranslationOnly") : ydsT("statusTranslationOnlyNeedsCc");
  }
  // Vimeo and Bilibili hand us the track without the player's help, so their
  // caption switch is optional — but on Bilibili "no track" is common enough
  // to be worth naming, along with the sign-in caveat behind it.
  if (info.platform === "bilibili") {
    return (info.tracks && info.tracks.length)
      ? ydsT("statusBilibiliReading")
      : ydsT("statusBilibiliNoTrack");
  }
  if (info.platform === "vimeo") return ydsT("statusVimeoReading");
  return ydsT("statusTurnOnCC");
}

async function refreshStatusSoon(delay = 900) {
  if (!activeTabId) return;
  setTimeout(async () => {
    const info = await askContent(activeTabId);
    $("status").textContent = statusTextFor(info, { id: activeTabId });
  }, delay);
}

function refreshStatusSeries() {
  refreshStatusSoon(900);
  refreshStatusSoon(2500);
  refreshStatusSoon(6000);
}

function startStatusPolling() {
  if (!activeTabId || statusPollTimer) return;
  statusPollTimer = setInterval(async () => {
    const info = await askContent(activeTabId);
    $("status").textContent = statusTextFor(info, { id: activeTabId });
    const mode = info?.translationStatus?.mode;
    if (mode && mode !== "translating" && mode !== "awaiting_paid_confirmation") {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }, 1000);
}


// ---------- tabs + live transcription ----------

const SETUP_URL = "https://huanshuowang.com/happysubs/#live";

function selectTab(which) {
  const live = which === "live";
  $("tabLive").setAttribute("aria-selected", String(live));
  $("tabTranslate").setAttribute("aria-selected", String(!live));
  $("panelLive").hidden = !live;
  $("panelTranslate").hidden = live;
  try { localStorage.setItem("yds-popup-tab", which); } catch {}
}

// The live panel says one of three things: what the feature is (before you
// start), how it is going (once running), or what went wrong — with the setup
// link attached whenever the answer is "the recogniser isn't there".
function renderLivePanel(info) {
  const st = (info && info.live) || { active: false, status: "stopped" };
  const running = !!st.active;
  $("liveToggle").textContent = ydsT(running ? "liveStop" : "liveStart");

  let msg;
  let showSetup = false;
  if (!running) {
    msg = ydsT("liveIdle");
    showSetup = true;
  } else if (st.status === "connecting") {
    msg = ydsT("liveConnecting");
  } else if (st.status === "listening") {
    msg = ydsT("liveListening");
    // Worth saying: a track was found, so the transcription is sitting idle.
    if (info && info.preCuesLoaded) msg += " " + ydsT("liveHasTrack");
  } else {
    msg = ydsT("liveUnavailable");
    showSetup = true;
  }

  const el = $("liveStatus");
  el.textContent = msg;
  if (showSetup) {
    el.appendChild(document.createTextNode(" "));
    const a = document.createElement("a");
    a.href = SETUP_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = ydsT("liveSetupLink");
    el.appendChild(a);
  }
}

const LIVE_ERRORS = {
  "no-video": "liveNoVideo",
  "capture-failed": "liveCaptureFailed",
  "no-platform": "liveNoVideo"
};

async function toggleLive(info) {
  if (!activeTabId) return;
  const running = !!(info && info.live && info.live.active);
  const res = await sendContent(activeTabId, { type: running ? "YDS_LIVE_STOP" : "YDS_LIVE_START" });
  if (res && res.ok === false) {
    $("liveStatus").textContent = ydsT(LIVE_ERRORS[res.error] || "liveUnavailable");
    return;
  }
  // Give the socket a moment to land on connected-or-not before re-reading.
  setTimeout(async () => {
    const fresh = await askContent(activeTabId);
    renderLivePanel(fresh);
  }, 600);
  renderLivePanel({ live: { active: !running, status: running ? "stopped" : "connecting" } });
}

async function init() {
  const stored = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const settings = { ...DEFAULTS, ...stored };

  // Panel language before anything is painted. Localizing first and reading the
  // setting afterwards would flash the browser-default language on every open.
  ydsSetUiLang(settings.uiLang);
  localizeStaticDom();

  $("enabled").checked = !!settings.enabled;
  $("bottomOffset").value = settings.bottomOffset;
  $("bottomOffsetVal").textContent = `${settings.bottomOffset}%`;
  $("captionWidth").value = settings.captionWidth;
  $("captionWidthVal").textContent = `${settings.captionWidth}%`;
  $("fontSize").value = settings.fontSize;
  $("color").value = settings.color;
  $("bgAlpha").value = bgToAlpha(settings.background);
  $("provider").value = settings.translationProvider || "google";
  $("askPaidApi").checked = !!settings.paidApiAskEachVideo;
  applyProviderUI(settings);

  const tab = await getActiveSupportedTab();
  activeTabId = tab ? tab.id : null;
  let info = probedInfo;
  if (tab && !info) info = await askContent(tab.id);

  populateLanguages(info);
  $("lang").value = settings.secondLang || "";

  if (!tab) {
    $("videoInfo").textContent = "";
  } else if (info && info.videoId) {
    $("videoInfo").textContent = info.videoId;
  }
  $("status").textContent = statusTextFor(info, tab);
  renderLivePanel(info);
  let savedTab = "translate";
  try { savedTab = localStorage.getItem("yds-popup-tab") || "translate"; } catch {}
  selectTab(savedTab);
  if (info?.translationStatus?.mode === "translating") startStatusPolling();

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("tabTranslate").addEventListener("click", () => selectTab("translate"));
  $("tabLive").addEventListener("click", () => selectTab("live"));
  $("liveToggle").addEventListener("click", async () => {
    const fresh = activeTabId ? await askContent(activeTabId) : null;
    toggleLive(fresh);
  });

  $("translationOnly").addEventListener("change", async (e) => {
    await save({ translationOnly: e.target.checked });
    refreshStatusSoon(300);
  });
  $("lang").addEventListener("change", async (e) => {
    await save({ secondLang: e.target.value });
    $("status").textContent = ydsT("statusLangSwitched");
    refreshStatusSeries();
    startStatusPolling();
  });
  $("captionWidth").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("captionWidthVal").textContent = `${v}%`;
    save({ captionWidth: v });
  });
  $("bottomOffset").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    $("bottomOffsetVal").textContent = `${v}%`;
    save({ bottomOffset: v });
  });
  $("fontSize").addEventListener("change", (e) => save({ fontSize: parseInt(e.target.value, 10) || 22 }));
  $("color").addEventListener("change", (e) => save({ color: e.target.value }));
  $("bgAlpha").addEventListener("input", (e) => save({ background: alphaToBg(parseInt(e.target.value, 10)) }));

  $("provider").addEventListener("change", async (e) => {
    await save({ translationProvider: e.target.value });
    const cur = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
    applyProviderUI({ ...DEFAULTS, ...cur });
    $("status").textContent = ydsT("statusProviderSwitched", { name: providerName(e.target.value) });
    refreshStatusSeries();
    startStatusPolling();
  });
  $("askPaidApi").addEventListener("change", async (e) => {
    await save({ paidApiAskEachVideo: e.target.checked });
    $("status").textContent = e.target.checked ? ydsT("askOn") : ydsT("askOff");
  });
  $("usePaidApi").addEventListener("click", async () => {
    if (!activeTabId) return;
    const provider = $("provider").value;
    $("status").textContent = ydsT("statusStartingPaid", { name: providerName(provider) });
    const resp = await sendContent(activeTabId, { type: "YDS_APPROVE_PAID_API" });
    if (!resp?.ok) {
      $("status").textContent = resp?.error || ydsT("statusPaidFailed");
      return;
    }
    refreshStatusSeries();
    startStatusPolling();
  });
  $("editApiKey").addEventListener("click", async () => {
    if (apiKeyEditing) {
      const value = $("apiKey").value.trim();
      await saveApiKey($("provider").value, value);
      updateApiKeyState(!!value);
      setApiKeyEditing(false);
      $("status").textContent = value
        ? ydsT("keySaved", { name: providerName($("provider").value) })
        : ydsT("keyCleared", { name: providerName($("provider").value) });
    } else {
      setApiKeyEditing(true);
    }
  });
  $("apiKey").addEventListener("click", () => {
    if ($("apiKey").disabled) setApiKeyEditing(true);
  });
  $("apiKey").addEventListener("input", (e) => {
    updateApiKeyState(!!e.target.value.trim());
    if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
    apiKeySaveTimer = setTimeout(async () => {
      await saveApiKey($("provider").value, e.target.value.trim());
      $("status").textContent = ydsT("keySaved", { name: providerName($("provider").value) });
    }, 500);
  });
  $("apiKey").addEventListener("change", async (e) => {
    if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
    const value = e.target.value.trim();
    await saveApiKey($("provider").value, value);
    updateApiKeyState(!!value);
    $("status").textContent = value
      ? ydsT("keySaved", { name: providerName($("provider").value) })
      : ydsT("keyCleared", { name: providerName($("provider").value) });
  });
}

init().catch((err) => {
  $("status").textContent = ydsT("initFailed") + (err?.message || err);
});
