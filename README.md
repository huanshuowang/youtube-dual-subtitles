# YouTube Dual Subtitles

> v1.2.0 · 在 YouTube 上同时显示两种语言的字幕。使用自带字幕或Google免费翻译，支持使用Claude / OpenAI / Gemini / DeepSeek 翻译。

**📖 项目主页：** https://huanshuowang.github.io/youtube-dual-subtitles/

---

## ✨ 特点

- **⚡ 零延迟同步**：拦截 YouTube 播放器自己的字幕请求，整片提前翻译，跟视频时间轴精确对齐
- **🎯 整句翻译**：合并 ASR 把一句话切成两半的碎片再翻译，比同类扩展效果更好
- **🖱️ 悬停拖动字幕位置**：鼠标碰到字幕就浮出拖拽把手，全屏也能调
- **🌍 100+ 种语言**：Google Translate 支持的目标语言都能选
- **🔐 免费可用 · AI 增强可选**：使用视频自带字幕或 Google 免费翻译。需要更高精度时，可选 Claude / OpenAI / Gemini / DeepSeek 增强翻译，并且只会在你确认后调用 API
- **🎨 样式可调**：字号、颜色、背景透明度、垂直位置随你调

## 📦 安装

1. **下载扩展** — [点这里下载 ZIP](https://github.com/huanshuowang/youtube-dual-subtitles/archive/refs/heads/main.zip)，解压
2. **打开 Chrome 扩展页** — 地址栏输入 `chrome://extensions`，右上角开启 **Developer mode**
3. **加载已解压的扩展** — 点 **Load unpacked**，选择解压出的 `youtube-dual-subtitles-main` 文件夹
4. **打开 YouTube 视频** — 先点 CC 按钮开原生字幕（选你想看的第一种语言），然后点浏览器右上角扩展图标，选第二语言

## 🎬 使用

- 视频里 **必须先打开 CC 原生字幕**（点播放器右下角的 CC 按钮）
- 打开后中文（或你选的语言）会自动叠加在原生字幕上方
- 如果选择 Claude / OpenAI / Gemini / DeepSeek，需要先填写 API Key，然后点击 **本视频使用所选 API 翻译** 才会调用
- 鼠标碰字幕 → 上方浮出 ↕ 小方块 → 按住拖动调位置
- 弹窗里可以改：第二语言、翻译源、API Key、垂直位置、字号、颜色、背景透明度

## 🔧 工作原理

1. `inject.js` 在页面主 world 里 hook 掉 `window.fetch` / `XMLHttpRequest`
2. YouTube 播放器请求 `/api/timedtext` 时截获响应（JSON3 或 SRV3 格式）
3. 如果视频自带目标语言字幕，直接使用 native track
4. 如果没有 native track，默认批量发到 Google Translate 免费端点 `translate.googleapis.com/translate_a/single`
5. 如果用户手动确认当前视频使用 API，则改用 Claude / OpenAI / Gemini / DeepSeek 重新翻译缓存的字幕
6. 用 `requestAnimationFrame` 跟着 `video.currentTime` 渲染翻译到叠加层

之所以要 hook YouTube 自己的请求，是因为 YouTube 现在对第三方直接请求 timedtext API 返回空 body（PoT token 校验）——只有 YouTube 播放器自己带的请求能成功。

## 📝 更新日志

### 1.2.0

- 支持 Claude / OpenAI / Gemini / DeepSeek 翻译源
- 优先使用视频自带目标语言字幕；没有 native track 时默认使用 Google 免费翻译
- 付费 API 默认不会自动调用，需要在插件弹窗中手动确认当前视频使用
- 可选择开启“每次打开视频自动询问是否使用付费 API”
- 弹窗显示当前实际翻译源和实时翻译进度
- API Key 默认锁定显示，右侧显示保存状态，可点击编辑

## 🐛 反馈 / 贡献

- Bug 或需求 → [提 Issue](https://github.com/huanshuowang/youtube-dual-subtitles/issues)
- 想加功能 → 欢迎 PR

## 📄 License

MIT
