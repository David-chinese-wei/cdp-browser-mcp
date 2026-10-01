# 开发进度

> 最后更新：2026-09-28 10:30
> 状态：**已完成并可运行，支持实时订阅，并补齐了 Sources 面板视角** —— 43 个工具全部接通。`typecheck` / `build` 全绿；**Chrome 与 Edge 双浏览器端到端冒烟均通过**，Edge 另有有头模式专项验收（`npm run acceptance:edge`）。
>
> 本轮针对 `https://static-asset-test.app.workbuddy.host/` 做了两轮核对，均为 0 失败：
> - `npm run verify:site` —— 抓取内容与本地 `site/` 目录逐文件 SHA-256 + UTF-8 逐字符比对。
> - `npm run verify:sources` —— 覆盖开发者工具「Sources → 页面」面板：资源树还原 + 每个资源能否读到且内容一致。
>
> 本轮修掉的真 bug 与新增能力：
> 1. **`network_body` 中文乱码（真 bug）**：服务器未声明 `charset` 时浏览器按本机 locale 解码（中文 Windows 为 GBK，**有损**），`Network.getResponseBody` 返回乱码且不可逆。现改为「单字节可逆还原 → 页内 `fetch` 按 WHATWG 规范以 UTF-8 重解」两级兜底。
> 2. **新增 `resources_list` / `resources_get`**（34 → 36）：对应 Sources → 页面 面板，`Page.getResourceTree` 还原 frame 树，按 URL 读任意资源；同样带页内重拉兜底，解决 `HEAD` 探测、`Range` 音视频、超大 body 被丢弃三种读不到的情况。
> 两份核对脚本（`verify:site`、`verify:sources`）在 **Edge 与 Chrome 双浏览器**上均 0 失败。
>
> 位置：`D:/项目/浏览器抓取mcp/`
> 完整背景、选型理由见 `context/上下文交接.md`；历史记忆见 `context/` 下两个 md。

## Chrome 实测与修复（15:50）

同一套核对脚本换 Chrome 跑（`salt: chrome`），暴露出两个**真 bug** 和一批脚本假失败：

1. **`decodedBodyLength` 被重复累加（真 bug，已修）**。`Network.dataReceived` 每个分片触发一次，原代码先通过 `update()` 把 `decodedBodyLength` **覆盖**成当前分片长度，再把它加一次，等于「最后一片 × 2」。污染了 `network.har` 的 `content.size` 与 `network.csv` 体积列——实测 `sample.txt` 被记成 4226（真实 2113）。改为纯粹累加。
2. **`resources_get` 会返回半截内容（真 bug，已修）**。请求还没 `loadingFinished` 就读 body，`Network.getResponseBody` 会静默返回已到达的部分，看起来像完整文件——Chrome 上 `images/waves.png` 因此只取回 9282 字节（应为 63191）。新增 `bodyLooksComplete()`：未完成 / 字节数与 `decodedBodyLength` 不符即自动改走页内重拉；`network_body` 也新增 `partial` 标记并给出提示，避免用户拿到半截还以为完整。
3. **验收脚本写死 Edge（假失败，已修）**。`smoke-edge.mjs` 里 `filter: 'edge'`、`display === 'Microsoft Edge'`、`/edg/i` 三处按 Edge 写死，换 Chrome 跑必然失败。现统一按目标浏览器推导展示名与 UA 标识，背书 `${DISPLAY}`；`target_list` 后台过滤断言也放宽（Chrome 有头实例的后台目标数与 Edge 不同）。
4. **核对脚本稳定性（已修）**。`verify-sources.mjs` 原先固定 sleep 6s 就抓资源树，懒加载资源没到位时树只有 1 项，比对形同虚设。改为轮询直到资源树连续两次不变（等同人在 DevTools 里等页面加载完再看 Sources）。

