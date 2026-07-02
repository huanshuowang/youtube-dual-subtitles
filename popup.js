// Popup: reads current tab's caption info, lets the user pick a second
// language and adjust overlay styling. Persists to chrome.storage.sync.

const DEFAULTS = {
  enabled: true,
  secondLang: "zh-Hans",
  bottomOffset: 22,
  fontSize: 22,
  color: "#ffffff",
  background: "rgba(0,0,0,0.6)",
  translationProvider: "google",
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
  native: "视频自带字幕"
};

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

async function getActiveYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\/www\.youtube\.com\//.test(tab.url)) return null;
  return tab;
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

  add("", "— 关闭第二字幕 —");

  // Native tracks on this video first.
  if (info?.tracks?.length) {
    const group = document.createElement("optgroup");
    group.label = "该视频原生字幕";
    sel.appendChild(group);
    for (const t of info.tracks) {
      const opt = document.createElement("option");
      opt.value = t.languageCode;
      opt.textContent = `${t.name} (${t.languageCode})${t.kind === "asr" ? " · 自动生成" : ""}`;
      group.appendChild(opt);
      seen.add(t.languageCode);
    }
  }

  // Auto-translation targets.
  if (info?.translations?.length) {
    const group = document.createElement("optgroup");
    group.label = "自动翻译";
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
  commonGroup.label = "常用";
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
  allGroup.label = "全部语言";
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
  if (needsKey) {
    const keys = settings.apiKeys || {};
    const key = keys[p] || "";
    $("apiKey").value = key;
    $("apiKey").placeholder = KEY_PLACEHOLDERS[p] || "粘贴到这里";
    $("apiKeyLink").href = KEY_LINKS[p] || "#";
    $("apiKeyLink").textContent = `获取 ${PROVIDER_NAMES[p] || p} key →`;
    $("usePaidApi").textContent = `本视频使用 ${providerName(p)} API 翻译`;
    setApiKeyEditing(!key);
    updateApiKeyState(!!key);
  }
}

function setApiKeyEditing(editing) {
  apiKeyEditing = editing;
  const input = $("apiKey");
  input.disabled = !editing && !!input.value;
  $("editApiKey").textContent = editing ? "完成" : "编辑";
  if (editing) setTimeout(() => input.focus(), 0);
}

function updateApiKeyState(hasKey) {
  const el = $("apiKeyState");
  el.textContent = hasKey ? "✓" : "!";
  el.className = `keyState ${hasKey ? "ok" : "missing"}`;
  el.title = hasKey ? "已保存 API Key" : "尚未填写 API Key";
}

function providerName(provider) {
  return PROVIDER_NAMES[provider] || provider || "未知";
}

