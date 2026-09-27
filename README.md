# browser-devtools-mcp

An MCP (Model Context Protocol) server that lets an AI assistant inspect a running browser over the **Chrome DevTools Protocol (CDP)** — enumerate browser processes, read everything visible in DevTools (console, network, DOM, performance metrics, storage, screenshots), subscribe to a **live event stream**, and save everything in one shot into a self-contained, offline-readable archive.

It uses a single lightweight WebSocket client to multiplex every tab. No puppeteer, no playwright, no browser bundled — just CDP.

> 🇨🇳 **中文**：一个基于 Chrome DevTools Protocol（CDP）的 MCP 服务，让 AI 助手读取正在运行的浏览器：枚举进程、抓取开发者工具里的一切（console、网络、DOM、性能指标、storage、截图），支持**实时事件订阅**，并支持**一键保存**成离线可读取的归档。只用一条轻量 WebSocket 复用所有标签页，不依赖 puppeteer / playwright，也不绑定任何浏览器。

---

## Supported browsers

**Only Google Chrome and Microsoft Edge are supported and tested.**

| Browser | Supported | Notes |
| --- | --- | --- |
| Google Chrome | ✅ Yes | Verified (Chrome 153.x) |
| Microsoft Edge | ✅ Yes | Verified (Edg 140.x); identical to Chrome on CDP |
| Vivaldi / Brave / Opera / Chromium | ❌ No | Not supported (see below) |
| Firefox / Safari | ❌ No | Not supported (see below) |

Edge and Chrome are fully equivalent — same protocol, same events. Microsoft Edge's built-in extension/service-worker targets are automatically collapsed by `target_list`.

**Why only Chrome and Edge?** This server is built directly on CDP `flatten` session routing, which Chrome and Edge implement correctly. Other browsers diverge:
- **Vivaldi** does not respond to `flatten` session-scoped CDP commands (e.g. `Runtime.enable`); it only answers browser-level commands. A non-`flatten` workaround exists but is not wired in yet.
- **Firefox** removed CDP in v141+ and only speaks WebDriver BiDi, which this server does not implement.
- **Brave / Opera / Chromium** have not been verified and are not claimed as supported.

> 🇨🇳 **中文**：**目前仅官方支持并经过测试的是 Google Chrome 与 Microsoft Edge。**
>
> | 浏览器 | 是否支持 | 说明 |
> | --- | --- | --- |
> | Google Chrome | ✅ 支持 | 已验证（Chrome 153.x） |
> | Microsoft Edge | ✅ 支持 | 已验证（Edg 140.x），CDP 上与 Chrome 完全等价 |
> | Vivaldi / Brave / Opera / Chromium | ❌ 不支持 | 见下方说明 |
> | Firefox / Safari | ❌ 不支持 | 见下方说明 |
>
> Edge 与 Chrome 在 CDP 上完全等价、事件一致；Edge 自带的扩展页 / service worker 会被 `target_list` 自动折叠。
>
> **为什么只支持 Chrome 和 Edge？** 本服务直接基于 CDP 的 `flatten` 会话路由，而 Chrome 与 Edge 对该方式实现正确，其他浏览器存在差异：
> - **Vivaldi** 不响应 `flatten` 会话级 CDP 命令（如 `Runtime.enable`），只对浏览器级命令应答；存在非 `flatten` 的绕行方案，但尚未接入。
> - **Firefox** 自 v141 起已移除 CDP，仅支持 WebDriver BiDi，而本服务未实现 BiDi。
> - **Brave / Opera / Chromium** 未经验证，声明为不支持。

---

## What it does

| Category | Capability |
| --- | --- |
| Browser processes | Enumerate local browser processes, detect which are CDP-attachable, list installed Chromium browsers, scan local debugging ports |
| Connection | Attach to an already-running browser (`--remote-debugging-port` required) or launch an isolated **throwaway profile** instance that never touches your personal config |
| Console | All console output, filterable by level / keyword / time / source page |
| Network | Request & response headers, POST body, timing, initiator, cache hit; response body on demand |
| Errors | Uncaught exceptions, `console.error`, logged errors, renderer crashes — with URL and stack |
| Page | DOM snapshot (HTML + LLM-friendly indented outline), run JS, screenshot, performance metrics, Cookies / localStorage / IndexedDB |
| One-shot save | `session.json`, `console.json`, `console.csv`, `network.har`, `network.csv`, `metrics.json`, `storage.json`, `dom.html`, `dom-outline.txt`, `screenshot.png`, `report.html`, `summary.md`, `manifest.json` |
| **Live** | Subscribe to an event stream: console / every network phase / exceptions / navigation / tab add-remove / performance samples / **page screen frames**; consume via long-poll or server push, or record continuously to disk JSONL |

