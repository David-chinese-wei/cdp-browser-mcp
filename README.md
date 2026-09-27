# browser-devtools-mcp

让 AI 通过 [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) 抓取正在运行的浏览器：枚举浏览器进程、读取开发者工具里的一切（console、网络、DOM、性能指标、storage、截图），支持**实时订阅**（事件一到就拿得到），并支持**一键保存**成一套可归档、可直接打开的离线产物。

不引入 puppeteer / playwright，只用一条 WebSocket 连接多路复用所有标签页，保持体积小、无浏览器绑定。

---

## 它能做什么

| 类别 | 能力 |
| --- | --- |
| 浏览器进程 | 枚举本机浏览器进程，识别哪些可以通过 CDP 附加；列出已安装的 Chromium 浏览器；扫描本机调试端口 |
| 连接 | 附加到已有浏览器（需带 `--remote-debugging-port`），或自己拉起一个**独立 profile** 的实例，绝不污染你的个人配置 |
| console | 全部 console 输出，按级别 / 关键字 / 时间 / 来源页过滤 |
| 网络 | 请求与响应头、POST body、timing、initiator、是否命中缓存；按需取响应体 |
| 错误 | 未捕获异常、console.error、日志错误、渲染进程崩溃，含 URL 与调用栈 |
| 页面 | DOM 快照（HTML + 适合 LLM 阅读的缩进大纲）、执行 JS、截图、性能指标、Cookies / localStorage / IndexedDB |
| 一键保存 | `session.json`、`console.json`、`console.csv`、`network.har`、`network.csv`、`metrics.json`、`storage.json`、`dom.html`、`dom-outline.txt`、`screenshot.png`、`report.html`、`summary.md`、`manifest.json` |
| **实时** | 订阅事件流：console / 网络各阶段 / 异常 / 导航 / 标签页增减 / 性能采样 / **页面画面帧**，可长轮询消费、服务端主动推送通知，或持续录制到磁盘 JSONL |

产出的 HAR 可直接导入 Chrome DevTools / Charles / Fiddler；`report.html` 是自包含的单文件离线报告，双击就能看，没有任何外部 CDN 依赖。

---

## 支持的浏览器

任何走 CDP 的 Chromium 系浏览器都可以，`browser_launch` 用 `kind`（或 `executable` 绝对路径）指定：

| kind | 浏览器 |
| --- | --- |
| `chrome` | Google Chrome |
| `edge` | **Microsoft Edge** |
| `brave` | Brave |
| `vivaldi` | Vivaldi |
| `opera` | Opera |
| `chromium` | Chromium |
| `auto` | 按上表顺序挑第一个装了的（默认） |

Edge 与 Chrome 全程等价——同一套协议、同一套事件，MS Edge 的自带扩展页会被 `target_list` 自动折叠（见下）。

Firefox / Safari 不走 CDP，`browser_list_processes` 会把它们列出来但标为不可附加。

---

## 安装

```bash
npm install
npm run build
```

要求 Node.js >= 18.17。

---

## MCP 客户端配置

服务默认走 **stdio** 传输（`dist/index.js`），也可以加 `--transport http --port 8931` 切换到 HTTP。

### WorkBuddy