**结论：Chrome 本身没坏。** `chrome.exe --version` 会吐一堆 GCM / TensorFlow 的无关噪声日志，容易被误判；实测 `--headless --dump-dom` 正常出内容，153.0.8010.53 全流程可用。

## 技术选型（未变）
- TypeScript / Node.js（ESM、Node16 模块解析、strict）
- 依赖：`@modelcontextprotocol/sdk` ^1.0.4（实际装 1.30.1）、`ws`、`zod`（实际 3.25.76）
- CDP 传输自研轻量 WebSocket 客户端，不引 puppeteer / playwright
- 连接策略：附加已有浏览器（扫描 9222–9400）+ 自动启动独立 profile 实例

## 文件清单

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `package.json` / `tsconfig.json` / `.gitignore` / `LICENSE` | ✅ | 骨架 |
| `README.md` | ✅ | 安装、三种客户端的 MCP 配置、工具一览、产物说明、安全提示 |
| `src/types.ts` | ✅ | 数据模型；新增内部字段 `_cdpStart` / `_cdpEnd`（不进导出）；**＋ `PageResource` / `ResourceTreeNode` / `ResourceTreeSnapshot`** |
| `src/cdp/client.ts` | ✅ | ＋ `normalizeTarget()`（修 targetId/id 不一致） |
| `src/cdp/remote-object.ts` | ✅ | RemoteObject → 文本 |
| `src/browser/{process,discovery,install,launch}.ts` | ✅ | launch 的 profile 删除改为异步后台 |
| `src/capture/store.ts` | ✅ | 环形缓冲 ＋ **实时事件总线**：全局增量游标、事件环形缓冲、`onEvent/emit/eventsSince/dropOlderThan` |
| `src/capture/dom.ts` | ✅ | ＋ 处理 document 根节点（nodeType 9，CSS 之前无法生成大纲） |
| **`src/capture/session.ts`** | ✅ **新增** | 事件接线核心：flatten attach、域 enable、console/network/errors/navigation/crash 全部入库；evaluate / getDom / screenshot / performance / storage / networkBody。**＋ 实时：7 类通道事件、`Page.startScreencast` 推流、`Performance` 定时采样、`watchAllTargets` 自动挂新标签页**。**＋ 文本乱码兜底（`recoverTextBody`）、Sources 资源树（`resourceTree` / `resourceBody` / `fetchResourceInPage`）** |
| **`src/export/har.ts`** | ✅ **新增** | NetworkEntry → HAR 1.2，含 timing 换算与 pageTimings |
| **`src/export/csv.ts`** | ✅ **新增** | network.csv / console.csv ＋ Markdown 摘要，含公式注入防护 |
| **`src/export/report.ts`** | ✅ **新增** | 自包含离线 HTML 报告，浅色主题，带 tab 切换与表格过滤 |
| **`src/export/save.ts`** | ✅ **新增** | 一键落盘 13 类产物 + manifest |
| **`src/hub.ts`** | ✅ **新增** | 会话中枢：连接复用、自动附加、已保存索引；**＋ 挂载 LiveManager、管理磁盘录制** |
| **`src/live/manager.ts`** | ✅ **新增** | 订阅管理器：通道/关键字/级别/标签页过滤、每订阅缓冲、游标续接、长轮询 wait、合并推送（40ms debounce） |
| **`src/live/recorder.ts`** | ✅ **新增** | 实时录制：`live-events.jsonl` 增量写入、`frames/` 画面帧、`recording-summary.json` 统计 |
| **`src/tools/{browser,content,capture,support}.ts`** | ✅ **新增** | 抓取类 MCP 工具 |
| **`src/tools/live.ts`** | ✅ **新增** | 实时类工具：`events_subscribe/wait/read/unsubscribe/list`、`recording_start/stop` |
| **`src/server.ts` / `src/index.ts`** | ✅ **新增** | 服务组装；stdio 为主，另支持 `--transport http --port N`；**＋ 实时事件推送接线** |
| **`scripts/smoke.mjs`** | ✅ **新增** | 端到端冒烟：真开浏览器 → 抓本地测试页 → 保存 → 校验产物 |

