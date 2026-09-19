# 浏览器 Eval 预置项

Eval 的 `browser` 门面负责打开、复用、脚本化并关闭具名的 Chromium、Electron、CDP、中继或 cmux 标签页。静态 URL 请使用 [`read`](./read.md)；认证状态、JavaScript 执行或交互请使用 `browser`。

## 源码

- 宿主门面：`packages/coding-agent/src/tools/browser.ts`
- JavaScript/Python 门面：`packages/coding-agent/src/tools/browser/prelude.{js,py}`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/browser.md`
- 标签页生命周期：`packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- 浏览器 worker 与内部 tab API：`packages/coding-agent/src/tools/browser/tab-worker.ts`
- 浏览器注册表与启动模式：`packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts`
- 中继：`packages/coding-agent/src/tools/browser/relay/`
- Cmux 后端：`packages/coding-agent/src/tools/browser/cmux/`

该预置项仅在 Eval 与 `browser.enabled` 均启用时存在。它不是 AgentTool。

## JavaScript API

```js
const tab = await browser.open({
  name: "main",
  url: "https://example.com",
  wait_until: "load",
});

const observation = await tab.observe();
await tab.id(observation.elements[0].id).click();
const title = await tab.title();

const length = await tab.run(
  async ({ tab }, suffix) => (await tab.title() + suffix).length,
  { args: ["!"], timeout: 30 },
);

await tab.close();
```

- `browser.open(options?) -> Promise<BrowserTab>` 打开或复用一个具名标签页并返回其句柄。
- `browser.tab(name = "main") -> BrowserTab` 返回一个已有的句柄；它不会打开标签页。
- `browser.close({ name?, all?, kill?, timeout? }) -> Promise<void>` 释放一个或全部受管标签页。
- `tab.close({ kill?, timeout? }) -> Promise<void>` 释放该句柄对应的标签页。

`open` 接受 `name`、`url`、`viewport`、`wait_until`、`dialogs`、`app` 和 `timeout`。`timeout` 以秒为单位，默认为 30，并被限制在 1–300 之间。

### 直接 tab 辅助方法

直接辅助方法会跨越宿主桥接，并返回真正的结构化值：

- 导航：`url()`、`title()`、`goto(url, { waitUntil? })`
- 检查：`observe({ includeAll?, viewportOnly? })`、`ariaSnapshot(selector?, { depth?, boxes? })`、`screenshot({ selector?, fullPage?, silent? })`、`extract("markdown" | "text")`
- 交互：`click(selector)`、`type(selector, text)`、`fill(selector, value)`、`press(key, { selector? })`、`scroll(dx, dy)`、`drag(from, to)`、`scrollIntoView(selector)`、`select(selector, ...values)`、`uploadFile(selector, ...paths)`
- 等待：`waitFor(selector, { timeout? })`、`waitForSelector(selector, { timeout?, visible?, hidden? })`、`waitForUrl(stringOrRegExp, { timeout? })`
- 页面执行：`evaluate(fnOrSource, ...args)`

直接的 `waitFor` 和 `waitForSelector` 返回布尔值。`tab.id(number)` 和 `tab.ref("e5")` 则返回 `BrowserElement` 句柄。句柄支持 `click`、`type`、`fill`、`press`、`hover`、`focus`、`select`、`uploadFile`、`scrollIntoView`、`boundingBox`、`isVisible`、`isHidden` 和 `evaluate`。传给 `BrowserElement.evaluate` 的字符串是一个函数表达式，会以该元素作为第一个参数被调用。

选择器接受 CSS 以及 Puppeteer 的 `aria/…`、`text/…`、`xpath/…` 和 `pierce/…` 查询处理器。诸如 `:has-text()` 和 `:visible` 这类仅 Playwright 支持的伪类会被拒绝。`<select>` 元素必须使用 `tab.select`；`tab.fill` 不支持它们。

`observe()` 分配供 `tab.id` 使用的数字 id。`ariaSnapshot()` 分配供 `tab.ref` 使用的 `[ref=eN]` id。导航与重新渲染会使句柄失效；请重新 observe 并在同一个 Eval 单元中操作。

### `tab.run(fnOrCode, options?)`

一次运行接受一个序列化函数或一段 JavaScript 函数体字符串，外加 `{ args?, timeout? }`：

