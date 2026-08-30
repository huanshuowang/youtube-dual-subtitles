# 手动测试页

两个跑在浏览器里的测试页，不需要装扩展，也不需要 node。

```bash
cd "$(dirname "$0")/.." && python3 -m http.server 8794
```

然后打开：

### `test/content-pipeline.html`

用一个 mock 适配器驱动 `content.js` 的完整流程：boot → 轨道列表 → cue 注入 → native 直用路径 → 渲染循环 → 叠加层。全程离线，不调用任何翻译 API。

http://localhost:8794/test/content-pipeline.html

### `test/drag.html`

拖动把手的交互测试，跑真的 `content.js`。假播放器里放了两层东西还原真实播放器的坑：一排会疯狂触发 `mouseleave` 的控制条图标，和一层盖住整个视频的鼠标捕获层（对应 Vimeo 的 `.vp-target`）。用真实鼠标操作，检查把手会不会出现、拖得动不动、拖动时有没有虚线框、点击有没有漏到播放器。

http://localhost:8794/test/drag.html

加 `?cue=<文字>` 可以换字幕内容，用来看「翻译宽度跟原文字幕对齐」的效果。

### `test/translation-only.html`

「仅显示翻译字幕」开关的行为测试（10 条）：默认关着时不开 CC 就不显示、开 CC 才显示、关掉 CC 又隐藏；「开一次 CC 再关掉、然后勾选开关」要能看到译文；读不出播放器字幕状态时默认保持隐藏、但仅翻译模式下照常显示。用的是 YouTube 形状的适配器（需要 CC 才能取轨）。

http://localhost:8794/test/translation-only.html

### `test/spa-nav.html`

单页应用导航测试（8 条）。这三个站都是 SPA：你常常先落在首页/列表页（那里没有视频），再点进视频，**中间没有页面加载**。

原来的 `boot()` 在列表页判定"不是视频页"就 `return`，而且是永久的——之后整个会话都不会再醒。B站 和 Vimeo 都中招（YouTube 因为 `looksLikeVideoPage` 恒真才幸免）。这个测试就是钉住这个行为：列表页上要安静、点进视频要醒来、适配器只能启动一次、换视频只更新 id 不重启。

http://localhost:8794/test/spa-nav.html

### `test/live-visual.html`

听译字幕层的**排版目测页**——不是自动断言，是渲染出来给人看的：一段会折行的英文加中文译文，叠在一块假的画面上，同时把关键尺寸量出来打印。

排版上的一条判断：一句话折行之后应该读作**一个整块**。原来每行各画一个背景框（`box-decoration-break: clone`），行距就变成一条露出画面的横缝，横穿一句话中间。现在背景画在整块上，两行共用一个框。

http://localhost:8794/test/live-visual.html

### `test/live.html`

实时听译测试（24 条）。`WebSocket` 和 `AudioContext` 都换成假的，所以不需要真的跑本地识别服务——测的是**我们这一侧**：音频有没有被接上、socket 有没有连到 8765、partial 会替换而不是追加、final 会翻译到下面那行、seek 会清空并给识别端发 reset、停止后 socket 关闭。

另外两条测「字幕宽度」百分比：长句要停在播放器的指定占比上（实测 480px 播放器、设 50%，量到正好 240px），短句仍然紧贴文字（46px）。这两条第一次也是**放错了位置**——摆在字幕轨那段之后，那时轨道已接管、听译被抑制，量到的其实是轨道那行的宽度。挪到轨道出现之前才是真的在测。

两条关于**节流而非去抖**的：模拟连续说话 14 次刷新、约 2.8 秒不停顿，译文必须在说话过程中就出来（实测 3 次翻译请求），且不能每次刷新都翻一遍。这一条钉的是从 bili 原版搬过来时踩的坑——原版代码里专门写了注释警告"不能用去抖"，我第一版恰好写成了去抖，结果译文要等对方停顿才出现。

还有两条关于**宽度固定**：听译模式下长句和短句必须一样宽。流式文本每秒revise 好几次，按内容伸缩就会一直抖。

两条关于**排版**：折行后每种语言只能有一个背景框（不是一行一个），以及不管说多少字幕框都锁在两行高。

三条关于**暂停**：暂停后字幕要熬过 4 秒的静音淡出、在 8 秒时才消失、恢复播放后能回来。字幕轨模式不测这个——时间轴停了，cue 本来就一直渲染。

还有两条关于**谁占着画面**：听译一旦手动开启就保住叠加层，哪怕视频有字幕轨；关掉之后字幕轨立刻回来。这一条最初写反了——我让字幕轨永远压过听译，结果在有 CC 的视频上点开听译毫无反应（音频在抓、socket 也连着，就是屏幕不变）。按了按钮就该看到东西。