## 实时模式（本轮新增）

目标：让 AI 不必反复轮询缓冲区，事件一发生就能拿到。三层设计：

1. **产出层**（`store` + `session`）：所有入库动作同时发一条带全局递增 cursor 的 `LiveEvent`，通道分 console / network / error / navigation / target / metric / frame。
2. **分发层**（`live/manager`）：订阅 = 过滤器 + 每订阅环形缓冲 + 游标。`events_wait` 是长轮询（有数据立刻返回，超时返回空），因此 stdio 也能实时；同时每 40ms 合并一次向 transport 推送 MCP 通知。
3. **消费层**（`tools/live.ts`）：7 个工具；另提供 `recording_*` 把流持续写进 JSONL + 帧图片，适合长时间监控。

关键取舍：**缓冲优先于推送**。即便客户端完全不支持通知，事件也先写进订阅缓冲再由 `events_wait` 拿，永不丢量；推送失败自动降级到 `push: 'none'` 而不报错。

## Edge 浏览器验证（本轮）

Edge 与 Chrome 同为 Chromium，`browser_launch({ kind: 'edge' })` 直接可用，全程等价。新增 `scripts/smoke-edge.mjs` 做有头模式专项验收，覆盖冒烟脚本没走的场景：

- **有头模式**（`headless=false`，会弹出真实窗口）
- **进程枚举**：`msedge.exe` 被识别为 Microsoft Edge / chromium 家族 / 可附加，并能从命令行解析出 `--remote-debugging-port` 与 `--remote-allow-origins=*`
- **附加已运行的实例**：`browser_launch({ attach: false })` 后再 `browser_connect`，而非依赖 launch 的自动附加
- **watchAllTargets**：连接后用 `window.open` 开新标签页，无需重连即可抓到它的 console
- 真实外部站点 + 实时录制 + 一键保存，产物送到 `captures/edge-acceptance-site/`

## 本轮修的 bug（Edge 测试挖出来的）

1. **`Browser.getVersion` 返回 camelCase（`product` / `protocolVersion` / `userAgent`），代码却按 HTTP 端点 `/json/version` 的 PascalCase（`Browser` / `Protocol-Version`）取值** —— 结果 `meta.browser` 恒为 `'Chromium'`、`browserVersion` 恒为空。静默错数据，比崩溃更隐蔽。现已两者兼容，`meta` 新增 `browserUserAgent` / `protocolVersion`。
2. **`hub.connect` 把 `protocolVersion` 塞进了 `browserVersion`**，且因为 session 里用的是 `??`，外部传值会短路掉正确解析。现在 hub 只传 UA，版本一律由 session 从 product 串解析。
3. **`summary.md` 里写 `(protocol ${browserVersion})`** —— 标签说协议，填的是浏览器版本，两个数字都是错的。改为 `产品串（CDP 协议版本）`，且版本不重复。
4. **`target_list` 返回所有目标且不含 `type`** —— 有头 Edge 上一份 13 个目标里有 9 个是自带扩展页 / service worker / offscreen 文档，真实页面被淹没。改为默认折叠后台目标（`includeBackground: true` 看全量），返回带 `type`；并加了「过滤到空则回退全量」的保护，避免出现"看起来没标签页"的假象。

## 测试脚本本身的坑（别重犯）

- `--browser` 参数解析：`find(a => a.startsWith(...))` 找不到时返回 `''`，再 `indexOf('')` 得到 `-1`，于是取到了 `process.argv[0]`（node 路径）。用 `findIndex` 判 -1 再取。
- 「附加之后才有网络数据」：若页面在附加前已加载完，`network_list` 必然为空，这是正确行为。测试要验证网络采集就得在附加之后重新导航一次。
- 404 不要依赖 favicon：浏览器是否请求 favicon 取决于窗口形态（有头 / headless 不一致）。显式 `fetch('/xxx-404')` 才稳定。
- `page_screenshot` 默认 `returnBase64: false`，断言 `shot.data` 存在必然失败——那正是避免挤爆上下文的设计。