```js
const hrefs = await tab.run(async ({ page }) => {
  return await page.$$eval("a", links => links.map(link => link.href));
});

const title = await tab.run(
  "return await tab.title();",
  { timeout: 10 },
);
```

函数会以 `{ tab, page, browser, wait, assert }` 作为第一个参数，额外的 `args` 紧随其后。普通数据、函数和 `RegExp` 值会被序列化；该函数无法捕获 Eval 单元的闭包。代码字符串中的名称与全局变量同名，并允许顶层 `await`。

内部的 `tab` 是完整的 worker 辅助 API。除直接接口之外，它还包含返回句柄的 `waitFor`/`waitForSelector`，以及运行作用域的 `waitForNavigation`/`waitForResponse`。请在触发导航/响应的动作之前启动等待。

运行使用共享的 JavaScript 运行时，具备常规 Eval 辅助方法与完整的 Bun/Node 及工具桥接访问能力。这是 API 隔离，而非安全沙箱。请求拦截会在每次运行结束时清理。

返回值保持结构化。内部 `display(...)` 调用发出的非空文本会打印在外层 Eval 单元中，对象/图像显示仍属于 Eval 输出，而没有显示文本的运行不会发出占位符。

## Python API

Python 暴露相同的句柄和直接方法名。`open` 与 `close` 使用关键字参数，而 `browser.tab` 和 `tab.id`/`tab.ref` 是同步的句柄查找。直接辅助方法上的关键字参数会成为末尾的 JavaScript 选项对象。

```python
tab = await browser.open(name="main", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
await tab.id(observation["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```

Python 的 `tab.run` 只接受 JavaScript 字符串；它不接受 Python 可调用对象。

## 浏览器模式

显式请求时，`browser.open` 按以下顺序选择浏览器：`app.cdp_url`、`app.path`，然后是 `app.relay`。没有显式选择时，它会依次考虑中继设置、已配置的 CDP、cmux，最后是项目共享的无头 Chromium。

- **无头：** 在项目共享的 Chromium 中创建一个 omp 自有的页面，并应用隐身补丁。
- **派生（`app.path`）：** 启动或复用已启用 CDP 的浏览器/Electron 可执行文件。`app.args` 仅在此模式下生效。
- **连接（`app.cdp_url`）：** 附加到一个已有的 HTTP CDP 发现端点。
- **中继（`app.relay: true`）：** 接管用户真实的 Chrome 标签页。`app.target` 按 URL/标题子串选择；没有它时会接管可见且可用的标签页。
- **Cmux：** 驱动一个可用的 cmux WKWebView 表面。

跨浏览器类型复用同一个标签页名称会被拒绝，直到现有标签页被关闭。关闭 omp 自有的无头页面和自有的 cmux 表面会关闭它们。连接与中继页面保持打开。派生的浏览器进程保持打开，除非 `kill: true` 释放其最后一个受管标签页并终止该进程。

## 截图与输出

`tab.screenshot()` 会把全分辨率图像保存到 `browser.screenshotDir` 之下，未设置时保存到操作系统临时目录，并返回该路径。除非 `silent: true`，它还会发出一张 Eval 图像。它从不接受输出路径。

宿主结果的 `details` 会把结构化的 `value` 与显示内容分开保留。显示文本受共享的内联输出策略约束；超出上限的文本会作为会话产物存储，并打印被截断的文本。

## 安全与生命周期

中继与附加模式作用于真实的已登录会话；站点会把这些操作归因于用户。请指定目标或创建专用标签页。绝不要在未获直接授权的情况下导航用户可见的标签页，或执行有后果的操作。

每个具名标签页有一个 worker，并只允许一个活动运行。超时或被中止的运行可能会回收该 worker 并使句柄失效。`browser.close({ all: true })` 释放所有受管标签页；`kill` 绝不关闭或终止中继/CDP 附加的浏览器。

## 常见恢复

- 标签页缺失/已死：再次调用 `browser.open`。
- id/ref 过期：再次调用 `observe` 或 `ariaSnapshot`，然后重新获取句柄。
- 标签页繁忙：先等待当前活动的辅助方法/运行，再发起另一个。
- 选择器超时：重新 observe 并使用受支持的选择器。
- 中继不可用：安装/启动中继，并验证其 Chrome 扩展连接。
- 附加目标缺失：检查可用页面并使用精确的 `app.target`。

`tab.run` 与直接辅助方法针对实时浏览器状态执行。每次改变 UI 的操作之后都要验证实际页面。
