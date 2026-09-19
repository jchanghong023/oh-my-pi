# generate_image

> 生成或编辑图像，并将生成的图像文件写入临时路径。

## 源码
- 入口：`packages/coding-agent/src/tools/image-gen.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/image-gen.md`
- 会话注入：`packages/coding-agent/src/sdk.ts`（`getImageGenTools()`）

该自定义工具仅在 `generate_image.enabled=true`（默认 `false`）且会话的显式工具过滤器（若有）请求 `generate_image` 时才会注册。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `subject` | `string` | 是 | 主图像提示词。编辑时，描述期望的结果以及每张输入图像的作用。 |
| `action` | `string` | 否 | 主体正在做什么。 |
| `scene` | `string` | 否 | 地点或环境。 |
| `composition` | `string` | 否 | 相机角度与取景。 |
| `lighting` | `string` | 否 | 光照设置。 |
| `style` | `string` | 否 | 艺术风格。 |
| `text` | `string` | 否 | 要在图像中渲染的文字。保持简短，并在需要时说明清晰度要求。 |
| `changes` | `string[]` | 否 | 针对输入图像的编辑指令。 |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | 否 | 请求的输出宽高比。 |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | 否 | 请求的输出尺寸（在所选 provider 支持时）。 |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | 否 | 通过本地路径或内联 base64 数据提供的输入图像。 |
| `provider` | `"auto" \| "openai" \| "openai-codex" \| "antigravity" \| "xai" \| "openrouter" \| "gemini" \| "deepinfra"` | 否 | 每次请求的 provider 偏好。具体值会优先尝试；`auto` 或省略则使用配置/会话顺序。 |

## 输出
- 成功并带有图像数据：
  - `content[0].type = "text"`
  - `content[0].text` 汇总 provider/模型以及已保存的图像路径。
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- 不包含图像数据的 provider 响应会返回 `imageCount: 0`、空的 `imagePaths` / `images`，以及任何可用的 provider 文本/反馈。

## 流程
1. 仅当功能开关与工具过滤器允许时，SDK 才会通过 `getImageGenTools()` 将 `generate_image` 注入为自定义工具。
2. provider 顺序为：每次请求指定的具体 `provider`、`providers.imageOrder` 中的条目、活动会话模型对应的图像 provider，然后是内置顺序 `openai`、`openai-codex`、`antigravity`、`xai`、`openrouter`、`gemini`、`deepinfra`；重复项会被移除。`provider: "auto"` 不会添加 provider。
3. 该工具会跳过没有可用凭据的 provider。已配置凭据的 provider 的 HTTP 失败会被收集，并尝试下一个 provider；校验、解析、本地 I/O、取消和超时失败不属于回退条件。
4. 输入图像在找到第一个可用 provider 后只解析一次。`path` 相对于会话 cwd 解析，并进行内容嗅探。内联 `data` 可以是原始 base64（此时需要 `mime_type`），也可以是 `data:<mime>;base64,...` URL。
5. provider 特定的宽高比支持在选定 provider 之后检查。
6. provider 分发：
   - OpenAI：在活动的兼容 GPT Responses 模型上使用托管 Responses 图像生成。
   - OpenAI Codex：在兼容的已连接 ChatGPT/Codex 订阅模型上使用托管 Responses 图像生成，即使活动聊天模型来自其他 provider。
   - Antigravity：Google Antigravity SSE 端点。
   - OpenRouter：支持图像的 chat completion 端点。
   - xAI：Grok Imagine 生成或编辑端点。
   - Gemini：Gemini `generateContent`，使用 `responseModalities: ["IMAGE"]`。
   - DeepInfra：OpenAI 兼容的 `images/generations` 端点（默认模型 `black-forest-labs/FLUX-2-pro`，接受 `DEEPINFRA_API_KEY`）。仅支持文本生成图像 — 编辑请求会回落到后续支持编辑的 provider。