## 本轮：公网站点核对 + network_body 乱码修复（2026-09-27 续）

用户要求用公网站点 `https://static-asset-test.app.workbuddy.host/`（内容全部在 `site/`）实测，核对 MCP 提取内容与本地目录是否一致。

新增 `scripts/verify-site.mjs`：两层校验 ——
- **A 层**：页面内 `fetch` 每个资源算 SHA-256 + UTF-8 逐字符比对（防乱码）。
- **B 层**：`network_list` 覆盖、`network_body` 取回原文、`page_dom`、`capture_save` 落盘 DOM 与 HAR，全链路核对。

首跑 B 层 13 项失败，定位两类根因：

1. **`network_body` 把无 charset 的 UTF-8 文本解码成乱码（真 bug，已修）。**
   - `site/` 以 `text/plain`、`text/markdown` 提供，**未带 `; charset=utf-8`**。CDP `Network.getResponseBody` 用服务端声明的 charset 解码；没声明时退回浏览器**区域默认编码**——英文系统通常 Latin-1/CP1252（字节可逆），但中文 Windows 上是 **GBK**，把原始 UTF-8 字节**不可逆**地改坏。结果 `sample.txt`/`notes.md` 经 `network_body` 取回的是乱码（2113/2315 字符 = 字节数，而非 1310/1416 字符）。`data.json`（`application/json`）因 CDP 强制 UTF-8 解码而正常。
   - 修复（`src/capture/session.ts` 的 `networkBody` / `recoverTextBody`）：串行尝试 (a) 声明了 charset 直接信任；(b) 单字节（Latin-1/CP1252）做「字节→UTF-8」往返，往返一致即采用（覆盖英文系统常见情形）；(c) 仍不匹配时，通过页面 `fetch(url)` 重新拉取——按 WHATWG Fetch 规范，`Response.text()` 对无 charset 文本**默认按 UTF-8 解码**，拿到原始字节正确解码结果。只对同域 GET 文本资源走该兜底，失败则保留原文。
2. **verify 脚本的断言写错（非 MCP bug）：**
   - 「没有失败请求」把 `favicon.ico` 404、页面脚本的 `fetch(HEAD)` 预检、以及 `net::ERR_ABORTED`（导航中止的良性请求）都算成了失败。已加 `benign()` 过滤。
   - B2 用 `encodedDataLength`（含 HTTP 响应头）和 `hits[0]`（可能是 `<audio preload>` 的 Range 请求，仅 190 字节）比对，大小永远对不上。已改为取同 URL 中体积最大的一条，并允许响应头余量。

验证：`verify-site.mjs` 对**本地**（python http.server）与**公网**两种来源均 0 失败（`✓ 公网站点内容与本地目录完全一致，抓取链路无缺失`）；`npm run smoke` 回归全绿。

### 教训
- 静态资源服务 UTF-8 内容**必须声明 `charset=utf-8`**，否则任何依赖 charset 的消费者（CDP `getResponseBody`、浏览器默认解码）都可能乱码。唯一例外是 `fetch().text()`——WHATWG 规范默认无 charset 文本按 UTF-8。
- `Network.getResponseBody` 的 `base64Encoded:false` 不代表「已正确 UTF-8 解码」；无 charset 时 Chromium 用区域默认编码，中文 Windows 上尤其危险（GBK 不可逆）。

## 本次新踩的坑（写进注释了，别改回去）