function statusTextFor(info, tab) {
  if (!tab) return "打开 www.youtube.com 上的视频页面即可使用。";
  if (!info || !info.videoId) return "无法与页面通信。请刷新 YouTube 页面后再试。";

  const st = info.translationStatus || {};
  if (st.mode === "native" || info.usingNativeTrack) {
    return `当前使用：视频自带 ${$("lang").value || "目标语言"} 字幕（未调用翻译 API）。`;
  }
  if (st.mode === "translated") {
    return `已完成：${providerName(st.provider)} 翻译，已加载 ${st.cueCount || 0} 条字幕。`;
  }
  if (st.mode === "translating") {
    const done = st.translatedCount || 0;
    const total = st.totalCount || st.cueCount || 0;
    const progress = total ? `（${done}/${total}）` : "";
    return `正在调用：${providerName(st.provider)} API 翻译字幕${progress}…`;
  }
  if (st.mode === "fallback") {
    if ((st.error || "").startsWith("用户取消")) {
      return `当前使用：Google Translate（已取消 ${providerName(st.requestedProvider)} API）。`;
    }
    return `当前使用：Google Translate（${providerName(st.requestedProvider)} 调用失败后回退）。${st.error ? "错误：" + st.error : ""}`;
  }
  if (st.mode === "awaiting_paid_confirmation") {
    return `等待确认：点击上方按钮后，本视频才会使用 ${providerName(st.requestedProvider)} API。未确认前使用免费 Google Translate。`;
  }
  if (st.mode === "need_api_key") {
    return `${providerName(st.requestedProvider)} 需要 API Key。未填写前会使用免费 Google Translate。`;
  }
  if (st.mode === "error") {
    return `${providerName(st.requestedProvider || st.provider)} 翻译失败：${st.error || "未知错误"}`;
  }
  if (info.nativeCaptionText) {
    return "已检测到 YouTube 字幕。选择翻译源并填写 key 后，页面会自动重新翻译；当前还没有完成翻译。";
  }
  return "请先点开 YouTube 播放器右下角的 CC 按钮开启原生字幕，扩展会自动翻译并叠加第二种语言。";
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

async function init() {
  const stored = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const settings = { ...DEFAULTS, ...stored };

  $("enabled").checked = !!settings.enabled;
  $("bottomOffset").value = settings.bottomOffset;
  $("bottomOffsetVal").textContent = `${settings.bottomOffset}%`;
  $("fontSize").value = settings.fontSize;
  $("color").value = settings.color;
  $("bgAlpha").value = bgToAlpha(settings.background);
  $("provider").value = settings.translationProvider || "google";
  $("askPaidApi").checked = !!settings.paidApiAskEachVideo;
  applyProviderUI(settings);

  const tab = await getActiveYouTubeTab();
  activeTabId = tab ? tab.id : null;
  let info = null;
  if (tab) info = await askContent(tab.id);

  populateLanguages(info);
  $("lang").value = settings.secondLang || "";

  if (!tab) {
    $("videoInfo").textContent = "";
  } else if (info && info.videoId) {
    $("videoInfo").textContent = info.videoId;
  }
  $("status").textContent = statusTextFor(info, tab);
  if (info?.translationStatus?.mode === "translating") startStatusPolling();

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("lang").addEventListener("change", async (e) => {
    await save({ secondLang: e.target.value });
    $("status").textContent = "已切换目标语言。页面正在重新检测 native 字幕或翻译…";
    refreshStatusSeries();
    startStatusPolling();
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
    $("status").textContent = `已切换为 ${providerName(e.target.value)}。未点击确认前不会调用付费 API。`;
    refreshStatusSeries();
    startStatusPolling();
  });
  $("askPaidApi").addEventListener("change", async (e) => {
    await save({ paidApiAskEachVideo: e.target.checked });
    $("status").textContent = e.target.checked
      ? "已开启：每次打开视频会自动询问是否使用付费 API。"
      : "已关闭：付费 API 只会在你点击“本视频使用所选 API 翻译”后调用。";
  });
  $("usePaidApi").addEventListener("click", async () => {
    if (!activeTabId) return;
    const provider = $("provider").value;
    $("status").textContent = `正在为本视频启动 ${providerName(provider)} API 翻译…`;
    const resp = await sendContent(activeTabId, { type: "YDS_APPROVE_PAID_API" });
    if (!resp?.ok) {
      $("status").textContent = resp?.error || "无法启动付费 API。请确认页面已打开字幕并刷新后重试。";
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
        ? `已保存 ${providerName($("provider").value)} API Key。需要点击上方按钮才会调用。`
        : `${providerName($("provider").value)} API Key 已清空。`;
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
      $("status").textContent = `已保存 ${providerName($("provider").value)} API Key。需要点击上方按钮才会调用。`;
    }, 500);
  });
  $("apiKey").addEventListener("change", async (e) => {
    if (apiKeySaveTimer) clearTimeout(apiKeySaveTimer);
    const value = e.target.value.trim();
    await saveApiKey($("provider").value, value);
    updateApiKeyState(!!value);
    $("status").textContent = value
      ? `已保存 ${providerName($("provider").value)} API Key。需要点击上方按钮才会调用。`
      : `${providerName($("provider").value)} API Key 已清空。`;
  });
}

init().catch((err) => {
  $("status").textContent = "初始化失败：" + (err?.message || err);
});