The exported HAR imports cleanly into Chrome DevTools / Charles / Fiddler; `report.html` is a single self-contained offline report — double-click to open, no external CDN dependencies.

> 🇨🇳 **中文**：
>
> | 类别 | 能力 |
> | --- | --- |
> | 浏览器进程 | 枚举本机浏览器进程、识别可 CDP 附加者、列出已装 Chromium 浏览器、扫描本机调试端口 |
> | 连接 | 附加已有浏览器（需带 `--remote-debugging-port`）或自行拉起**独立临时 profile** 实例，绝不污染个人配置 |
> | console | 全部 console 输出，可按级别 / 关键字 / 时间 / 来源页过滤 |
> | 网络 | 请求与响应头、POST body、timing、initiator、缓存命中；按需取响应体 |
> | 错误 | 未捕获异常、console.error、日志错误、渲染进程崩溃（含 URL 与调用栈） |
> | 页面 | DOM 快照（HTML + 适合 LLM 的大纲）、执行 JS、截图、性能指标、Cookies / localStorage / IndexedDB |
> | 一键保存 | 见上 13 类产物（HAR / CSV / HTML 报告等） |
> | **实时** | 订阅事件流：console / 网络各阶段 / 异常 / 导航 / 标签页增减 / 性能采样 / **页面画面帧**；可长轮询或推送消费，或持续录制到磁盘 JSONL |
>
> 导出的 HAR 可直接导入 Chrome DevTools / Charles / Fiddler；`report.html` 是单文件离线报告，双击即看，无外部 CDN 依赖。

---

## Install

```bash
npm install -g cdp-browser-mcp      # then run: cdp-browser-mcp
# or, without installing:
npx -y cdp-browser-mcp
```

Requires Node.js >= 18.17.

> 🇨🇳 **中文**：`npm install -g cdp-browser-mcp` 后直接运行 `cdp-browser-mcp`；或 `npx -y cdp-browser-mcp` 免安装使用。需要 Node.js >= 18.17。（包名以最终发布为准，若不同请替换。）

---

## MCP client configuration

The server defaults to **stdio** transport (`cdp-browser-mcp`), and can switch to HTTP with `--transport http --port 8931`.

### WorkBuddy