节流那条断言最初写死了次数上限，脚手架跑慢时（14 秒 vs 2.8 秒）就会误报；改成按速率算——每 900ms 窗口最多一次。

早先「字幕轨要能从听译手里把叠加层拿回去」那条第一次是**假通过**的——断言写成了 `includes(...) || transLine() !== ""`，后半截让任何非空文本都算过。打印出来的细节露了馅（屏幕上还是听译的译文），查出来是 `liveRender()` 的异步翻译回调没检查轨道是否已接管，回来就把叠加层盖回去了。

http://localhost:8794/test/live.html

### `test/bilibili-adapter.html`

B 站适配器测试（23 条），全程不碰网络——把 `fetch` 换成罐装响应，形状照抄真实 API（我在 www.bilibili.com 上验过两个接口带 cookie 直接可用、不需要 wbi 签名）。

覆盖：两跳 API 拿字幕列表、`ai-` 前缀映射成 `kind: "asr"`、人工轨保留完整语言码（`zh-CN` 而不是截断成 `zh`）、B 站的 `from/to/content` 映射成 `start/end/text`、零长度和空白 cue 丢弃、同一条轨不重复拉取、`//` 和 `http://` 的字幕地址都要变成 https。

页面用 `history.replaceState` 把路径伪装成 `/video/BVxxx`，因为适配器是从 `location.pathname` 里取 BV 号的。

最后五条钉的是 **URL 形态**：稍后再看/收藏夹这类播放列表页（`/list/watchlater?bvid=BV...`）BV 号在**查询参数**里而不是路径里，番剧是 `/bangumi/play/ep...`，首页则都不算。这几种是实际用起来才撞上的。

http://localhost:8794/test/bilibili-adapter.html

### `test/source-pick.html`

仅翻译模式下"从哪条轨翻译"的优先级测试。`content.js` 每页只能有一个实例，所以每个 case 单独开一次页面：`?case=A` 到 `?case=E`。

覆盖：只有机器泰语 + 人工英语（选英语）、多一条人工泰语（选泰语）、只有机器轨（只能选它）、完全没有机器轨因而不知道原语言（退回第一条人工轨）、人工原语言轨排在列表最后（不能让列表顺序决定结果）。

http://localhost:8794/test/source-pick.html?case=B

### `test/source-switch.html`

翻译来源的行为测试（5 条）：自动生成轨会触发去取同语言的人工轨、之后不会被后来的自动生成轨顶掉、而换成另一种语言时要重新翻译。

判断"屏幕上这句来自哪条轨"是靠**时间轴覆盖范围**，不是靠标记词——标记词不可靠，`QQQ` 会被 Google 翻成 `QQ`。做法是给两条轨不同的时间覆盖，再把播放时间停在只有其中一条有内容的位置。会真的调用 Google Translate。

http://localhost:8794/test/source-switch.html

### `test/popup.html`

弹窗测试（每种语言 6 条）。同样是把真实的 `popup.html` 标签抓进来、跑真实的 `i18n.js` 和 `popup.js`，重点是 `init()` 要能整个跑完——它中途抛异常的话弹窗会画一半、状态栏显示「初始化失败」，而各个控件看起来只是"空着"，不容易一眼看出是坏了。

加 `?uiLang=zh` / `?uiLang=en` / `?uiLang=auto` 分别测三种面板语言设置（桩里的浏览器语言是 en-US）。

http://localhost:8794/test/popup.html?uiLang=zh

### `test/options.html`

设置页测试（10 条）。它把真实的 `options.html` 标签抓进来、再加载真实的 `i18n.js` 和 `options.js`，所以测的是要发布的那份代码：面板语言在 auto / 中文 / English 之间切换要立刻重绘、要写进存储；默认行为的两个开关要写进和弹窗同一条记录，且不能覆盖弹窗的其他设置。

http://localhost:8794/test/options.html

### `test/vimeo-adapter.html`

用**真实的** Vimeo 字幕 URL 跑 Vimeo 适配器：轨道发现、语言码归一化（`en-x-autogen` → `en` + `kind=asr`）、WebVTT 解析、DOM 选择器、视频 ID 提取。

需要一个没过期的签名 URL——在 Vimeo 视频页控制台里执行
`document.querySelector('track').src` 拿到，然后：

http://localhost:8794/test/vimeo-adapter.html?vtt=<URL-encoded .vtt 地址>

签名 URL 有有效期（`expires` 参数），过期就换一条新的。
