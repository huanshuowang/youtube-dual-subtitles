// Popup: reads current tab's caption info, lets the user pick a second
// language and adjust overlay styling. Persists to chrome.storage.sync.

const DEFAULTS = {
  enabled: true,
  secondLang: "zh-Hans",
  bottomOffset: 22,
  fontSize: 22,
  color: "#ffffff",
  background: "rgba(0,0,0,0.6)"
};

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

async function init() {
  const stored = (await chrome.storage.sync.get(["ydsSettings"])).ydsSettings || {};
  const settings = { ...DEFAULTS, ...stored };

  $("enabled").checked = !!settings.enabled;
  $("bottomOffset").value = settings.bottomOffset;
  $("bottomOffsetVal").textContent = `${settings.bottomOffset}%`;
  $("fontSize").value = settings.fontSize;
  $("color").value = settings.color;
  $("bgAlpha").value = bgToAlpha(settings.background);

  const tab = await getActiveYouTubeTab();
  let info = null;
  if (tab) info = await askContent(tab.id);

  populateLanguages(info);
  $("lang").value = settings.secondLang || "";

  if (!tab) {
    $("status").textContent = "打开 www.youtube.com 上的视频页面即可使用。";
    $("videoInfo").textContent = "";
  } else if (info && info.videoId) {
    $("videoInfo").textContent = info.videoId;
    if (info.nativeCaptionText) {
      $("status").textContent = "已检测到 YouTube 字幕。第二语言会自动翻译并叠加显示。";
    } else {
      $("status").textContent = "请先点开 YouTube 播放器右下角的 CC 按钮开启原生字幕，扩展会自动翻译并叠加第二种语言。";
    }
  } else {
    $("status").textContent = "无法与页面通信。请刷新 YouTube 页面后再试。";
  }

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("lang").addEventListener("change", (e) => save({ secondLang: e.target.value }));
  $("bottomOffset").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    $("bottomOffsetVal").textContent = `${v}%`;
    save({ bottomOffset: v });
  });
  $("fontSize").addEventListener("change", (e) => save({ fontSize: parseInt(e.target.value, 10) || 22 }));
  $("color").addEventListener("change", (e) => save({ color: e.target.value }));
  $("bgAlpha").addEventListener("input", (e) => save({ background: alphaToBg(parseInt(e.target.value, 10)) }));
}

init().catch((err) => {
  $("status").textContent = "初始化失败：" + (err?.message || err);
});