Write to `~/.workbuddy/mcp.json` (note: `mcp.json`, **not** `.mcp.json`):

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "cdp-browser-mcp"
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser-devtools": {
      "command": "cdp-browser-mcp"
    }
  }
}
```

### Cursor

Project or global `~/.cursor/mcp.json`, same shape as above.

After writing the config, restart the client, then click **Trust** on the new server in the connector management page to enable it.

> 🇨🇳 **中文**：服务默认走 **stdio** 传输（命令 `cdp-browser-mcp`），也可加 `--transport http --port 8931` 切到 HTTP。
>
> **WorkBuddy**：写入 `~/.workbuddy/mcp.json`（注意是 `mcp.json`，**不是** `.mcp.json`）。**Claude Desktop**：写入 `claude_desktop_config.json`。**Cursor**：项目级或全局 `~/.cursor/mcp.json`，结构相同。写完后重启客户端，并在连接器管理页对新服务点「信任」启用。

---

## Typical usage

The simplest path — let it launch its own browser:

```
browser_launch({ headless: true, url: "https://example.com" })
```

Then read data directly, no connection step needed:

```
console_read({ level: ["error", "warn"] })
network_list({ httpErrorsOnly: true })
page_errors()
page_dom({ mode: "outline" })
capture_save()
```

To inspect the browser you already use, restart it with a debugging port first:

```bash
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=*
```

Then `browser_discover` finds it and `browser_connect({ port: 9222 })` attaches.

A built-in `diagnose_page` prompt walks the model through a fixed order to debug page issues.

> 🇨🇳 **中文**：最简路径——让它自己开一个浏览器：`browser_launch({ headless: true, url: "https://example.com" })`，随后直接 `console_read` / `network_list` / `page_errors` / `page_dom` / `capture_save` 抓数据，无需先建立连接。要抓你正在用的浏览器，先用调试端口重启它（`chrome.exe --remote-debugging-port=9222 --remote-allow-origins=*`），再 `browser_discover` 找到、`browser_connect({ port: 9222 })` 连上。内置 `diagnose_page` prompt 会引导模型按固定顺序排查页面问题。

---

## Live mode: get events as they happen

Default capture is "read the buffer once" — good for post-mortems. To watch a process over time, use live mode.

**Step 1 — subscribe.** Once subscribed, events are buffered whether or not you are reading, so nothing is lost if you are a beat late:

```
events_subscribe({
  channels: ["console", "network", "error", "navigation", "target"],
  performanceSampleMs: 500
})
-> { subscriptionId: "sub-...", cursor: 1234 }
```

**Step 2 — consume.** Two ways, usable together:

```
events_wait({ subscriptionId, cursor, timeoutMs: 15000 })   # long-poll: returns immediately on data, empty on timeout
events_read({ subscriptionId, cursor })                     # no wait, peek what has accumulated
```

`events_wait` returns `{ events, cursor }`; pass `cursor` straight back next time — no replay, no dropped events. Loop on it to watch a page continuously (works over both stdio and HTTP).

**The server can also push.** Subscriptions default to `push: "notification"`, so the server proactively pushes new events via MCP `notifications/browser-devtools/events` (or `push: "logging"` for standard `notifications/message`). If the client does not understand the notification, push degrades gracefully and events stay in the buffer — polling still works, 100% lossless.

**To see the page moving**, subscribe to the `frame` channel (backed by `Page.startScreencast`):

```
events_subscribe({ channels: ["frame"], frames: { maxWidth: 800, quality: 60, everyNthFrame: 1 } })
events_wait({ subscriptionId, includeFrameData: true, limit: 5 })   # base64 returned only when you ask
```

**For long monitoring without memory blow-up**, record to disk as it arrives:

```
recording_start({ name: "checkout-flow", saveFrames: true, performanceSampleMs: 1000 })
  ... reproduce the steps ...
