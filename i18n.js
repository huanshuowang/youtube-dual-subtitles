// Shared i18n for the popup, the options page and the content script.
//
// By default the UI language follows the browser: any zh-* locale gets Chinese,
// everything else gets English. The options page can override that, so callers
// pass the stored preference to ydsSetUiLang() once their settings have loaded.
// ydsT() is always read lazily, so switching the language later just works —
// re-render and every string comes back in the new language.

(() => {
  function rawUiLang() {
    try {
      const l = chrome?.i18n?.getUILanguage?.();
      if (l) return l;
    } catch {}
    try { return navigator.language || ""; } catch {}
    return "";
  }

  function autoLang() {
    return /^zh/i.test(rawUiLang()) ? "zh" : "en";
  }

  let YDS_LANG = autoLang();

  // pref: "auto" | "zh" | "en" (anything unrecognised falls back to auto).
  function ydsSetUiLang(pref) {
    YDS_LANG = (pref === "zh" || pref === "en") ? pref : autoLang();
    globalThis.ydsUiLang = YDS_LANG;
    return YDS_LANG;
  }

  // Default second-subtitle language guessed from the browser UI language,
  // used before the user picks one themselves.
  function ydsDefaultSecondLang() {
    const l = rawUiLang().toLowerCase();
    if (l.startsWith("zh")) return /tw|hk|mo|hant/.test(l) ? "zh-Hant" : "zh-Hans";
    return l.split("-")[0] || "en";
  }

  const MESSAGES = {
    en: {
      appTitle: "HappySubs",
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
      tabTranslate: "Translate",
      translateScope: "Works on YouTube, Vimeo and Bilibili — including Vimeo players embedded in other sites.",
      liveScope: "Works on all three platforms; mainly for Bilibili, where most videos have no subtitle track. Needs the local recogniser installed.",
      tabLive: "Live transcribe",
      liveStart: "Start live transcription",
      liveStop: "Stop live transcription",
      liveIdle: "For videos with no subtitles at all. Taps the video's audio and captions it as it plays, using a recogniser running on this computer — the audio never leaves your machine.",
      liveConnecting: "Connecting to the local recogniser…",
      liveListening: "Listening. Captions appear as people speak.",
      statusLiveRunning: "Live transcription is running — these captions come from the recogniser on your machine, not from a subtitle track.",
      liveUnavailable: "No local recogniser found on port 8765. Install and start it, then press start again — see the setup guide.",
      liveNoVideo: "No video found on this page.",
      liveCaptureFailed: "Could not tap this video's audio. Press play first, then start transcription.",
      liveSetupLink: "Setup guide →",
      liveHasTrack: "This video also has a subtitle track, which is more accurate than a recogniser. Live captions are showing because you asked for them; stop them and the track comes straight back.",
      optionsTitle: "HappySubs settings",
      interfaceSection: "Interface",
      interfaceLanguage: "Panel language",
      langAuto: "Follow the browser",
      langZh: "中文",
      langEn: "English",
      langNote: "Applies to the popup, this page and the prompts drawn on the video.",
      behaviourSection: "Default behaviour",
      behaviourNote: "These are the same switches as in the popup — they are remembered across videos and browser restarts, so whatever you set here is how every video starts.",
      openPopupNote: "Second language, translator, API keys and subtitle styling live in the toolbar popup.",
      saved: "Saved",
      translationOnly: "Translation only (no need to turn on captions)",
      statusTranslationOnly: "Translation-only mode: the second language shows on its own, with the player's captions closed.",
      statusTranslationOnlyNeedsCc: "Translation-only mode is on, but no subtitles have been picked up yet. Click CC once in the player, then turn it back off — the extension keeps the track and shows the translation on its own.",
      verticalPosition: "Vertical position",
      captionWidth: "Subtitle width",
      captionWidthNote: "Applies only when there is no original caption line to match: live transcription, and translation-only mode. Turn it down when the picture is pillarboxed, so the text stays over the image.",
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

      statusNoTab: "Open a video on YouTube, Vimeo or Bilibili to use this extension.",
      statusNoComm: "Can't reach this page yet. If you clicked through from a listing page, open the video in a new tab or refresh the {platform} tab.",
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
      statusDetected: "{platform} subtitles detected. Pick a translator and add a key; the page will retranslate automatically. Translation hasn't finished yet.",
      statusTurnOnCC: "Turn on captions with the CC button in the YouTube player first; the extension will translate and overlay a second language automatically.",
      statusVimeoReading: "Reading Vimeo's subtitle track. Hit CC in the player if you also want the original on screen.",
      statusBilibiliReading: "Reading Bilibili's subtitle track. Turn on subtitles in the player if you also want the original on screen.",
      statusBilibiliNoTrack: "This video has no subtitle track. Bilibili only lists tracks for signed-in viewers — if you are signed in, the video genuinely has none, and live transcription is the way to caption it.",

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
      appTitle: "HappySubs",
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
      tabTranslate: "直接翻译",
      translateScope: "支持 YouTube、Vimeo、B站，包括嵌在其他网站里的 Vimeo 播放器。",
      liveScope: "三个平台都能用；主要是给 B站——那里大部分视频没有字幕轨。需要先装本地识别服务。",
      tabLive: "实时听译",
      liveStart: "开启实时听译",
      liveStop: "关闭实时听译",
      liveIdle: "给完全没有字幕的视频用。抓取视频音频，边播边转成字幕，识别在你自己电脑上跑——音频不出本机。",
      liveConnecting: "正在连接本地识别服务…",
      liveListening: "已连接，说话时会出字幕。",
      statusLiveRunning: "实时听译进行中——画面上的字幕来自本机识别，不是视频自带的字幕轨。",
      liveUnavailable: "8765 端口上没找到本地识别服务。装好并启动后再点开启——见安装说明。",
      liveNoVideo: "这个页面上没找到视频。",
      liveCaptureFailed: "抓不到这个视频的音频。先点一下播放，再开启听译。",
      liveSetupLink: "安装说明 →",
      liveHasTrack: "这个视频本身有字幕轨，比识别准。现在显示听译是因为你主动开了它；关掉就立刻切回字幕轨。",
      optionsTitle: "HappySubs 设置",
      interfaceSection: "界面",
      interfaceLanguage: "面板语言",
      langAuto: "跟随浏览器",
      langZh: "中文",
      langEn: "English",
      langNote: "作用于插件弹窗、本页面，以及视频上弹出的提示。",
      behaviourSection: "默认行为",
      behaviourNote: "这两个开关和弹窗里是同一个——设置会跨视频、跨重启保留，所以在这里设成什么，每个视频打开时就是什么。",
      openPopupNote: "第二语言、翻译源、API Key 和字幕样式在工具栏弹窗里设置。",
      saved: "已保存",
      translationOnly: "仅显示翻译字幕（不用开原生字幕）",
      statusTranslationOnly: "仅翻译模式：不开播放器字幕也会单独显示第二语言。",
      statusTranslationOnlyNeedsCc: "仅翻译模式已开启，但还没取到字幕。在播放器里点一下 CC 再关掉即可——扩展会留着这份字幕，之后单独显示译文。",
      verticalPosition: "垂直位置",
      captionWidth: "字幕宽度",
      captionWidthNote: "只在没有原生字幕可对齐时生效：实时听译、以及仅翻译模式。画面左右有黑边时调小，字幕就只落在画面里。",
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

      statusNoTab: "打开 YouTube、Vimeo 或 B 站上的视频页面即可使用。",
      statusNoComm: "还连不上这个页面。如果你是从列表页点进来的，刷新一下 {platform} 页面（或在新标签页打开视频）即可。",
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
      statusDetected: "已检测到 {platform} 字幕。选择翻译源并填写 key 后，页面会自动重新翻译；当前还没有完成翻译。",
      statusTurnOnCC: "请先点开 YouTube 播放器右下角的 CC 按钮开启原生字幕，扩展会自动翻译并叠加第二种语言。",
      statusVimeoReading: "正在读取 Vimeo 字幕轨。想同时看到原文，点一下播放器的 CC 就行。",
      statusBilibiliReading: "正在读取 B 站字幕轨。想同时看到原文，在播放器里打开字幕即可。",
      statusBilibiliNoTrack: "这个视频没有字幕轨。B 站只对登录用户返回字幕列表——如果你已登录，那就是真的没有，用实时听译来出字幕。",

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
  globalThis.ydsSetUiLang = ydsSetUiLang;
  globalThis.ydsDefaultSecondLang = ydsDefaultSecondLang;
})();
