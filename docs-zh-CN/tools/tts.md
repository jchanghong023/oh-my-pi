# tts

> 从文本生成语音音频文件并写入 `output_path`。

## 源码
- 入口：`packages/coding-agent/src/tools/tts.ts`
- 本地语音目录：`packages/coding-agent/src/tts/models.ts`
- 本地 worker 客户端：`packages/coding-agent/src/tts/tts-client.ts`
- 会话注入：`packages/coding-agent/src/sdk.ts`（`speechgen.enabled`）

仅当 `speechgen.enabled=true`（默认 `false`）时，SDK 才会注册这个经写授权的自定义工具。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `text` | `string` | 是 | 要合成的文本，必须为 `1..15000` 个字符。 |
| `voice_id` | `string` | 否 | 语音 ID，默认为 `eve`；本地后端改用 `tts.localVoice`。 |
| `language` | `string` | 否 | 传递给 xAI 的语言提示，默认为 `en`。 |
| `output_path` | `string` | 是 | 目标路径，相对于会话 cwd 解析。 |
| `sample_rate` | `number.integer` | 否 | xAI 采样率覆盖。本地后端忽略。 |
| `bit_rate` | `number.integer` | 否 | xAI MP3 比特率覆盖。对 WAV 无效，且本地后端忽略。 |

## 输出
- 成功：
  - `content[0].type = "text"`
  - `content[0].text = "Saved <bytes> bytes to <path> (voice=<voice>, codec=<codec>, backend=<backend>...)."`
  - `details = { bytes, voiceId, codec, backend }`
- 缺少凭据、xAI HTTP 错误以及本地 worker 返回 `null` 时，会以 `isError: true` 返回一个文本块且不带 `details`。其他异常、取消和超时则按原样向上抛出。

## 流程
1. 仅当 `speechgen.enabled` 为 true 时，SDK 才会注入 `tts`。
2. `output_path` 相对于会话 cwd 解析。按其后缀（不区分大小写）推断请求的编码：`.wav` 表示 WAV，其他都表示 MP3。
3. `providers.tts`（默认 `auto`）决定路由：
   - `local` 始终使用设备本地的后端。
   - `xai` 始终使用 xAI Grok Voice；缺少凭据则返回错误结果。
   - `auto` 优先使用本地，但当存在 xAI 凭据且请求为 MP3 时会路由到 xAI，因为只有云端路径会输出 MP3。
4. 本地合成会忽略单次调用的 `voice_id`、`language`、`sample_rate` 和 `bit_rate`；它使用 `tts.localModel` 和 `tts.localVoice`，通过共享的 ONNX tiny-model worker 调用 Kokoro-82M，编码为 PCM16 WAV 后写出文件。
5. xAI 合成会解析 Grok Voice 凭据，调用 `<baseURL>/tts`，并直接将服务提供方返回的字节写入文件。只有当 WAV、采样率或 MP3 比特率与 xAI 默认值不同时，才会在请求中显式发送 `output_format`。

## 模式 / 变体
- 本地后端：完全在设备本地的 Kokoro-82M，模型权重就绪后无需联网调用服务提供方；输出始终为 WAV/PCM16。
- xAI 后端：Grok Voice 云端合成；输出可为 MP3 或 WAV。
- 自动后端：默认本地，但当 MP3 路径加上 xAI 凭据需要云端路由时改用云端。

## 副作用
- 文件系统：写入 `output_path`，若本地合成收到非 WAV 目标，则改为写入同目录下的 `.wav` 文件。
- 网络：xAI 后端调用所配置的 xAI/Grok Voice HTTP 端点；本地后端可能通过 tiny-model 栈下载/缓存模型权重。
- 会话状态：读取 cwd、模型注册表以及设置 `providers.tts`、`tts.localModel`、`tts.localVoice`。
- 后台工作 / 取消：xAI 调用使用 60 秒超时；本地合成接收调用方传入的中止信号。
- 流式 / 进度：合成为单次完成，不会通过 `onUpdate` 发送进度。

## 限制与上限
- 文本字段限制：`1..15_000` 个 JavaScript 字符串字符。
- xAI 默认值：语音 `eve`、语言 `en`、采样率 `24000`、比特率 `128000`；非 `.wav` 路径请求 MP3。
- 描述中列出的内置 xAI 语音：`ara`、`eve`、`leo`、`rex`、`sal`；也接受自定义的 xAI 语音 ID。
- 默认本地模型：`kokoro`（`onnx-community/Kokoro-82M-v1.0-ONNX`，q8）。
- 默认本地语音：`af_heart`；支持的本地语音包括 `af_heart`、`af_bella`、`af_nicole`、`af_aoede`、`af_kore`、`af_sarah`、`am_michael`、`am_fenrir`、`am_puck`、`bf_emma`、`bm_george`、`bm_fable`。

## 错误

- 缺少 xAI 凭据时返回错误结果：`No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.`
- xAI HTTP 失败时返回错误结果，最多包含服务提供方详细信息的开头 300 个字符：`xAI TTS failed (<status>): <detail>`。
- 本地 worker 返回 `null` 时返回错误结果，提示模型 key 及可能的 worker/模型下载问题。
- 调用方取消、xAI 60 秒超时、文件系统写入错误以及本地 worker 抛出的失败会原样向上抛出，不会包装为 `isError` 结果。

## 备注
- 本地 MP3 输出有意不打包提供。本地请求 `speech.mp3` 时会改写为 `speech.wav`，并在工具结果中说明。
- `voice_id` 和 `language` 是 xAI 请求的字段；本地语音选择来自设置，因此模型调用无需在每次调用中枚举本地语音 ID。