1. **MCP SDK 的 Server 要发通知得用 `server.notification()`**（不是 `sendNotification`，那是 Protocol 内部字段）；自定义 method 的 `assertNotificationCapability` 走 default 分支不报错，但 `notifications/message` 必须在 capabilities 里声明 `logging: {}`——两者都已处理。
2. **`LiveManager` 里 `unsubscribe` 既是私有字段又是方法名**，导致 `hub.live.unsubscribe(id)` 类型报错 2721；字段改名为 `detachListener`。
3. 画面帧体积大：事件环里额外做 `dropOlderThan('frame', 12)` 只留最近几帧；工具读取时默认不带 base64，`includeFrameData` 也要限制单次最多 12 帧。
4. **长轮询的唤醒条件要按「自 waiter 游标以来的条数」判断**，不能简单用 `buffer.length`：否则第二次之后的 wait 会因缓冲区里残留旧数据而立刻返回「没有新事件」，客户端据此循环就会退化成忙轮询。`wake()` 里已改为按 waiter 游标计数。
5. 冒烟里量实时事件不能直接断言「一次 wait 就有 console + navigation」：事件是陆续到达的，必须**循环长轮询累计**，否则会误判为漏事件。所有目标被塞进同一个 `undefined` 键互相覆盖，导致 map 里只剩一个、找不到 page 而无法 attach。`normalizeTarget()` 统一收口，`Target.getTargets` 与 `Target.targetInfoChanged` 都要过它。
2. **`DOM.getDocument` 返回的是 document 节点（nodeType 9）不是元素**，不特殊处理的话大纲渲染出来是空字符串。
3. **Windows 上 `rmSync` 删 Chrome profile 要 40+ 秒**（几万个小文件 + Defender 逐文件扫描），会把工具调用卡到 MCP 超时。改为 detached 子进程后台删除，工具立即返回。
4. 新版 Chrome 的 ResourceType 是**首字母大写**（`Script`/`Document`/`Fetch`），旧版是小写。过滤逻辑已做大小写不敏感处理。
5. headless 启动后第一个 tab 可能是 `chrome://newtab/`，要轮询等一下真实页面出现；自动选择时优先 http(s) 文档。

## 之前的坑（依然有效）
- Chrome 111+ 必须加 `--remote-allow-origins=*`，否则 WS 握手被拒
- `--remote-debugging-pipe` 的浏览器无法通过 TCP 附加
- Windows 枚举进程用 PowerShell CIM（wmic 已弃用），`ConvertTo-Json` 单结果返回对象不是数组
- Firefox 不走 CDP → 标注不可附加
- 时间口径：wall clock 用 `Date.now()`，耗时用 CDP timestamp 差值（monotonic，不是 epoch）

## 下一步（开源前）
- `git init` + 首次提交；`.gitignore` 已含 `captures/`、`dist/`、`node_modules/`
- 决定要不要发 npm 包（`bin` 与 `files` 已配好）
- 可选增强：多目标并发采集、Network 域可选抓取响应体、`--headless` 之外的持久化 session

## 验证方式
```bash
npm run typecheck        # 类型检查
npm run build            # 编译到 dist/
npm run smoke            # 端到端：握手 → 列工具 → 开浏览器 → 抓页面 → 实时 → 保存 → 校验 → 关闭
npm run smoke:chrome     # 同上，明确跑 Chrome
npm run smoke:edge       # 同上，明确跑 Edge
npm run acceptance:edge  # Edge 专项：有头模式、进程枚举识别 msedge、附加已运行实例、多标签页
```

浏览器支持矩阵（同一用例跑通即可认为支持）：

| 浏览器 | headless 冒烟 | 有头专项验收 | 备注 |
| --- | --- | --- | --- |
| Google Chrome | ✅ 通过 | ✅ 通过 | 153.0.8010.53，修过 2 个真 bug（decodedBodyLength 累加 / resources_get 半截） |
| Microsoft Edge | ✅ 通过 | ✅ 通过 | Edg/140.0.3485.54 |
| Vivaldi | ❌ 受阻 | ❌ 受阻 | 8.2.4133.76：浏览器级 CDP 正常，但 **flatten 会话命令（`Runtime.enable` 等）一律 8s 无响应**；非 flatten + `Target.sendMessageToTarget` 路由可通，需重构会话命令层才能支持 |
| Firefox | ❌ 不支持 | ❌ 不支持 | 156.0.1 已移除 CDP，仅 WebDriver BiDi 可用；MCP 是 CDP 架构，未集成 |
| Opera / Brave | ❌ 未测 | ❌ 未测 | 本机安装失败（exit -1，权限问题），暂无法验证 |