写到 `~/.workbuddy/mcp.json`（注意是 `mcp.json`，**不是** `.mcp.json`）：

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "node",
      "args": ["D:/项目/浏览器抓取mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "node",
      "args": ["D:/项目/浏览器抓取mcp/dist/index.js"]
    }
  }
}
```

### Cursor

项目级或全局 `~/.cursor/mcp.json` 同上。

配置写完后重启客户端，然后在连接器管理页对新服务点「信任」启用。

---

## 典型用法

最简单的路径——让它自己开一个浏览器：

```
browser_launch({ headless: true, url: "https://example.com" })
```

然后直接抓数据，不必先建立连接：

```
console_read({ level: ["error", "warn"] })
network_list({ httpErrorsOnly: true })
page_errors()
page_dom({ mode: "outline" })
capture_save()
```

想抓你正在用的那个浏览器时，要先用调试端口重启它：

```bash
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=*
```

然后 `browser_discover` 找到它，`browser_connect({ port: 9222 })` 连上去。

也可以调用内置的 `diagnose_page` prompt，它会引导模型按固定顺序排查页面问题。

---

## 实时模式：事件一到就拿得到

默认抓取是「一次性读取缓冲区」，适合事后取证；要盯一段时间的过程，就用实时模式。

**第一步，订阅。** 订阅后无论你有没有在读，事件都会先被缓冲起来，不会因为慢一步就丢：

```
events_subscribe({
  channels: ["console", "network", "error", "navigation", "target"],
  performanceSampleMs: 500          // 顺带每 500ms 采样一次性能指标
})
-> { subscriptionId: "sub-...", cursor: 1234 }
```

**第二步，消费。** 两种办法，可以同时用：

```
events_wait({ subscriptionId, cursor, timeoutMs: 15000 })   // 长轮询：有数据立刻返回，超时返回空
events_read({ subscriptionId, cursor })                     // 不等待，先看一眼已积累的
```

`events_wait` 返回 `{ events, cursor }`，下次把 cursor 原样传回去：不重放、不丢中间任何一条。持续盯一个页面就循环调用它，这也是任何客户端都能用的方式（stdio / HTTP 都行）。

**服务端也能主动推。** 订阅默认带 `push: "notification"`，服务端会通过 MCP 通知 `notifications/browser-devtools/events` 把新事件推给客户端；`push: "logging"` 则走标准的 `notifications/message`。客户端不认得这个通知也没关系——推送降级后事件仍然在缓冲里，轮询照常能拿到（100% 无损）。

**想看页面在动什么**，订阅 `frame` 通道（底层是 `Page.startScreencast`）：

```
events_subscribe({ channels: ["frame"], frames: { maxWidth: 800, quality: 60, everyNthFrame: 1 } })
events_wait({ subscriptionId, includeFrameData: true, limit: 5 })   // 要图时才回传 base64
```

**长时间监控怕内存爆**，就让它边收边写磁盘：

```
recording_start({ name: "checkout-flow", saveFrames: true, performanceSampleMs: 1000 })
  ... 复现操作 ...
