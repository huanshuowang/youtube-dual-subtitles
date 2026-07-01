# YouTube Dual Subtitles

> 一个 Chrome 扩展，让 YouTube 视频**同时显示原生字幕 + 任意第二语言翻译**。看外语视频学语言、追国外内容不再切来切去。

**📖 项目主页：** https://huanshuowang.github.io/youtube-dual-subtitles/

---

## ✨ 特点

- **⚡ 零延迟同步**：拦截 YouTube 播放器自己的字幕请求，整片提前翻译，跟视频时间轴精确对齐
- **🎯 整句翻译**：合并 ASR 把一句话切成两半的碎片再翻译，比同类扩展效果更好
- **🖱️ 悬停拖动字幕位置**：鼠标碰到字幕就浮出拖拽把手，全屏也能调
- **🌍 100+ 种语言**：Google Translate 支持的目标语言都能选
- **🔐 无需登录 · 无 API Key**：装完就能用
- **🎨 样式可调**：字号、颜色、背景透明度、垂直位置随你调

## 📦 安装

1. **下载扩展** — [点这里下载 ZIP](https://github.com/huanshuowang/youtube-dual-subtitles/archive/refs/heads/main.zip)，解压
2. **打开 Chrome 扩展页** — 地址栏输入 `chrome://extensions`，右上角开启 **Developer mode**
3. **加载已解压的扩展** — 点 **Load unpacked**，选择解压出的 `youtube-dual-subtitles-main` 文件夹
4. **打开 YouTube 视频** — 先点 CC 按钮开原生字幕（选你想看的第一种语言），然后点浏览器右上角扩展图标，选第二语言

## 🎬 使用

- 视频里 **必须先打开 CC 原生字幕**（点播放器右下角的 CC 按钮）
- 打开后中文（或你选的语言）会自动叠加在原生字幕上方
- 鼠标碰字幕 → 上方浮出 ↕ 小方块 → 按住拖动调位置
- 弹窗里可以改：第二语言、垂直位置、字号、颜色、背景透明度

## 🔧 工作原理

1. `inject.js` 在页面主 world 里 hook 掉 `window.fetch` / `XMLHttpRequest`
2. YouTube 播放器请求 `/api/timedtext` 时截获响应（JSON3 或 SRV3 格式）
3. 解析出所有字幕 cue，合并 ASR 切碎的短句，批量发到 Google Translate 免费端点 `translate.googleapis.com/translate_a/single`
4. 用 `requestAnimationFrame` 跟着 `video.currentTime` 渲染翻译到叠加层

之所以要 hook YouTube 自己的请求，是因为 YouTube 现在对第三方直接请求 timedtext API 返回空 body（PoT token 校验）——只有 YouTube 播放器自己带的请求能成功。

## 🐛 反馈 / 贡献

- Bug 或需求 → [提 Issue](https://github.com/huanshuowang/youtube-dual-subtitles/issues)
- 想加功能 → 欢迎 PR

## 📄 License

MIT