> ⚠️ **已证伪旧假设**：先前以为"Vivaldi headless 35s 超时是因为缺 `--disable-gpu`"。实测证实相反——带 `--disable-gpu` 反而让 Vivaldi 连调试端口都起不来；真正根因是 **Vivaldi 不响应 flatten 会话作用域的 CDP 命令**，而 MCP 当前（`session.ts` 的 `attachToTarget` + 命令带顶层 `sessionId`）用的正是 flatten 方式。本机 Chrome/Edge 用同方式秒回，只有 Vivaldi 挂起。

## 多浏览器实测（2026-09-27 17:xx，接上一轮"其他主流浏览器"任务）

用户要求支持"360 除外、火狐可以"的其他主流浏览器。结果：

- **Chrome / Edge**：稳定通过，全部 36 工具 + Sources 面板，verify:site / verify:sources 双浏览器公网 0 失败。
- **Vivaldi 8.2.4133.76**（已安装）：
  - `browser-level` CDP 完全正常：`Target.getTargets` 35ms、`createTarget`、`attachToTarget`（返回 sessionId）都秒回。
  - **session 级命令（`Runtime.enable` / `Runtime.evaluate`）一律超时**：flatten 方式下 8s 无任何回包。先前"headless 正常"的误判，是因为那次探针漏带 `sessionId`、实际只测了浏览器级命令。
  - 改用 **`flatten:false` + `Target.sendMessageToTarget` 转发**后，`Runtime.enable` 8ms 返回 OK → 证明 Vivaldi 只是不吃 flatten 会话路由，并非不能驱动。
  - **修复方向（未做）**：让 `session.ts` 对 Vivaldi 走非 flatten 会话（attach 时 `flatten:false`，所有命令经 `Target.sendMessageToTarget` 发出、结果从 `Target.dispatchMessageFromTarget` 事件回收）。这是会话命令层的重构，会动到 `client.send` / `attachToTarget` / 事件分发，需保证 Chrome/Edge 不回归，**不宜在"问进度"时擅自改**。
- **Firefox 156.0.1**：`/json/version` 返回 404（CDP 已移除，v141+ 起），WebDriver BiDi 可用（导航/DOM/网络/截图/storage 已用 `probe-firefox-bidi.mjs` 验证通过），但 MCP 是 CDP 架构，集成 BiDi 是更大的工作量（需抽象传输层），本轮未做。Firefox 仅允许 1 个并发 session。
- **Opera / Brave**：本机安装均 `exit -1`（权限），未测试。
- **360 浏览器**：按用户要求排除。
- 清理了临时探针：`scripts/probe-vivaldi*.mjs` 为诊断脚本，结论已记入本文档与 memory。

## 发布（2026-09-27 晚）

- 用户以 granular access token（bypass 2FA）授权，`npm publish` 成功：**`cdp-browser-mcp@0.1.0`**（tarball `ad11eac0…`，122.2 kB / 75 文件，仅含 dist/README/LICENSE/package.json）。
- 线上验证：`npm view cdp-browser-mcp` 正常返回；干净目录 `npm install cdp-browser-mcp` 安装成功，bin `cdp-browser-mcp` 可用。
- 注意：原 `browser-devtools-mcp` 名已被占（废弃包），故改名发布。

## 本轮：补齐"真实运行时交互"能力（2026-09-28）

用户读源码后给出差距清单（P0/P1/P2），要求"有问题修吧"。已完成 P0 + P1，并顺带实现 P2 里的 `page_reload` / `page_back`。工具数 36 → 43（+7：`cdp_send` / `page_click` / `page_key` / `page_type` / `page_wait_for` / `page_reload` / `page_back`）。