recording_stop({ recordingId })
```

Artifacts land in `captures/<name>/`: `live-events.jsonl` (one event per line, `jq`-friendly), `frames/00000001.jpg` (screen frames, sequential), `recording-summary.json` (stats). To watch multiple tabs at once: `browser_connect({ watchAllTargets: true })` attaches capture to every page, including ones opened later. The built-in `monitor_live` prompt guides the model through the "subscribe → wait → summarize" rhythm.

Channel reference:

| channel | events | meaning |
| --- | --- | --- |
| `console` | `message` / `error` | console output & `Runtime.exceptionThrown` |
| `network` | `request` / `response` / `finished` / `failed` / `redirect` | full network lifecycle |
| `error` | `exception` / `console` / `log` / `crash` | a new row in the error table (incl. renderer crash) |
| `navigation` | `frame` | top-frame navigation |
| `target` | `created` / `destroyed` / `crashed` | tab / window add-remove |
| `metric` | `sample` | periodic `Performance.getMetrics` per `performanceSampleMs` |
| `frame` | `frame` | page screen frames (needs `frames` to enable streaming) |

> 🇨🇳 **中文**：默认抓取是「一次性读缓冲」，适合事后取证；要盯过程就用实时模式。
> **第一步订阅**：订阅后无论你是否在读，事件都会先入缓冲，不会因慢一步而丢。`events_subscribe({ channels: [...], performanceSampleMs: 500 })` 返回 `{ subscriptionId, cursor }`。
> **第二步消费**：`events_wait`（长轮询，有数据即回、超时回空）与 `events_read`（不等待先看一眼）可并用；`events_wait` 返回 `{ events, cursor }`，下次把 cursor 原样传回即可，不重放、不丢。循环调用即持续监控（stdio / HTTP 皆可）。
> **服务端也能主动推**：默认 `push:"notification"`，通过 `notifications/browser-devtools/events` 推新事件（或 `push:"logging"` 走标准 `notifications/message`）；客户端不认得通知也能优雅降级，事件仍在缓冲、轮询照常。
> **看页面动态**：订阅 `frame` 通道（底层 `Page.startScreencast`）。**长时监控防内存爆**：`recording_start/stop` 边收边写磁盘，产物在 `captures/<name>/`（`live-events.jsonl`、`frames/`、`recording-summary.json`）。多标签页：`browser_connect({ watchAllTargets: true })` 给所有页面（含之后新开）挂抓取。内置 `monitor_live` prompt 引导「订阅→等待→汇总」节奏。通道一览见表。

---

## Tools overview

**Browser**: `browser_list_processes`, `browser_installed`, `browser_discover`, `browser_launch`, `browser_connect`, `browser_close`, `target_list`, `target_select`, `session_info`, `session_dump`

> `target_list` lists only real web pages by default and collapses Edge/Chrome built-in extension pages, service workers, and offscreen documents (a headed Edge often has a dozen of these that would drown the two or three real pages). Pass `includeBackground: true` to see everything. If filtering leaves nothing, it falls back to the full list automatically — you never get a misleading "no tabs" result.

**Content capture**: `console_read`, `console_clear`, `network_list`, `network_detail`, `network_body`, `network_clear`, `resources_list`, `resources_get`, `page_errors`, `page_dom`, `page_evaluate`, `page_screenshot`, `performance_metrics`, `storage_read`

> `resources_list` / `resources_get` mirror the DevTools **Sources → Page** panel: `resources_list` reconstructs the frame tree and every resource that frame loaded; `resources_get` reads any resource's content by URL (equivalent to clicking a file in the panel). Two fallbacks apply when reading: first try the captured request, then re-fetch in-page, so `HEAD` probes, `Range` media requests, and bodies the browser dropped for size are all recoverable.
>
> **Text mojibake fallback**: when the server sends no `charset`, the browser decodes by its locale default (GBK on Chinese Windows — a **lossy** transform), turning Chinese into garbage. `network_body` / `resources_get` first try a reversible single-byte restore, then fall back to an in-page `fetch()` that re-decodes as UTF-8 per the WHATWG spec, guaranteeing the correct original.
>
> **Partial-content fallback**: reading a request before it finishes makes `Network.getResponseBody` silently return what arrived so far. `resources_get` checks completeness and re-fetches in-page if incomplete; `network_body` returns `partial: true` with a hint, so you never mistake a half file for a whole one.
>
> Ordering matters: `resources_get` waits for full load; `network_body` returns "the request captured right now" — different purposes (reproduce the file vs. analyze the actual request).

**Capture & archive**: `capture_start`, `capture_status`, `capture_stop`, `capture_save`, `capture_list_saved`

**Live**: `events_subscribe`, `events_wait`, `events_read`, `events_unsubscribe`, `events_list`, `recording_start`, `recording_stop`

> 🇨🇳 **中文**：
> **浏览器**：`browser_list_processes`、`browser_installed`、`browser_discover`、`browser_launch`、`browser_connect`、`browser_close`、`target_list`、`target_select`、`session_info`、`session_dump`。`target_list` 默认只列真实网页，折叠 Edge/Chrome 自带扩展页、service worker、offscreen 文档；`includeBackground:true` 看全量，过滤到空会自动回退全量。
> **内容抓取**：`console_read`、`console_clear`、`network_list`、`network_detail`、`network_body`、`network_clear`、`resources_list`、`resources_get`、`page_errors`、`page_dom`、`page_evaluate`、`page_screenshot`、`performance_metrics`、`storage_read`。`resources_list`/`resources_get` 对应 Sources → 页面面板，取值有两层兜底（先抓请求、失败页内重拉），并含文本乱码兜底与半截内容兜底。
> **抓取与归档**：`capture_start`、`capture_status`、`capture_stop`、`capture_save`、`capture_list_saved`。**实时**：`events_subscribe`、`events_wait`、`events_read`、`events_unsubscribe`、`events_list`、`recording_start`、`recording_stop`。

---

## Saved artifacts

```
captures/<session>/
├── session.json        raw full data (console / network / errors / dom / metrics / storage)
├── console.json        console logs, structured
├── console.csv         console logs, tabular
├── network.har         HAR 1.2, importable into DevTools / Charles
├── network.csv         network requests, tabular
├── metrics.json        performance metric snapshots
├── storage.json        Cookies / localStorage / sessionStorage / IndexedDB
├── dom.html            page HTML snapshot
├── dom-outline.txt     page structure outline (LLM-friendly)
├── screenshot.png      page screenshot
├── report.html         offline HTML report, double-click to view
├── summary.md          Markdown summary, ready to paste into chat
└── manifest.json       artifact index
```

When capture is large, the report renders only the most recent 500 rows/tables; full data lives in the JSON and CSV.

> 🇨🇳 **中文**：产物目录 `captures/<会话名>/` 含 `session.json`、`console.json`、`console.csv`、`network.har`、`network.csv`、`metrics.json`、`storage.json`、`dom.html`、`dom-outline.txt`、`screenshot.png`、`report.html`、`summary.md`、`manifest.json`。抓取量大时报告只渲染最近 500 行/表，完整数据在 JSON 与 CSV 中。

---

## Known limitations & security

- **Only Google Chrome and Microsoft Edge are supported** (see Supported browsers). Firefox/Safari do not speak CDP and are listed as non-attachable.
- Browsers started with `--remote-debugging-pipe` do not listen on a TCP port and cannot be attached; use `browser_launch` to start an instance.
- **Chrome 111+ requires `--remote-allow-origins=*`**, or the WebSocket handshake is rejected — `browser_launch` adds it automatically.
- Attaching to a debugging port grants full control of that browser. **Do not open a debugging port on a profile holding sensitive accounts.** Instances this server launches always use a throwaway profile, cleaned up asynchronously on close.
- For safety, throwaway-profile deletion is restricted to folders under the system temp directory whose path contains `browser-devtools-mcp`.
- Buffer caps default to 5000 console / 5000 network / 1000 errors / 5000 live events; oldest data is evicted ring-style once exceeded.
- Long-poll `events_wait` is bounded by the client's own timeout (default 15s, max 120s); loop it for longer watches.
- Screen frames are sizable; only metadata is returned by default — pass `includeFrameData: true` to get base64 (max 12 frames per call).

> 🇨🇳 **中文**：**仅支持 Google Chrome 与 Microsoft Edge**（见上）。Firefox/Safari 不走 CDP，会被标为不可附加。用 `--remote-debugging-pipe` 启动的浏览器不监听 TCP，无法附加，请用 `browser_launch`。**Chrome 111+ 必须带 `--remote-allow-origins=*`**（本服务已自动加）。附加调试端口等于获得该浏览器完整控制权，**勿对存敏感账号的 profile 开放调试端口**；本服务自动启动的实例一律用临时 profile 并异步清理，且删除仅限于系统临时目录下含 `browser-devtools-mcp` 的文件夹。缓冲上限默认 console/network 各 5000、错误 1000、实时事件 5000；长轮询 `events_wait` 受客户端超时限制（默认 15s、上限 120s）；画面帧默认只回传元信息。

---

## Development

```bash
npm run typecheck          # type-check
npm run build              # compile to dist/
npm run smoke              # end-to-end: start server, open a real browser, capture, save, verify
npm run smoke:edge         # same, but explicitly Edge (--browser=chrome / edge)
npm run acceptance:edge    # headed-browser acceptance: process enum, attach running instance, multi-tab
npm run acceptance:chrome  # same suite on Chrome
npm run verify:site        # live-site check: capture vs. local directory, byte-for-byte
npm run verify:sources     # Sources-panel coverage: resource tree + every resource readable & correct
npm run inspect            # start over HTTP transport for local debugging
```

Source layout:

```
src/
├── cdp/        lightweight CDP WebSocket client, RemoteObject → text
├── browser/    process enum, port discovery, install-path probe, debug-port launch
├── capture/    ring-buffer store, DOM outline, DevToolsSession (event wiring)
├── export/     HAR / CSV / HTML report / one-shot save
├── live/       event-stream subscription manager, disk recorder (JSONL + frames)
├── tools/      MCP tool implementations
└── server.ts   server assembly (incl. live-event push wiring)
```

> 🇨🇳 **中文**：开发脚本见上（`typecheck` / `build` / `smoke` / `smoke:edge` / `acceptance:edge` / `acceptance:chrome` / `verify:site` / `verify:sources` / `inspect`）。源码结构：`cdp/`（CDP 客户端）、`browser/`（进程枚举/端口发现/启动）、`capture/`（环形缓冲/DOM 大纲/会话接线）、`export/`（HAR/CSV/报告/保存）、`live/`（订阅管理/磁盘录制）、`tools/`（MCP 工具）、`server.ts`（服务组装）。

---

## License

MIT
