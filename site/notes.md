# notes.md — Markdown 渲染与源文件测试

> 这个文件同时用于两种测试：**源文件直读**（`text/markdown`）和 **渲染后的排版**。
> 编码 UTF-8，无加密、无鉴权，随便读。

## 1. 这个站点里有什么

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 页面 | `index.html` | 入口页，聚合展示下面所有资源 |
| 图片 | `images/banner.png` | 1280×420 渐变光环 |
| 图片 | `images/grid.png` | 720×720 色块网格 |
| 图片 | `images/waves.png` | 960×480 正弦叠波 |
| 音频 | `audio/tone-440hz.wav` | 440Hz 单音，3 秒 |
| 音频 | `audio/chime.wav` | 五音琶音，3.2 秒 |
| 音频 | `audio/sweep.wav` | 200→2400Hz 扫频，5 秒 |
| 文本 | `sample.txt` | 多语言 / 符号 / Emoji 混排 |
| 文档 | `notes.md` | 就是你现在看的这个 |
| 数据 | `data.json` | 给 `fetch()` / `curl` 用的结构化样例 |

## 2. 常用验证手段

- 浏览器直接打开首页，看图片是否能加载、音频是否能播放
- 右键图片 →「在新标签页中打开图像」，验证直链
- 音频点播放，或拖动进度条，验证是否支持 Range 请求（拖动能跳 = 支持）
- `curl -I <文件直链>` 看响应头里的 `Content-Type` 与 `Content-Length`
- `curl -r 0-1023 <大文件直链> -o part.bin` 验证断点续传

## 3. 命令行示例

```bash
# 查看响应头
curl -I https://<你的公网域名>/images/banner.png

# 断点续传取前 1KB
curl -r 0-1023 https://<你的公网域名>/audio/sweep.wav -o head.bin

# 直接抓 JSON
curl https://<你的公网域名>/data.json
```

```js
// 浏览器侧
const res = await fetch('/data.json');
const data = await res.json();
console.log(data.endpoints[0].path);
```

## 4. 注意事项

1. **没有加密**：HTTP/HTTPS 由托管层决定，资源本身不做任何访问控制。
2. **没有鉴权**：任何拿到链接的人都能读，别放真实敏感数据。
3. **没有后端**：纯静态，属性全是浏览器行为，无 Cookie、无数据库。

### 4.1 无序列表测试

- 一级
  - 二级
    - 三级
- 回到一级

### 4.2 有序列表测试

1. 写页面
2. 放素材
3. 起服务
4. 打公网链接
5. 验收

---

*最后一行：如果你能在浏览器里读到这行字，说明 Markdown 源文件读取链路正常。*