新增/改动：
- **`cdp_send`**：任意 CDP 命令透传，支持 `browserLevel`（发往浏览器根，不带 sessionId）。一次性解锁 `Emulation.*` / `Page.bringToFront` / `DOM.focus` 等未单独封装的能力。
- **`page_click` / `page_key` / `page_type`**：走真正的 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`（真实输入管线事件），而非页内 `dispatchEvent` 合成事件——后者被游戏/Canvas/视频忽略。
- **`page_wait_for`**：轮询直到选择器出现 / 文本包含 / JS 表达式为真。
- **`page_reload` / `page_back`**：`Page.reload` / `history.back()`。
- **`browser_launch` / `browser_connect` 暴露 `emulateVisible`**：让无头页面保持"活跃"生命周期，rAF / 游戏循环不被冻结。
- **`page_evaluate` 暴露 `timeoutMs`**（默认 30000）。
- **端口探测范围 9222–9235 → 9222–9400**（`pickFreePort` 改为区间扫描）。

### ⚠️ 关键发现：Chrome 154 移除了 `Emulation.setPageVisibilityOverride`

本地 Chrome 实测版本 **154.0.8037.92**。逐一探测后确认：
- `Emulation.setPageVisibilityOverride` → **`wasn't found`**（已从协议移除）
- `Emulation.enable` → **`wasn't found`**（该域本来就无 `enable` 命令；原先 `enableDomain('Emulation')` 发的就是个不存在的命令，只是被静默吞掉成了 warning 噪声）
- `Emulation.setVisibilityState` → 不存在
- 但 `Emulation` 域本身仍在：`setEmulatedMedia` / `setDeviceMetricsOverride` / `setFocusEmulationEnabled` / `setCPUThrottlingRate` / `setVirtualTimePolicy` / `setIdleOverride` / `setScrollbarsHidden` 全部可达。
- 受支持的可见性等价替代是 **`Page.setWebLifecycleState({ state: 'active' })`**（FOUND），它把页面钉在 active 生命周期，避免被冻结/节流。

因此 `emulateVisible` 的实现改为：会话 attach 时调用 `Page.setWebLifecycleState({state:'active'})`；`browser_launch` 在 `emulateVisible` 时额外加 `--disable-backgrounding-occluded-windows`（已有 `--disable-renderer-backgrounding` / `--disable-background-timer-throttling`）。本机 Chrome 154 无头下 `document.visibilityState` 本来就报告 `visible`，但加这两层保证真实游戏/Canvas 的 rAF 不被挂起。

### 验证

- `scripts/verify-interaction.mjs`（新增集成测试）：启动无头 Chrome + `emulateVisible`，构建记录真实事件的页内探针，逐项验证 → **6/6 通过**（visibilityState 可见、`cdp_send` 返回对象、`page_click` 在 (30,30) 派发真实鼠标、`page_key` 发出 keydown/keyup 且 code=KeyD、`page_type` 输入 "hello"、`page_wait_for` 命中 predicate）。
- 注意测试探针的坑：原先用 `document.open();document.write('<script>...')` 注入监听器，但在已加载的 about:blank 上**内联 `<script>` 不会执行**，导致监听器从未挂载、事件全部丢失。改为用 DOM API 直接 `document.body.innerHTML=...` + `addEventListener` 后，全部通过。
- `npm run build` 全绿（tsc 0 错误）。

### 遗留 / 可选（用户原 P2，本次未做）

- `page_drag`（拖拽）
- `network_block` / `network_mock`（Network domain 拦截与桩数据）
- `page_screenshot` 的 `clip` 参数（裁剪区域）
- 这些可按需再加；已实现的 `cdp_send` 已能直接发 `Network.setBlockedURLs` / `Page.captureScreenshot({clip})` 等命令作为临时手段。
