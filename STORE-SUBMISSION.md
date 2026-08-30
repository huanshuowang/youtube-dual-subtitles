# Chrome Web Store 提交材料 — v2.0.0

上传包：`dist/happysubs-upload.zip`（manifest 在压缩包根目录）

这份文件是给提交表单抄的，不随扩展打包。

---

## 单一用途说明 (Single purpose)

> HappySubs shows a second subtitle language on top of the video you are
> watching. It reads the subtitles a video already has, translates them, and
> draws the translation over the player. For videos that have no subtitles at
> all, it can optionally transcribe the audio using a program the user installs
> and runs on their own computer.

中文版：

> 在正在观看的视频上叠加第二语言字幕。读取视频已有的字幕、翻译后画在播放器上。
> 对完全没有字幕的视频，可选择用用户自行安装并运行在本机的程序做语音识别。

---

## 权限说明 (Permission justification)

表单里每项权限都要单独填。逐条对应代码里真实发生的事，没有一条是"以防万一"。

**storage**
> Saves the user's own settings — second language, translation provider,
> subtitle style and position, and any API key they choose to enter. Nothing
> else is stored, and nothing is sent anywhere by storing it.

**www.youtube.com / vimeo.com / player.vimeo.com / www.bilibili.com**
> The pages the extension runs on. It reads the subtitles the video already
> has and draws the translated line over the player. The popup also reads the
> current tab's URL to tell whether the page is one of these.

**captions.vimeo.com**
> Vimeo publishes each video's subtitle file here, linked from the player.
> The extension fetches that file to translate it.

**api.bilibili.com**
> Bilibili publishes the list of a video's subtitle tracks through this API.
> The extension queries it to find out which subtitles a video has.

**translate.googleapis.com**
> The default translation provider. Subtitle text is sent here to be
> translated. No API key involved; nothing else is sent.

**api.anthropic.com / api.openai.com / generativelanguage.googleapis.com / api.deepseek.com**
> Optional translation providers. Each is contacted only if the user selects
> that provider and enters their own API key, and only to translate subtitle
> text. The extension never contacts a provider the user has not chosen.

**为什么没有 tabs 权限**：弹窗只需要当前标签页的 URL，上面四个站点的
host permission 已经足够拿到，不需要 `tabs`。

**为什么没有 scripting 权限**：所有脚本都通过 manifest 的 `content_scripts`
静态声明注入，不做动态注入。

---

## 数据用途 (Data usage disclosures)

表单里的勾选项，逐条对应：

| 类别 | 是否收集 | 说明 |
|---|---|---|
| 个人身份信息 | 否 | |
| 健康信息 | 否 | |
| 财务和支付信息 | 否 | |
| 身份验证信息 | **是** | 用户可选填写的第三方翻译服务 API Key。只存在浏览器本地 `chrome.storage`，只用于调用用户自己选的那家服务，不发往任何其他地方。 |
| 个人通讯内容 | 否 | |
| 位置 | 否 | |
| 网络历史 | 否 | 不读取、不记录浏览历史。 |
| 用户活动 | 否 | 不做点击流、埋点或任何分析统计。 |
| 网站内容 | **是** | 视频的字幕文本。为了翻译，会发送到用户选定的翻译服务。开启实时听译时，还包括当前视频的音频——**只发往本机 127.0.0.1，不出本机**。 |

三条声明都要勾：
- 不将数据出售或转让给第三方（除非是为了实现用户请求的功能）
- 不将数据用于与单一用途无关的目的
- 不将数据用于判断信用度或放贷

隐私政策地址：`https://huanshuowang.com/happysubs/privacy.html`

---

## 关于本机连接，审核大概率会问

审核员会看到 `ws://127.0.0.1:8765`。准备好这段回复：

> Live transcription is an optional feature for videos that have no subtitles.
> When the user turns it on, the extension reads the audio of the video element
> on the page and streams it over a loopback connection to a speech recogniser
> that the user has separately installed and is running on their own machine.
> The audio never leaves the user's computer — there is no server involved and
> the extension developer receives nothing. With the feature switched off, or
> with that program not running, no audio is read at all. Setup instructions and
> the recogniser's full source are at
> https://huanshuowang.com/happysubs/#live
>
> The extension does not request microphone access. It only reads the audio of
> the video the user is already watching.

---

## 仍需人工处理的

- **商店截图要重拍**：弹窗新增了顶部「直接翻译 / 实时听译」两个标签页，旧截图对不上。
- **升级会要求用户重新授权**，因为新增了 Vimeo 和 B站 的域名。这是正常的，说明里可以提一句。
- 商店的名称和描述来自 `_locales/*/messages.json`，随包更新，不用另填。