recording_stop({ recordingId })
```

产物在 `captures/<name>/`：`live-events.jsonl`（一行一条事件，可 `jq` 流式分析）、`frames/00000001.jpg`（画面帧，按序编号）、`recording-summary.json`（统计）。多个标签页一起盯：`browser_connect({ watchAllTargets: true })` 会给所有页面（含之后新开的）都挂上抓取。

内置的 `monitor_live` prompt 会引导模型按「订阅 → 循环等待 → 汇总」的标准节奏盯一段时间。

通道一览：

| channel | 事件 | 说明 |
| --- | --- | --- |
| `console` | `message` / `error` | console 输出与 `Runtime.exceptionThrown` |
| `network` | `request` / `response` / `finished` / `failed` / `redirect` | 网络请求的完整生命周期 |
| `error` | `exception` / `console` / `log` / `crash` | 错误表里新增的一条（含渲染进程崩溃） |
| `navigation` | `frame` | 顶层框架导航 |
| `target` | `created` / `destroyed` / `crashed` | 标签页与窗口增减 |
| `metric` | `sample` | 按 `performanceSampleMs` 定时采样 `Performance.getMetrics` |
| `frame` | `frame` | 页面画面帧（需 `frames` 参数开启推流） |

### 工具一览

**浏览器**：`browser_list_processes`、`browser_installed`、`browser_discover`、`browser_launch`、`browser_connect`、`browser_close`、`target_list`、`target_select`、`session_info`、`session_dump`

> `target_list` 默认只列真实网页，会折叠 Edge / Chrome 自带的扩展页、service worker、offscreen 文档等后台目标（有头 Edge 上这类目标常有十几个，会把真正的两三个页面淹掉）。想看全量传 `includeBackground: true`。过滤后若一个都不剩会自动回退到全量，不会出现"看起来没标签页"的假象。


**内容抓取**：`console_read`、`console_clear`、`network_list`、`network_detail`、`network_body`、`network_clear`、`resources_list`、`resources_get`、`page_errors`、`page_dom`、`page_evaluate`、`page_screenshot`、`performance_metrics`、`storage_read`

> `resources_list` / `resources_get` 对应开发者工具「源代码 / Sources → 页面」面板：`resources_list` 还原 frame 树与该 frame 加载的全部资源，`resources_get` 按 URL 读取任意资源的内容（等同于在面板里点开文件看源码）。取值时会做两层兜底——先取抓到的请求，失败则页内重新拉取，因此 `HEAD` 探测、`Range` 分段请求的音视频、浏览器因体积过大丢弃的 body 都能读到。
>
> **文本乱码兜底**：服务器没给 `charset` 时，浏览器会按本机 locale 默认编码解码（中文 Windows 上是 GBK，属于**有损**变换），导致中文变乱码。`network_body` / `resources_get` 会先尝试可逆的单字节还原，不行再用页内 `fetch` 按 WHATWG 规范以 UTF-8 重解，保证取回正确原文。
>
> **半截内容兜底**：请求还没加载完就去读，`Network.getResponseBody` 会静默返回已到达的部分。`resources_get` 会校验完整性，不完整就自动改走页内重拉；`network_body` 则会返回 `partial: true` 并提示，不会让你把半截当整份。
>
> 顺序带来还原度差异：`resources_get` 会先等资源加载完整；而 `network_body` 取的是"此刻抓到的请求"，两者用途不同——要稳妥复现文件本身用前者，要分析实际发生的请求用后者。

**抓取与归档**：`capture_start`、`capture_status`、`capture_stop`、`capture_save`、`capture_list_saved`

**实时**：`events_subscribe`、`events_wait`、`events_read`、`events_unsubscribe`、`events_list`、`recording_start`、`recording_stop`

---

## 一键保存的产物

```
captures/<会话名>/
├── session.json       原始全量数据（console / network / errors / dom / 指标 / 存储）
├── console.json       console 日志，结构化
├── console.csv        console 日志，表格
├── network.har        HAR 1.2，可导入 DevTools / Charles
├── network.csv        网络请求，表格
├── metrics.json       性能指标快照
├── storage.json       Cookies / localStorage / sessionStorage / IndexedDB
├── dom.html           页面 HTML 快照
├── dom-outline.txt    页面结构大纲（适合 LLM 快速阅读）
├── screenshot.png     页面截图
├── report.html        离线 HTML 报告，双击即可查看
├── summary.md         Markdown 摘要，适合贴到对话里
└── manifest.json      产物索引
```

抓取内容较多时，报告只渲染最近 500 行/表，完整数据请查 JSON 与 CSV。

---

## 已知限制与安全提示

- **Firefox 与 Safari 不走 CDP**，无法附加，进程列表里会标注为不可附加。
- 用 `--remote-debugging-pipe` 启动的浏览器不监听 TCP 端口，同样无法附加；请用 `browser_launch` 起一个实例。
- **Chrome 111+ 必须带 `--remote-allow-origins=*`**，否则 WebSocket 握手会被拒绝——`browser_launch` 已经自动加上。
- 附加到调试端口等于获得了该浏览器的完整控制权。**不要对存放敏感账号的浏览器 profile 开放调试端口**；本服务自动启动的实例一律使用临时 profile，关闭时异步清理。
- 出于安全考虑，临时 profile 的删除只作用于系统临时目录下、且路径包含 `browser-devtools-mcp` 的文件夹。
- 缓冲上限默认 console / network 各 5000 条、错误 1000 条、实时事件 5000 条，超出后按环形缓冲淘汰最旧的数据。
- 长轮询 `events_wait` 最长等待受客户端自身超时限制，默认 15 秒、上限 120 秒；想盯更久就在外层循环里重复调用。
- 画面帧体积不小，默认只回传元信息，要图请显式传 `includeFrameData: true`（单次最多 12 帧）。

---

## 开发

```bash
npm run typecheck        # 类型检查
npm run build            # 编译到 dist/
npm run smoke            # 端到端冒烟：启动服务、真开浏览器、抓取、保存并校验产物
npm run smoke:edge       # 同上，但明确跑 Edge（--browser=chrome / edge / brave ...）
npm run acceptance:edge    # 有头浏览器专项验收：进程枚举、附加已运行的实例、多标签页
npm run acceptance:chrome  # 同上，换 Chrome 跑同一套用例
npm run verify:site        # 实地站点核对：抓取内容与本地目录逐字节比对
npm run verify:sources     # Sources 面板覆盖核对：资源树 + 每个资源能否读到且内容一致
```

每个核对脚本都支持换浏览器：`node scripts/verify-sources.mjs <url> ./site <chrome|edge>`。Chrome 与 Edge 已全部跑绿（`npm run verify:sources` 默认 Edge，加 `chrome` 参数即跑 Chrome）。
npm run inspect          # 以 HTTP 传输启动，便于本地调试
```

模块划分：

```
src/
├── cdp/       轻量 CDP WebSocket 客户端、RemoteObject 转文本
├── browser/   进程枚举、端口发现、安装路径探测、带调试端口启动
├── capture/   环形缓冲 store、DOM 大纲、DevToolsSession（事件接线）
├── export/    HAR / CSV / HTML 报告 / 一键保存
├── live/      事件流订阅管理器、磁盘录制器（JSONL + 帧）
├── tools/     MCP 工具实现
└── server.ts  服务组装（含实时事件的推送接线）
```

---

## License

MIT
