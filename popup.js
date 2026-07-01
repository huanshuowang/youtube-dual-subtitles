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
  const group = document.createElement("optgroup");
  group.label = "常用";
  sel.appendChild(group);
  for (const [c, n] of commons) {
    if (seen.has(c)) continue;
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = `${n} (${c})`;
    group.appendChild(opt);
  }
}

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
