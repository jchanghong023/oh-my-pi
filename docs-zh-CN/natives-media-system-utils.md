# 原生媒体与系统工具

本文档涵盖 `@oh-my-pi/pi-natives` 中当前存在的媒体/系统/转换导出项：音频采集与播放、实时 WebRTC 媒体、终端 SIXEL 与 snapcompact PNG 编码、HTML 转换、剪贴板访问、token 计数、DeviceCheck、macOS 外观与电源辅助工具，以及工作性能分析。

## 实现文件

- `crates/pi-natives/src/audio.rs`
- `crates/pi-natives/src/live.rs`
- `crates/pi-natives/src/snapcompact.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/devicecheck.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

当前的 `pi-natives` 插件中并不存在原生 `PhotonImage` 类、`image.rs` 或 ProjFS 覆盖层辅助模块。通用的图像解码/缩放/编码预期应位于此接口之外；此处的图像相关导出仅为终端 SIXEL 编码和 snapcompact PNG 帧渲染。

## JS API ↔ Rust 导出/模块映射

| JS 导出                                 | Rust N-API 导出                 | Rust 模块       |
| --------------------------------------- | ------------------------------- | --------------- |
| `new AudioCapture(sampleRate, cb)`      | `AudioCapture`                  | `audio.rs`      |
| `new AudioPlayback(sampleRate)`         | `AudioPlayback`                 | `audio.rs`      |
| `new LiveWebRtcPeer(...)`               | `LiveWebRtcPeer`                | `live.rs`       |
| `encodeSixel(bytes, width, height)`     | `encode_sixel`                  | `sixel.rs`      |
| `renderSnapcompactPng(text, options)`   | `render_snapcompact_png`        | `snapcompact.rs`|
| `snapcompactSupportedChars(font, chars)`| `snapcompact_supported_chars`   | `snapcompact.rs`|
| `htmlToMarkdown(html, options?)`        | `html_to_markdown`              | `html.rs`       |
| `copyToClipboard(text)`                 | `copy_to_clipboard`             | `clipboard.rs`  |
| `readImageFromClipboard()`              | `read_image_from_clipboard`     | `clipboard.rs`  |
| `countTokens(input, encoding?)`         | `count_tokens`                  | `tokens.rs`     |
| `detectMacOSAppearance()`               | `detect_macos_appearance`       | `appearance.rs` |
| `MacAppearanceObserver.start(cb)`       | `MacAppearanceObserver::start`  | `appearance.rs` |
| `MacOSPowerAssertion.start(options?)`   | `MacOSPowerAssertion::start`    | `power.rs`      |
| `getWorkProfile(lastSeconds)`           | `get_work_profile`              | `prof.rs`       |
| `deviceCheckGenerateToken()`            | `device_check_generate_token`   | `devicecheck.rs`|

## 数据格式边界与转换

### 音频与实时 WebRTC

- `AudioCapture(sampleRate, callback)` 打开默认麦克风，并以请求的逻辑采样率交付低延迟的单声道 `Float32Array` PCM 数据块。`stop()` 立即释放采集。
- `AudioPlayback(sampleRate)` 打开默认扬声器。`write(samples)` 按顺序排队单声道 `Float32Array` PCM；`setGain(gain)` 即使对已排队的样本也会改变渲染时的增益；`end()` 排空并关闭，而 `stop()` 立即丢弃已排队的音频。
- `LiveWebRtcPeer(onEvent, onLevel, onFailure)` 持有一个用于 Codex 实时媒体的 WebRTC 对等连接。`createOffer()` 返回 SDP，`acceptAnswer(sdp)` 应用远端应答，`waitForOpen(timeoutMs?)` 等待 `oai-events` 数据通道，`pushAudio()` 排队 16 kHz 单声道 PCM，`setMuted()` 控制传输，`close()` 拆解媒体、数据通道、对等连接与播放。

### SIXEL 图像编码（`sixel`）

- **JS 输入边界**：包含已编码图像字节的 `Uint8Array`。
- **Rust 解码边界**：使用 `ImageReader::with_guessed_format()` 猜测格式，然后解码为 `DynamicImage`。
- **缩放边界**：仅当源尺寸与 `targetWidthPx`/`targetHeightPx` 不同时，才使用 `resize_exact(..., FilterType::Lanczos3)` 进行缩放。
- **输出边界**：`encodeSixel(...)` 同步返回 SIXEL 转义字符串。

支持的解码格式取决于此次构建中编译进 `image` crate 供 `ImageReader` 使用的格式（通常为 PNG/JPEG/WebP/GIF）。无效的目标尺寸（宽度或高度为 `0`）将失败，并提示 `Target SIXEL dimensions must be greater than zero`。

### Snapcompact PNG 渲染

`renderSnapcompactPng(text, options)` 在有界位图上渲染预归一化的文本，并异步返回一个 **base64 编码的 PNG 字符串**。N-API 传输类型为 `Latin1String`，但该字符串包含的是 base64 文本而非原始的单字节 PNG 数据；在将结果当作 PNG 字节处理之前，需先进行 base64 解码。`options.size` 为必填；可选控制项包括 `font`、`cellWidth`、`cellHeight`、`variant`、`lineRepeat`、`stretch` 和 `columns`。输出高度贴合实际使用的行数，超出部分输入会被忽略。`snapcompactSupportedChars(font, chars)` 仅返回由所指定捆绑字体支持的字符。

### HTML 转换（`html`）

- **JS 输入边界**：HTML `string` + 可选的 `{ cleanContent?: boolean; skipImages?: boolean }`。
- **Rust 转换边界**：转换通过 `task::blocking("html_to_markdown", (), ...)` 调度；此导出无超时/中止选项。
- **输出边界**：Markdown `string` Promise。

转换行为：

- `cleanContent` 默认为 `false`。
- 当 `cleanContent=true` 时，使用 `PreprocessingPreset::Aggressive`、`remove_navigation=true` 和 `remove_forms=true` 启用预处理。
- `skipImages` 默认为 `false`，并传递给 `html_to_markdown_rs::ConversionOptions`。

### 剪贴板（`clipboard`）

- `copyToClipboard(text)` 是使用 `arboard::Clipboard::set_text` 的同步原生调用。在 Linux 上，整个进程生命周期内会保留一个 `Clipboard` 实例（X11/Wayland 的选区所有权）；macOS/Windows 每次调用使用一个临时实例。
- `readImageFromClipboard()` 在 `task::blocking("clipboard.read_image", (), ...)` 中运行。
- 当 `arboard` 报告 `ContentNotAvailable` 时，图像读取返回 `null`/`undefined`。
- 成功读取图像会将剪贴板的 RGBA 数据转换为 PNG 字节，并返回 `{ data: Uint8Array, mimeType: "image/png" }`。
- 剪贴板访问或图像编码失败将以原生错误 reject/抛出。

当前 `packages/natives` 中不存在发出 OSC52、处理 Termux 或抑制原生剪贴板失败的 TS 包装。任何尽力而为的剪贴板策略都必须由调用方实现。

### Tokens（`tokens`）

- `countTokens(input, encoding?)` 接受单个字符串或字符串数组。
- 数组返回一个聚合 token 计数；数组元素通过 rayon 并行编码。
- 默认编码为 `O200kBase`；同时导出 `Cl100kBase`。
- 实现使用 `encode_ordinary`，而非特殊 token 处理。
- BPE 表通过 `LazyLock` 初始化一次后重复使用。

### DeviceCheck

`deviceCheckGenerateToken()` 在原生辅助工具的一秒等待内解析为 `{ supported, tokenBase64?, error?, latencyMs }`。它在结果中报告不支持的平台/设备以及生成失败，而非要求必须存在 token。

### macOS 外观与电源辅助工具

- `detectMacOSAppearance()` 返回 `"dark"`、`"light"`，在非 macOS 上返回 `null`。
- `MacAppearanceObserver.start(callback)` 返回一个带 `stop()` 的句柄；在 macOS 上使用分布式通知加上 2 秒轮询回退，在非 macOS 上是 no-op 观察器。
- `MacOSPowerAssertion.start(options?)` 返回一个带 `stop()` 的句柄；在 macOS 上获取一个或多个 IOKit 断言，在其他平台上是 no-op 句柄。
- 电源断言选项为 `{ reason?, idle?, system?, user?, display? }`。如果所有布尔值都未设置或省略，则默认使用 `idle` 行为。

### 工作性能分析（`prof`）

- **采集边界**：性能分析样本由 `task::blocking` 和 `task::future` 中 `profile_region(tag)` 守卫产生。
- **存储格式**：固定大小的环形缓冲区（`MAX_SAMPLES = 10_000`），存储栈路径、持续时间与时间戳。
- **输出边界**：`getWorkProfile(lastSeconds)` 返回：
  - `folded`：折叠栈文本（火焰图输入）
  - `summary`：markdown 表格摘要
  - `svg`：可选的火焰图 SVG
  - `totalMs`、`sampleCount`

## 生命周期与状态转换

### SIXEL 生命周期

1. `encodeSixel(bytes, targetWidthPx, targetHeightPx)` 校验目标尺寸。
2. Rust 猜测并解码已编码的图像。
3. 如有需要，图像被精确缩放到目标尺寸。
4. 像素被转换为 RGBA8，并使用 `icy_sixel::sixel_encode` 进行编码。
5. SIXEL 转义字符串同步返回。

失败转换：

- 格式检测/解码失败抛出异常。
- 无效的目标尺寸抛出异常。
- SIXEL 编码失败抛出 `Failed to encode SIXEL: ...`。

### HTML 生命周期

1. `htmlToMarkdown(html, options)` 调度一个阻塞的转换任务。
2. 除非另有指定，转换以默认选项（`cleanContent=false`、`skipImages=false`）运行。
3. 上游转换器负责归一化和预处理，将受影响的辅助遍历改为迭代式，并将剩余的递归 DOM 遍历上限限制为 64；达到该上限将拒绝转换，而非返回部分 Markdown。
4. 返回 markdown 字符串或以 `Conversion error: ...` 拒绝。

### 剪贴板生命周期

- 文本复制同步调用 `set_text`；macOS/Windows 每次调用构造一个临时 `arboard::Clipboard`，而 Linux 在首次复制时初始化一个进程级实例并重复使用。
- 图像读取会构造一个 `arboard::Clipboard`，调用 `get_image`，在成功时编码 PNG，将 `ContentNotAvailable` 映射为 `None`，并拒绝其他错误。

### 工作性能分析生命周期

1. 无显式启动：当任务辅助工具执行时，分析处于活动状态。
2. 每个被插桩的任务作用域在守卫 drop 时记录一个样本。
3. 缓冲区容量达到上限后，样本会覆盖最旧的条目。
4. `getWorkProfile(lastSeconds)` 读取一个时间窗口，并派生出 folded/summary/svg 工件。

失败转换：

- SVG 生成失败是软失败（`svg` 省略/为 undefined），folded 与 summary 仍会返回。
- 空的样本窗口返回空的 folded 数据且无 SVG，而非错误。

## 不支持的操作与错误传播

### SIXEL

- 不支持或已损坏的图像输入属于严格失败。
- 无效的 SIXEL 目标尺寸属于严格失败。
- natives 包未暴露 JS 回退路径。

### HTML

- 转换错误属于严格失败。
- 省略选项属于使用默认值，而非失败。

### 剪贴板

- 文本复制在原生 API 层面上是严格的。
- 图像读取区分“无图像”（`null`/`undefined`）与操作失败（reject）。

### 工作性能分析

- 函数调用本身的获取是严格的。
- 火焰图 SVG 的生成可为 null/可选。
- 缓冲区截断是预期的环形缓冲区行为。

## 平台注意事项

- 剪贴板访问依赖于通过 `arboard` 暴露的操作系统/会话支持。
- macOS 外观与电源辅助工具在不支持的平台上会刻意返回 no-op/null 行为。
- 此媒体/系统原生工具接口未暴露 ProjFS。隔离后端的选择（包括任何 ProjFS 支持）位于独立的 `iso` 子系统中。
