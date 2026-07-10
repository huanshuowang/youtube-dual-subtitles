// Shared i18n for popup and content script. UI language follows the
// browser's UI language automatically: any zh-* locale gets Chinese,
// everything else gets English. No user-facing language setting.

(() => {
  function rawUiLang() {
    try {
      const l = chrome?.i18n?.getUILanguage?.();
      if (l) return l;
    } catch {}
    try { return navigator.language || ""; } catch {}
    return "";
  }

  const YDS_LANG = /^zh/i.test(rawUiLang()) ? "zh" : "en";

  // Default second-subtitle language guessed from the browser UI language,
  // used before the user picks one themselves.
  function ydsDefaultSecondLang() {
    const l = rawUiLang().toLowerCase();
    if (l.startsWith("zh")) return /tw|hk|mo|hant/.test(l) ? "zh-Hant" : "zh-Hans";
    return l.split("-")[0] || "en";
  }

  const MESSAGES = {
    en: {
      appTitle: "Dual Subtitles",
      enable: "Enable",
      secondLanguage: "2nd language",
      translationSource: "Translator",
      providerGoogle: "Google Translate (free)",
      providerClaude: "Claude Haiku · high quality",
      providerOpenai: "OpenAI GPT-4o mini · high quality",
      providerGemini: "Google Gemini · free tier available",
      providerDeepseek: "DeepSeek · budget-friendly",
      providerNative: "Video's own subtitles",
      providerUnknown: "Unknown",
      pasteHere: "Paste here",
      keyStateTitle: "API Key status",
      keySavedTitle: "API Key saved",
      keyMissingTitle: "No API Key yet",
      edit: "Edit",
      done: "Done",
      getKeyLink: "Get {name} key →",
      usePaidApiBtn: "Translate this video with {name} API",
      usePaidApiBtnGeneric: "Translate this video with the selected API",
      askEachVideo: "Ask on every video whether to use the paid API",
      verticalPosition: "Vertical position",
      fontSizePx: "Font size (px)",
      textColor: "Text color",
      bgOpacity: "Background opacity",
      loadingInfo: "Fetching subtitle info for the current video…",

      offSecondSub: "— Second subtitle off —",
      groupNative: "This video's native subtitles",
      asrSuffix: " · auto-generated",
      groupAutoTranslate: "Auto-translate",
      groupCommon: "Common",
      groupAll: "All languages",

      statusNoTab: "Open a video on www.youtube.com to use this extension.",
      statusNoComm: "Can't reach the page. Refresh the YouTube tab and try again.",
      statusNative: "Now showing this video's native {lang} subtitles (no translation API used).",
      statusNativeFallbackLang: "target-language",
      statusDone: "Done: translated by {name}, {count} subtitle lines loaded.",
      statusTranslating: "Translating subtitles with the {name} API{progress}…",
      progressFmt: " ({done}/{total})",
      statusCancelledFallback: "Now using Google Translate ({name} API was cancelled).",
      statusFallback: "Now using Google Translate (fell back after {name} failed). {error}",
      errorPrefix: "Error: ",
      statusAwaiting: "Awaiting confirmation: this video will only use the {name} API after you click the button above. Until then, free Google Translate is used.",
      statusNeedKey: "{name} needs an API Key. Free Google Translate is used until you add one.",
      statusError: "{name} translation failed: {error}",
      unknownError: "unknown error",
      statusDetected: "YouTube subtitles detected. Pick a translator and add a key; the page will retranslate automatically. Translation hasn't finished yet.",
      statusTurnOnCC: "Turn on captions with the CC button in the YouTube player first; the extension will translate and overlay a second language automatically.",

      statusLangSwitched: "Target language changed. The page is re-checking native subtitles or retranslating…",
      statusProviderSwitched: "Switched to {name}. The paid API won't be called until you confirm.",
      askOn: "On: each new video will ask whether to use the paid API.",
      askOff: "Off: the paid API is only called after you click the translate button.",
      statusStartingPaid: "Starting {name} API translation for this video…",
      statusPaidFailed: "Couldn't start the paid API. Make sure captions are on, then refresh and try again.",
      keySaved: "{name} API Key saved. It is only called after you click the button above.",
      keyCleared: "{name} API Key cleared.",
      initFailed: "Initialization failed: ",

      paidPromptTitle: "Use the {name} API for this video?",
      paidPromptBody: "This calls your {name} key and may incur costs. If you cancel, this video keeps using free Google Translate.",
      paidPromptFree: "Use free Google",
      paidPromptUse: "Use {name} API",
      paidDeclined: "Paid API declined; this video uses free Google Translate",
      notPaidProvider: "The selected translator is not a paid API",
      noSourceCues: "This video has no translatable source subtitles, or native subtitles are already in use",
      dragHint: "Drag up/down to move the subtitles"
    },
    zh: {
      appTitle: "双语字幕 · Dual Subtitles",
      enable: "启用",
      secondLanguage: "第二语言",
      translationSource: "翻译源",
      providerGoogle: "Google Translate（免费）",
      providerClaude: "Claude Haiku · 高质量",
      providerOpenai: "OpenAI GPT-4o mini · 高质量",
      providerGemini: "Google Gemini · 有免费额度",
      providerDeepseek: "DeepSeek · 高性价比",
      providerNative: "视频自带字幕",
      providerUnknown: "未知",
      pasteHere: "粘贴到这里",
      keyStateTitle: "API Key 状态",
      keySavedTitle: "已保存 API Key",
      keyMissingTitle: "尚未填写 API Key",
      edit: "编辑",
      done: "完成",
      getKeyLink: "获取 {name} key →",
      usePaidApiBtn: "本视频使用 {name} API 翻译",
      usePaidApiBtnGeneric: "本视频使用所选 API 翻译",
      askEachVideo: "每次打开视频自动询问是否使用付费 API",
      verticalPosition: "垂直位置",
      fontSizePx: "字号 (px)",
      textColor: "文字颜色",
      bgOpacity: "背景透明度",
      loadingInfo: "正在获取当前视频的字幕信息…",

      offSecondSub: "— 关闭第二字幕 —",
      groupNative: "该视频原生字幕",
      asrSuffix: " · 自动生成",
      groupAutoTranslate: "自动翻译",
      groupCommon: "常用",
      groupAll: "全部语言",

      statusNoTab: "打开 www.youtube.com 上的视频页面即可使用。",
      statusNoComm: "无法与页面通信。请刷新 YouTube 页面后再试。",
      statusNative: "当前使用：视频自带 {lang} 字幕（未调用翻译 API）。",
      statusNativeFallbackLang: "目标语言",
      statusDone: "已完成：{name} 翻译，已加载 {count} 条字幕。",
      statusTranslating: "正在调用：{name} API 翻译字幕{progress}…",
      progressFmt: "（{done}/{total}）",
      statusCancelledFallback: "当前使用：Google Translate（已取消 {name} API）。",
      statusFallback: "当前使用：Google Translate（{name} 调用失败后回退）。{error}",
      errorPrefix: "错误：",
      statusAwaiting: "等待确认：点击上方按钮后，本视频才会使用 {name} API。未确认前使用免费 Google Translate。",
      statusNeedKey: "{name} 需要 API Key。未填写前会使用免费 Google Translate。",
      statusError: "{name} 翻译失败：{error}",
      unknownError: "未知错误",
      statusDetected: "已检测到 YouTube 字幕。选择翻译源并填写 key 后，页面会自动重新翻译；当前还没有完成翻译。",
      statusTurnOnCC: "请先点开 YouTube 播放器右下角的 CC 按钮开启原生字幕，扩展会自动翻译并叠加第二种语言。",

      statusLangSwitched: "已切换目标语言。页面正在重新检测 native 字幕或翻译…",
      statusProviderSwitched: "已切换为 {name}。未点击确认前不会调用付费 API。",
      askOn: "已开启：每次打开视频会自动询问是否使用付费 API。",
      askOff: "已关闭：付费 API 只会在你点击“本视频使用所选 API 翻译”后调用。",
      statusStartingPaid: "正在为本视频启动 {name} API 翻译…",
      statusPaidFailed: "无法启动付费 API。请确认页面已打开字幕并刷新后重试。",
      keySaved: "已保存 {name} API Key。需要点击上方按钮才会调用。",
      keyCleared: "{name} API Key 已清空。",
      initFailed: "初始化失败：",

      paidPromptTitle: "是否为本视频使用 {name} API？",
      paidPromptBody: "这会调用你的 {name} Key，可能产生费用。取消后本视频会继续使用免费的 Google Translate。",
      paidPromptFree: "用免费 Google",
      paidPromptUse: "使用 {name} API",
      paidDeclined: "用户取消了付费 API，本视频使用免费 Google Translate",
      notPaidProvider: "当前翻译源不是付费 API",
      noSourceCues: "当前视频没有可翻译的源字幕，或已经使用 native 字幕",
      dragHint: "上下拖动调整字幕位置"
    }
  };

  function ydsT(key, subs) {
    let msg = MESSAGES[YDS_LANG][key] ?? MESSAGES.en[key] ?? key;
    if (subs) {
      for (const [k, v] of Object.entries(subs)) {
        msg = msg.split(`{${k}}`).join(String(v));
      }
    }
    return msg;
  }

  globalThis.ydsT = ydsT;
  globalThis.ydsUiLang = YDS_LANG;
  globalThis.ydsDefaultSecondLang = ydsDefaultSecondLang;
})();