7. 成功的 provider 响应中的内联图像会保存到临时文件；返回路径以及 base64/MIME 图像元数据。不包含图像数据的响应会返回普通的零图像结果，而不是 `isError`。

## 模式 / 变体
- 文本生成图像：提供 `subject` 以及可选的风格/构图字段，不提供 `input`。
- 图像编辑：提供一个或多个 `input` 图像，外加 `changes` 和一个标识每张图像作用的主体描述。
- 文字渲染：使用 `text`；提示词要求调用方请求清晰、易读、拼写正确的简短文字。
- provider 选择：设置 `provider` 以为某次请求优先选择一个后端；在已配置凭据的 HTTP 失败之后，回退仍然遵循剩余的配置/会话/内置顺序。

## 副作用
- 文件系统：读取本地输入图像，并将生成的输出图像写入操作系统临时目录下名为 `omp-image-<snowflake>.<ext>` 的文件。
- 网络：将提示词和可选图像发送给选定的图像 provider。响应中的 OpenRouter/xAI 图像 URL 会在保存前下载。
- 会话状态：读取活动模型、会话 id、cwd、凭据、`providers.imageOrder`、Antigravity 端点设置，以及可选注入的 `fetch`。
- 后台工作 / 取消：provider 调用使用调用方的 abort signal，并结合 3 分钟超时。

## 限制与上限
- 本地路径输入上限为 `35 * 1024 * 1024` 字节（`MAX_IMAGE_SIZE`）。内联 base64 输入没有单独的工具级大小上限。
- 路径输入必须存在，且其内容嗅探得到的图像类型必须受支持。每个输入对象必须包含 `path` 或 `data`；两者同时存在时 `path` 优先。
- 原始 base64 `data` 需要 `mime_type`；data URL 自带 MIME 类型。
- provider 超时为 `3 * 60 * 1000` ms。
- OpenAI 托管输出以 WebP 形式请求。其他响应文件使用由 MIME 推导的扩展名（`png`、`jpg`、`gif` 或 `webp`；未知 MIME 类型回退为 `.png`）。
- 常见宽高比为 `1:1`、`3:4`、`4:3`、`9:16` 和 `16:9`；只有 xAI 还接受 `3:2` 和 `2:3`。
- `image_size` 接受 `1024x1024`、`1536x1024` 和 `1024x1536`。在 xAI 上这些值分别映射为 `1k`、`2k` 和 `2k`；省略时默认为 `1k`。
- xAI 编辑请求最多接受 3 张输入图像。

## 错误
- 没有可用的 provider 凭据：`No image API credentials found...`；该消息会列出受支持的登录/API-key 途径。
- 无效输入：文件不存在、文件超过 35 MiB、内容嗅探得到的图像类型不受支持、缺少 `path`/`data`、图像数据为空，或原始 base64 未提供 `mime_type`。
- OpenAI 路径缺少兼容的 GPT 模型：`Missing active GPT model for OpenAI image generation`。
- Antigravity 凭据缺少 `projectId`：`Missing projectId in antigravity credentials`。
- xAI 编辑参考图超过三张：`xAI image edits accept up to 3 reference images...`。
- 如果未到达可用的 xAI 路由，`3:2` 或 `2:3` 请求会失败。
- 已配置凭据的 provider HTTP 失败会回落到后续 provider。如果所有此类 provider 都失败，该工具会抛出 `AggregateError`，其中列出所有尝试过的 provider，并包含它们各自的 provider 特定 HTTP 错误。
- 取消、三分钟超时、畸形的 provider 响应以及本地 I/O 错误会直接抛出。

## 备注
- 该工具是自定义工具，而非内置的 `AgentTool` 类，因此尽管面向模型的提示词位于 `src/prompts/tools/image-gen.md`，其根文档仍放在这里。
- 多张输入图像应在 `subject` 中命名为 `Image 1`、`Image 2` 等，以便 provider 收到无歧义的编辑指令。
