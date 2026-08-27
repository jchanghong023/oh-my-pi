# web_search

> 通过第一个可用的搜索提供方执行一次网络查询，并返回面向 LLM 格式化的答案、来源 URL 和可选的引用。

## 源码
- 入口：`packages/coding-agent/src/web/search/index.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/web-search.md`
- 关键协作者：
  - `packages/coding-agent/src/web/search/provider.ts` — 惰性提供方注册表；可用性链。
  - `packages/coding-agent/src/web/search/types.ts` — 统一的 `SearchResponse` / `SearchProviderError` 类型。
  - `packages/coding-agent/src/web/search/render.ts` — TUI 渲染器详情类型。
  - `packages/coding-agent/src/web/search/providers/base.ts` — 提供方接口和共享参数契约。
  - `packages/coding-agent/src/web/search/providers/utils.ts` — 凭据查找；来源标准化。
  - `packages/coding-agent/src/web/search/providers/browser-headers.ts` — 抓取型提供方共享的 Chromium 导航头。
  - `packages/coding-agent/src/web/search/query.ts` — Google 风格查询解析、提供方语法格式化和宽松的结果过滤。
  - `packages/coding-agent/src/web/search/providers/browser-page.ts` — 抓取型提供方共享的 fetch/无头浏览器页面加载器。
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Claude 网页搜索提供方。
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API 适配器。
  - `packages/coding-agent/src/web/search/providers/codex.ts` — OpenAI Codex SSE 适配器。
  - `packages/coding-agent/src/web/search/providers/duckduckgo.ts` — DuckDuckGo HTML 前端抓取器。
  - `packages/coding-agent/src/web/search/providers/ecosia.ts` — Ecosia 浏览器后端抓取器。
  - `packages/coding-agent/src/web/search/providers/exa.ts` — Exa API 或 MCP 适配器。
  - `packages/coding-agent/src/web/search/providers/firecrawl.ts` — Firecrawl 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/gemini.ts` — Gemini grounding SSE 适配器。
  - `packages/coding-agent/src/web/search/providers/google.ts` — Google 浏览器后端 SERP 抓取器。
  - `packages/coding-agent/src/web/search/providers/jina.ts` — Jina Reader 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/kagi.ts` — Kagi 提供方封装。
  - `packages/coding-agent/src/web/search/providers/kimi.ts` — Kimi 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/mojeek.ts` — Mojeek 浏览器后端抓取器（独立索引）。
  - `packages/coding-agent/src/web/search/providers/parallel.ts` — Parallel 提供方封装。
  - `packages/coding-agent/src/web/search/providers/perplexity.ts` — Perplexity API / OAuth 适配器。
  - `packages/coding-agent/src/web/search/providers/public.ts` — 对所有免凭据引擎的 Public Web 聚合。
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — 自托管 SearXNG 适配器。
  - `packages/coding-agent/src/web/search/providers/startpage.ts` — Startpage（Google 代理）表单流抓取器。
  - `packages/coding-agent/src/web/search/providers/synthetic.ts` — Synthetic 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/tavily.ts` — Tavily 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/tinyfish.ts` — TinyFish 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/xai.ts` — xAI Responses 网页搜索适配器。
  - `packages/coding-agent/src/web/search/providers/zai.ts` — Z.AI 远程 MCP 适配器。
  - `packages/coding-agent/src/web/parallel.ts` — Parallel 搜索/提取 HTTP 客户端。
  - `packages/coding-agent/src/web/kagi.ts` — Kagi HTTP 客户端。
  - `packages/coding-agent/src/tools/index.ts` — 内置工具注册与启用标志。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `query` | `string` | 是 | 原始查询。编排器会解析 Google 风格指令（`site:`/`-site:`、`after:`/`before:`、`inurl:`、`intitle:`、`filetype:`、引号短语、排除项和 `OR`），以便提供方将它们映射到原生过滤器或受支持的语法；原始字符串对适配器仍然可用。 |
| `recency` | `"day" \| "week" \| "month" \| "year"` | 否 | 相对时间过滤器。由 Brave、Perplexity、Tavily、SearXNG、Kagi、TinyFish、Firecrawl、DuckDuckGo、Startpage、Google 和 Mojeek 实现；其他适配器忽略该字段。 |
| `limit` | `number` | 否 | 返回的最大结果数。在 `num_search_results` 缺失时通常会成为提供方请求的结果数参数。TinyFish 在切片前将其用于分页获取。xAI 仅将折叠后的值用作对已解析来源/引用的本地上限，默认为 `10`，最大 `30`。 |
| `max_tokens` | `number` | 否 | 仅由 Anthropic、Gemini、xAI 和 Perplexity API 密钥模式透传为提供方的 token 上限（`maxOutputTokens`、`max_tokens` 或 xAI 的 `max_output_tokens`）。其他提供方忽略该字段。 |
| `temperature` | `number` | 否 | 仅由支持采样参数的 Anthropic 模型、Gemini、xAI 和 Perplexity API 密钥模式透传。其他提供方/模型路径会忽略或省略该字段。 |
| `num_search_results` | `number` | 否 | 请求的搜索广度或本地结果上限。大多数提供方会将其上游发送。TinyFish 将其限制在 `1..20`，默认 `10`，并作为每页的 `num_results` 发送，在切片前进行分页。xAI 在 `limit` 之前将其用作本地已解析结果上限，默认为 `10`，最大 `30`；当前的 Responses `web_search` 工具没有上游结果数字段。 |

## 输出
该工具返回一个文本内容块以及结构化的 `details`。

- `content`：`[{ type: "text", text: string }]`
- `details`：来自 `packages/coding-agent/src/web/search/render.ts` 的 `SearchRenderDetails`
  - `response: SearchResponse`
  - `error?: string`

`text` 由 `packages/coding-agent/src/web/search/index.ts` 中的 `formatForLLM()` 生成。关于放宽的查询约束的提示会首先输出：

- 如果 `response.answer` 存在，则首先输出。
- 如果存在来源，则每个来源输出一项（仅当同时生成了答案时，才会输出 `## Sources` 标题及来源计数）：
  - `[n] <title> (<格式化后的时效或发布日期>)`
  - `    <url>`
  - 可选的摘要行，截断为 240 字符。
- 如果存在引用，则随后是 `## Citations` 部分，包含 URL/标题以及可选的引用文本，截断为 240 字符。
- 如果存在相关问题，则随后是 `## Related` 项目列表。
- 如果存在搜索查询，则随后是 `Search queries: <n>` 部分，最多包含前 3 个查询，每个 120 字符。

当提供方不可用或提供方尝试失败时，失败输出不会在工具边界处抛出。相反，工具返回：

- `content[0].text = "Error: ..."`
- `details.response.provider = <最后尝试的提供方> | "none"`
- `details.error = ...`

流式：无。`WebSearchTool.execute()` 将其 `AbortSignal` 转发到 `executeSearch()`，而 `executeSearch()` 把它传递给提供方。如果在回退处理过程中信号被中止，`throwIfAborted(signal)` 会重新抛出取消信号，而不是返回 `"Error: ..."` 文本结果。

每个提供方搜索传输都会接收来自 `providers.webSearchTimeoutSeconds` 的硬超时（默认 `60`，最大 `300`）。当某个传输超过该上限时，自动链会记录该提供方失败并前进到下一个候选。该设置不是整条链的截止时间，提供方仍可能施加更短的上游、重试或聚合限制。设置一个正数秒数，例如 `omp config set providers.webSearchTimeoutSeconds 180`，用于较慢的模型驱动搜索。

## 流程
1. `packages/coding-agent/src/web/search/index.ts` 中的 `WebSearchTool.execute()` 直接委托给 `executeSearch()`。
2. `executeSearch()` 使用 `parseSearchQuery()` 解析一次 `query`，然后在不急切加载其模块的情况下计算有序的提供方候选：
   - 如果设置了内部 `params.provider` 且不等于 `"auto"`，则该提供方是唯一候选，并被视为显式；
   - 否则使用配置的候选顺序。在 `providers.webSearchOrder` 中明确列出的条目使用 `isExplicitlyAvailable()`；普通回退条目使用 `isAvailable()`。
3. `resolveProviderCandidates()` 优先选取 `providers.webSearchOrder` 中首次出现且有效的 ID，然后将未列出的提供方按 `SEARCH_PROVIDER_ORDER` 追加。空列表保留内置顺序。`providers.webSearchExclude` 会从自动/配置链以及 Public Web 扇出中移除提供方。内部每个请求的强制提供方绕过该配置链。
4. 如果没有任何可用候选（例如，配置排除了所有免凭据引擎且未配置带密钥/OAuth 的提供方），`executeSearch()` 返回 `Error: No web search provider configured.`，并设置 `details.response.provider = "none"`。
5. 对于按顺序排列的每个提供方，`executeSearch()` 使用以下参数调用 `provider.search()`：
   - `query`，
   - `limit`、`recency`、`temperature`、`maxOutputTokens`、`numSearchResults`，
   - `timeoutMs`，由 `providers.webSearchTimeoutSeconds` 派生而来，
   - `systemPrompt`，来自 `packages/coding-agent/src/prompts/system/web-search.md`，
   - 已解析的结构化查询，包括已识别的指令以及日期/域/标题/URL/文件类型约束。
6. 在提供方响应后，`applyQueryConstraints()` 对其来源进行宽松的后过滤，以覆盖那些上游未必保证的约束。它依次应用每个可过滤的维度；任何会消除全部剩余结果的维度都会被放宽，并输出一条前置的 `Note: no results matched ...`。答案/引用文本不会被重写。
7. 没有可渲染内容（`hasRenderableSearchContent()` 返回 false）的 `SearchResponse` 会被作为 `SearchProviderError`（状态 `204`）拒绝，从而使循环前进到下一个提供方。在第一次可渲染的响应时，`formatForLLM()` 将提示、答案、来源、引用、相关问题和搜索查询渲染为单个文本块。
8. 如果某个提供方抛出异常，`executeSearch()` 会记录该错误并尝试下一个提供方。提供方级别没有并行扇出；回退是顺序的。
9. 在所有候选都失败后，`formatSearchProviderFailure()` 对每个错误进行标准化：
   - Anthropic 的 `404` 变为 `Anthropic web search returned 404 (model or endpoint not found).`。
   - `401`/`403` 变为 `<Provider> authorization failed ...`，但 Z.AI 保留其原始消息。
   - 其他 `SearchProviderError` 会显示 `error.message`。
10. 如果有多个提供方失败，则最终消息为 `All web search providers failed: <provider/error>; ...`；否则仅为标准化后的最后一个错误。

## 模式 / 变体
- **提供方选择**
  - **强制提供方**：内部调用方可以传递 `provider`；非 `auto` 值是唯一尝试的提供方，并使用 `isExplicitlyAvailable()`，而 `auto`（或省略它）会遍历配置链。此字段不在面向模型的 schema 中。
  - **配置顺序**：`setSearchProviderOrder()` 在 `providers.webSearchOrder` 中优先选取有效、首次出现的提供方 ID；未列出的提供方按内置相对顺序跟进。列出的提供方是显式选择，并通过 `isExplicitlyAvailable()` 解析，因此 Perplexity、Exa 和 Firecrawl 可以使用其未认证/无密钥路径。
  - **排除的提供方**：`setExcludedSearchProviders()` 会从自动/配置链以及 Public Web 扇出中移除提供方。通过 `packages/coding-agent/src/config/provider-globals.ts` 从 `providers.webSearchExclude` 接入。
  - **默认自动链顺序**（23 个提供方）：`perplexity`、`gemini`、`anthropic`、`codex`、`xai`、`zai`、`exa`、`tinyfish`、`jina`、`kagi`、`tavily`、`firecrawl`、`brave`、`kimi`、`parallel`、`synthetic`、`searxng`、`startpage`、`duckduckgo`、`ecosia`、`google`、`mojeek`、`public`（位于 `packages/coding-agent/src/web/search/types.ts` 的 `SEARCH_PROVIDER_ORDER`）。`public` 仅显式可用：其 `isAvailable()` 返回 `false`，因此自动链永远不会隐式地对其进行扇出。
- **提供方超时**：`providers.webSearchTimeoutSeconds` 提供每个提供方搜索传输的硬上限，超过后自动链前进。默认值为 `60`；无效的非正值会回退到该默认值，高于 `300` 的值会被截断；提供方特定的上游或聚合限制仍可能更短。
- **提供方适配器**
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - 可用性：认证尝试顺序为 `PERPLEXITY_COOKIES` -> `agent.db` 中的 OAuth 令牌 -> 直接的 Perplexity API 密钥 -> OpenRouter 密钥 -> 匿名的 ask 端点回退。自动链要求直接的 Perplexity 认证（cookie、OAuth 或 Perplexity 凭据）；显式选择始终可用，并可使用 OpenRouter 或匿名搜索。
    - OAuth/cookie/匿名模式：POST 到 `https://www.perplexity.ai/rest/sse/perplexity_ask`，消费 SSE，合并部分事件，提取答案和来源 URL，设置 `authMode: "oauth"`（对于未认证回退则为 `"anonymous"`）。
    - API 密钥模式：POST 到 `https://api.perplexity.ai/chat/completions`，使用 `model: "sonar-pro"`、`search_mode: "web"`、`num_search_results`，可选的 `search_recency_filter`、`max_tokens`、`temperature`。
    - `num_search_results` 仅在 API 密钥模式下控制上游 API 的广度。`limit` 单独保留为 `num_results`，并在两种认证模式下解析后对返回的 `sources` 进行切片。
    - 输出可能包括 `answer`、`sources`、`citations`、`usage`、`model`、`requestId`、`authMode`。
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - 可用性：`agent.db` 中 `google-gemini-cli` / `google-antigravity` 的 OAuth 凭据，或 Google Developer API 密钥。
    - 查询：启用 Google Search grounding 的 SSE `streamGenerateContent` 调用。Antigravity 认证尝试两个回退端点，并在令牌刷新后重试一次 `401/403/400 invalid auth`；`429/5xx` 以指数退避和服务端提供的重试延迟进行重试，受 `5 * 60 * 1000` 毫秒的速率限制预算限制。
    - 模型：`providers.webSearchGeminiModel` 选择 Gemini grounding 模型；`GEMINI_SEARCH_MODEL` 覆盖它。默认为 `gemini-2.5-flash`。
    - `max_tokens` 和 `temperature` 分别透传为 `generationConfig.maxOutputTokens` / `generationConfig.temperature`。
    - `limit` 和 `num_search_results` 在派发前合并。
    - 输出可能包括 `answer`、`sources`、`citations`、`searchQueries`、`usage`、`model`。
  - **Anthropic** — `packages/coding-agent/src/web/search/providers/anthropic.ts`
    - 可用性：`ANTHROPIC_SEARCH_API_KEY` 环境变量，否则 `authStorage.hasAuth("anthropic")`；当未设置搜索专用密钥时，搜索凭据来自 `authStorage.getApiKey("anthropic")`。
    - 特定于搜索的环境变量覆盖（不影响聊天补全）：
      - `ANTHROPIC_SEARCH_API_KEY` — 最高优先级的搜索认证；仅针对搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / `ANTHROPIC_FOUNDRY_API_KEY`。
      - `ANTHROPIC_SEARCH_BASE_URL` — 搜索专用基础 URL，用于 `ANTHROPIC_SEARCH_API_KEY` 或回退的 Anthropic 凭据；覆盖 `ANTHROPIC_BASE_URL`（以及 Foundry 模式下的 `FOUNDRY_BASE_URL`）；默认为 `https://api.anthropic.com`。
      - `ANTHROPIC_SEARCH_MODEL` — 搜索模型；默认为 `claude-haiku-4-5`。
    - 查询：启用网页搜索工具的 Claude Messages API。
    - `max_tokens` 透传。`temperature` 仅对支持采样参数的模型透传；对于 Opus 4.7+、Sonnet 5+ 以及 Fable/Mythos 5+ 会被省略，因为这些 API 拒绝采样参数。
    - `limit` 和 `num_search_results` 在派发前合并：`num_results = params.numSearchResults ?? params.limit`。
    - 输出可能包括 `answer`、`sources`、`citations`、`searchQueries`、`usage.searchRequests`、`model`、`requestId`。
  - **Codex** — `packages/coding-agent/src/web/search/providers/codex.ts`
    - 可用性：`agent.db` 中 `openai-codex` 的 OAuth 凭据；搜索期间延迟刷新。自定义模型注册表端点可以使用配置的 API 密钥/命令凭据，但官方 OAuth/环境凭据会被拒绝用于自定义端点。
    - 查询：流式调用 Codex Responses 端点，使用托管的 `web_search` 和 `search_context_size: "high"`。Google 风格指令会在查询中重新发出。
    - `PI_CODEX_WEB_SEARCH_MODEL` 强制进行一次模型尝试。否则适配器按偏好顺序尝试捆绑的 ChatGPT 账户安全模型（`gpt-5.6-luna`、`terra`、`sol`、`gpt-5.5`……），仅针对受支持的模型重试失败时前进。Responses-Lite 模型使用自动工具选择；如果完成的响应中没有 `web_search_call`，则会被拒绝而不是作为已搜索的内容呈现。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。`num_search_results ?? limit` 在本地对已解析的来源进行切片。
    - 输出可能包括 `answer`、`sources`、`usage`、`model`、`requestId`。如果流中没有 `url_citation` 注释，适配器会回退到来自答案的 markdown 链接和裸 URL。
  - **xAI** — `packages/coding-agent/src/web/search/providers/xai.ts`
    - 可用性：共享认证策略首选的 xAI OAuth，或 `xai` 凭据（如 `XAI_API_KEY`）。
    - 查询：使用 Responses API，模型为 `grok-4.5`、`tools: [{ type: "web_search", ... }]`，推理强度为 `low` 的 POST。支持自定义模型注册表端点，但官方 xAI OAuth 凭据会被拒绝用于自定义端点。
    - 最多五个 `site:` 或 `-site:` 主机映射到互斥的 `allowed_domains` / `excluded_domains` 过滤器（允许列表优先）；路径限制保留用于集中过滤。绝对日期仍作为查询提示保留，因为当前的 Responses `web_search` 工具没有日期字段。
    - `max_tokens` 和 `temperature` 透传。`num_search_results`（或 `limit`）仅在本地对已解析的来源/引用进行上限，默认 `10`，最大 `30`；它不作为上游搜索计数参数发送。
    - 输出可能包括 `answer`、`sources`、`citations`、`usage`、`model`、`requestId`、`authMode: "api_key"`。
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - 可用性：`zai` 的环境变量或 `agent.db` 凭据。
    - 查询：针对 `https://api.z.ai/api/mcp/web_search_prime/mcp` 的 JSON-RPC `tools/call`，用于远程 MCP 工具 `web_search_prime`。
    - 提供方内部的回退链：尝试 `{query,count}`，然后 `{search_query,count}`，然后 `{search_query, search_engine:"search-prime", count}`，当早期尝试因参数形式错误而失败时使用。
    - `limit` 和 `num_search_results` 在派发前合并。
    - 输出可能包括已解析的自由文本 `answer`、`sources`、`requestId`。
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - 可用性：`EXA_API_KEY` 或 `exa` 的存储凭据（包括通过 `/login exa` 添加的凭据）使 Exa 进入自动链；设置不得显式禁用 `exa.enabled` 或 `exa.enableSearch`。即使没有凭据，显式选择（在 `providers.webSearchOrder` 中列出 `exa`，或强制 `provider: exa`）也能访问 Exa，并回退到公共 MCP。
    - 查询：使用已解析的 Exa API 密钥对 `https://api.exa.ai/search` 进行 POST，否则对 `https://mcp.exa.ai/mcp` 进行 JSON-RPC `tools/call`，用于远程 MCP 工具 `web_search_exa`。
    - `limit` 和 `num_search_results` 在派发前合并。
    - 输出：从最多 3 个结果摘要合成的 `answer`、`sources`、`requestId`。
  - **TinyFish** — `packages/coding-agent/src/web/search/providers/tinyfish.ts`
    - 可用性：`TINYFISH_API_KEY` 或 `agent.db` 中 `tinyfish` 的凭据。
    - 查询：GET `https://api.search.tinyfish.ai`，使用 `X-API-Key` 和 `query`；`recency` 映射到 `recency_minutes`。
    - `limit` / `num_search_results`：合并为 `params.numSearchResults ?? params.limit`，限制在 `1..20`，默认 `10`。TinyFish 没有计数参数，每页最多返回 10 个结果；对于超过第一页的计数，适配器在本地切片之前获取文档化的 `page` 值（`0`，需要时再获取 `1`）。输出 `sources`、`authMode: "api_key"`。
  - **Jina** — `packages/coding-agent/src/web/search/providers/jina.ts`
    - 可用性：仅 `JINA_API_KEY`。
    - 查询：GET 风格的 fetch 到 `https://s.jina.ai/<编码后的查询>`，使用 bearer 认证。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。
    - `limit` / `num_search_results`：适配器在提供时将来源切片为 `params.numSearchResults ?? params.limit`；否则返回所有载荷项。
    - 输出：仅 `sources`。
  - **Kagi** — `packages/coding-agent/src/web/search/providers/kagi.ts`、`packages/coding-agent/src/web/kagi.ts`
    - 可用性：`kagi` 的环境变量或 `agent.db` 凭据。
    - 查询：POST `https://kagi.com/api/v1/search`，使用 `Authorization: Bearer <key>` 和 JSON 体 `{ query, workflow: "search", limit, filters?: { after } }`。`recency` 作为 UTC `YYYY-MM-DD` 字符串映射到 `filters.after`（`day`/`week`/`month`/`year`）。
    - `limit` 和 `num_search_results` 在派发前合并，限制在 `1..40`，默认 `10`。
    - 输出：`sources`（串联的 `data.search` + `data.video` + `data.news` + `data.infobox`，视频/新闻/信息框结果在标题中标记）、`relatedQuestions`（`data.adjacent_question` + `data.related_search` `props.question`）、`answer`（`data.direct_answer[0].snippet ?? title`）、`requestId`（`meta.trace`）。
  - **Tavily** — `packages/coding-agent/src/web/search/providers/tavily.ts`
    - 可用性：通过 `findCredential()` 从环境变量或 `agent.db` 获取 API 密钥。
    - 查询：POST `https://api.tavily.com/search`。
    - `recency` 映射到 Tavily 的 `time_range`；代码明确将 `topic` 保留为默认的 general 范围，而不是收窄到 news。
    - `limit` / `num_search_results`：适配器使用 `params.numSearchResults ?? params.limit`，限制在 `5..20`，默认 `5`。
    - 输出：`answer`、`sources`、`requestId`、`authMode: "api_key"`。
  - **Firecrawl** — `packages/coding-agent/src/web/search/providers/firecrawl.ts`
    - 可用性：凭据使其进入自动链；显式/配置选择始终可用，并在无凭据解析时使用无密钥模式。
    - 查询：POST `https://api.firecrawl.dev/v2/search`，使用 `sources: [{ type: "web" }]`。Google 风格运算符被格式化为查询；`recency` 和已解析的绝对日期映射到 `tbs`。
    - `limit` / `num_search_results`：合并并限制在 `1..100`，默认 `10`；输出 `sources`、`requestId` 和 `authMode: "api_key" | "keyless"`。
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - 可用性：仅 `BRAVE_API_KEY`。
    - 查询：GET `https://api.search.brave.com/res/v1/web/search`，使用 `count`、`extra_snippets=true`，以及 `recency` 对应的 `freshness=pd|pw|pm|py`。
    - `limit` / `num_search_results`：`params.numSearchResults ?? params.limit`，限制在 `1..20`，默认 `10`。
    - 输出：`sources`、`requestId`。
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - 可用性：`MOONSHOT_SEARCH_API_KEY`、`KIMI_SEARCH_API_KEY` 或 `agent.db` 中 `kimi-code` 的凭据。`MOONSHOT_API_KEY` 和存储的 `moonshot` 凭据被故意拒绝，因为开放平台的密钥不能认证 Kimi Code 搜索服务。
    - 查询：POST 到 `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` / 默认的 `https://api.kimi.com/coding/v1/search`，使用 `text_query`、`limit`、`enable_page_crawling`、`timeout_seconds: 30`。
    - `limit` / `num_search_results`：`params.numSearchResults ?? params.limit`，限制在 `1..20`，默认 `10`。
    - 输出：`sources`、`requestId`。
  - **Parallel** — `packages/coding-agent/src/web/search/providers/parallel.ts`、`packages/coding-agent/src/web/parallel.ts`
    - 可用性：`parallel` 的环境变量或 `agent.db` 凭据。
    - 查询：POST `https://api.parallel.ai/v1beta/search`，使用 `objective=query`、`search_queries=[query]`、`mode:"fast"`、`max_chars_per_result: 10000`，beta 头 `search-extract-2025-10-10`。
    - 尽管名字如此，这里没有提供方扇出；当前适配器始终发送一个元素的 `search_queries` 数组。
    - `limit` 和 `num_search_results` 在派发前合并，限制在 `1..40`，默认 `10`。
    - 输出：`sources`、`requestId`。
  - **Synthetic** — `packages/coding-agent/src/web/search/providers/synthetic.ts`
    - 可用性：`synthetic` 的环境变量或 `agent.db` 凭据。
    - 查询：POST `https://api.synthetic.new/v2/search`，使用 `{ query }`。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。
    - `limit` 和 `num_search_results` 在派发前合并。
    - 输出：仅 `sources`。
  - **SearXNG** — `packages/coding-agent/src/web/search/providers/searxng.ts`
    - 可用性：来自 `searxng.endpoint` 设置或 `SEARXNG_ENDPOINT` 环境变量的端点。
    - 查询：GET `<endpoint>/search?format=json&q=...`；可选设置添加 `categories` 和 `language`。
    - 认证优先级：Basic 认证（`searxng.basicUsername` / `searxng.basicPassword` 或等效环境变量）优先于 bearer 令牌（`searxng.token` / `SEARXNG_TOKEN`）。Basic 凭据会按 RFC 7617 限制进行验证。
    - `recency` 映射到 `time_range`；`week` 被降级为 `month`，因为 SearXNG 不支持 week。
    - `limit` 和 `num_search_results` 在派发前合并，限制在 `1..20`，默认 `10`。
    - 输出：`sources`、来自 `suggestions` 的 `relatedQuestions`。
  - **DuckDuckGo** — `packages/coding-agent/src/web/search/providers/duckduckgo.ts`
    - 可用性：始终可用；无需 API 密钥。
    - 查询：POST 无 JS 的 HTML 前端 `https://html.duckduckgo.com/html/`，使用 `q`、`kl=us-en`，以及可选的 `df` 时效过滤器（`d`/`w`/`m`/`y`）；解析结果列表并展开 `//duckduckgo.com/l/?uddg=…` 重定向 URL。
    - `recency` 映射到 `df`；超出 `day|week|month|year` 范围的值会被忽略。
    - `limit` / `num_search_results`：合并并限制在 `1..20`，默认 `10`；输出仅暴露 `sources`（DuckDuckGo 的 HTML 页面不返回独立的摘要）。
    - 当 DuckDuckGo 对数据中心或共享出口 IP 进行限流时，它会提供机器人检测挑战（HTTP 200/202，响应体包含 `anomaly-modal`）。适配器会检测到这种情况并抛出 `SearchProviderError`，以便编排器以明确的原因回退到下一个配置的提供方。
  - **Startpage** — `packages/coding-agent/src/web/search/providers/startpage.ts`
    - 可用性：始终可用；无需 API 密钥。它代理 Google 的索引，GET 主页以获取 `sc` 反机器人表单令牌，然后 POST `/sp/search`（并附带无令牌的 GET 回退）。`recency` 映射到 `with_date=d|w|m|y`。
    - 机器人/挑战或同意页面会抛出带提供方标签的 `SearchProviderError`（429），以便链前进。
  - **Google / Ecosia / Mojeek** — `providers/google.ts`、`providers/ecosia.ts`、`providers/mojeek.ts`
    - 可用性：始终可用；无需 API 密钥。`browserFetch`（`providers/browser-page.ts`）首先尝试带浏览器配置的普通 fetch，然后将 fetch 失败、非 2xx 状态以及挑战响应升级到共享的隐身无头浏览器（`acquireBrowser`）；注入的 `params.fetch`（测试用）永远不会升级。
    - Google：通过主页种子 cookie，然后加载渲染的 SERP；`recency` 映射到 `tbs=qdr:*`。Ecosia 位于 Cloudflare 之后（因此需要浏览器）；其自然结果是 Google 支持的；`recency` 是服务端无操作，被静默忽略。Mojeek 前置一个 ALTCHA 工作量证明墙，浏览器路径会自动解决；`recency` 映射到 `since=day|week|month|year`。
    - 挑战页面（Google `unusual traffic`、Ecosia Firewall、Mojeek ALTCHA/robot 403）会抛出带提供方标签的 `SearchProviderError`（429）。
  - **Public Web** — `packages/coding-agent/src/web/search/providers/public.ts`
    - 可用性：仅显式选择（`isAvailable()` 为 `false`；`isExplicitlyAvailable()` 为 `true`）。
    - 查询：扇出到五个免凭据引擎（`startpage`、`google`、`duckduckgo`、`ecosia`、`mojeek`，减去被排除的引擎），然后进行整合。URL 在规范化键（去掉 `www.` 的主机、规范化的尾随斜杠、保留查询、移除片段）上去重，按跨引擎共识排序，再按各引擎最佳排名排序；最长的摘要胜出。
    - 截止时间竞争：返回时间为所有引擎完成时、有至少一个成功时的 5 秒软截止时间或 30 秒硬上限中的最早者；落后者会被中止。允许单个引擎失败；仅当每个引擎都失败时才整体失败。

## 副作用
- 网络
  - 通过 HTTPS 调用一个或多个外部搜索提供方，直到一个成功或全部失败。
  - 提供方特定的传输包括 JSON POST、JSON GET、SSE 流式传输（Perplexity OAuth/API、Gemini、Codex），以及 HTTP 上的 JSON-RPC（Z.AI）。
- 子进程 / 原生绑定
  - 大多数 HTTP/API 适配器不启动任何子进程。Google、Ecosia 和 Mojeek 首先尝试普通 fetch，但失败、非 2xx 或被挑战的生产响应可能会获取项目共享、由代理拥有的无头 Chromium。没有 CLI worker 入口的主机（例如嵌入式 SDK 主机）会改为启动进程本地 Chromium。
  - 此回退可以启动 Chromium 进程并创建其浏览器配置文件生命周期。在首次使用浏览器时，它还可以将 Chromium 下载到 omp Puppeteer 缓存中，除非系统 Chromium 或 `PUPPETEER_EXECUTABLE_PATH` 可用。搜索适配器本身不使用原生绑定。
- 会话状态（记录、内存、任务、检查点、注册表）
  - 在 `packages/coding-agent/src/web/search/provider.ts` 中使用模块全局的提供方实例缓存。
  - 在同一文件中使用模块全局的首选提供方设置。
  - `packages/coding-agent/src/tools/index.ts` 通过 `session.settings.get("web_search.enabled")` 控制工具的可用性。
- 后台工作 / 取消
  - 许多提供方适配器接受 `AbortSignal`；`WebSearchTool.execute()` 将工具调用信号传递给 `executeSearch()`，后者将其作为 `params.signal` 转发给提供方，并在回退期间重新抛出取消信号。

## 限制与上限
- 提供方自动顺序长度：23 个提供方（`packages/coding-agent/src/web/search/types.ts` 中的 `SEARCH_PROVIDER_ORDER`）。
- `formatForLLM()` 将来源摘要和引用文本截断为 240 字符（`packages/coding-agent/src/web/search/index.ts`）。
- `formatForLLM()` 最多输出 3 个搜索查询，每个截断为 120 字符（`packages/coding-agent/src/web/search/index.ts`）。
- Brave 结果数：默认 `10`，最大 `20`（`packages/coding-agent/src/web/search/providers/brave.ts` 中的 `DEFAULT_NUM_RESULTS`、`MAX_NUM_RESULTS`）。
- TinyFish 本地结果数：默认 `10`，最大 `20`；API 没有计数参数，每页最多返回 10 个结果，因此适配器获取文档化的页面（`page=0`，需要时再获取 `page=1`）并在本地切片（`packages/coding-agent/src/web/search/providers/tinyfish.ts`）。
- DuckDuckGo 结果数：默认 `10`，最大 `20`（`packages/coding-agent/src/web/search/providers/duckduckgo.ts`）。
- Startpage / Google / Ecosia / Mojeek 结果数：默认 `10`，最大 `20`（它们各自的 `providers/*.ts` 模块）。
- Public Web 结果数：默认 `15`，最大 `30`；扇出软截止时间 `5` 秒，硬上限 `30` 秒（`packages/coding-agent/src/web/search/providers/public.ts`）。
- Tavily 结果数：默认 `5`，最大 `20`（`packages/coding-agent/src/web/search/providers/tavily.ts`）。
- Firecrawl 结果数：默认 `10`，最大 `100`（`packages/coding-agent/src/web/search/providers/firecrawl.ts`）。
- Kimi 结果数：默认 `10`，最大 `20`；请求超时字段固定为 `30` 秒（`packages/coding-agent/src/web/search/providers/kimi.ts`）。
- Parallel 结果数：默认 `10`，最大 `40`；每个结果摘要上限 `10_000` 字符（`packages/coding-agent/src/web/search/providers/parallel.ts`、`packages/coding-agent/src/web/parallel.ts`）。
- Kagi 结果数：默认 `10`，最大 `40`（`packages/coding-agent/src/web/search/providers/kagi.ts`）。
- SearXNG 结果数：默认 `10`，最大 `20`（`packages/coding-agent/src/web/search/providers/searxng.ts`）。
- xAI 本地来源/引用上限：`num_search_results` 在 `limit` 之前，缺失/无效/为零 => 默认 `10`，最大 `30`；该计数不上游发送（`packages/coding-agent/src/web/search/providers/xai.ts`）。
- Perplexity API 密钥模式默认值：`max_tokens = 8192`，`temperature = 0.2`，`num_search_results = 20`（`packages/coding-agent/src/web/search/providers/perplexity.ts`）。
- Anthropic 默认值：模型 `claude-haiku-4-5`，当提供方省略 `max_tokens` 时 `DEFAULT_MAX_TOKENS = 4096`（`packages/coding-agent/src/web/search/providers/anthropic.ts`）。
- Gemini 重试：每个端点最多 `3` 次重试，基础延迟 `1000` 毫秒，速率限制延迟预算 `5 * 60 * 1000` 毫秒（`packages/coding-agent/src/web/search/providers/gemini.ts`）。

## 错误
- 工具级无提供方情况返回带有 `Error: No web search provider configured.` 的正常工具结果；不抛出。
- 工具级全部失败情况也返回带有 `Error: ...` 的正常工具结果；消息要么是单个标准化后的提供方错误，要么是所有失败提供方的分号分隔摘要。
- 提供方适配器通常为 HTTP 或协议失败抛出 `SearchProviderError(provider, message, status)`。
- 可用性探针在许多提供方中通过 `isApiKeyAvailable()` 故意吞掉查找错误并返回 `false`。
- 各提供方值得注意的失败：
  - Anthropic：缺失凭据抛出普通 `Error`；`404` 由 `formatProviderError()` 重映射为特殊最终消息。
  - Perplexity：缺失认证抛出普通 `Error`；OAuth 流的 `error_code` 事件变为 `SearchProviderError("perplexity", ...)`。
  - Gemini：认证刷新、端点回退和重试逻辑都是内部的；最终耗尽的失败会显示为 `SearchProviderError("gemini", ...)`。
  - Codex 和 Gemini 在 HTTP 响应 `200` 但没有正文时都会失败。
  - Z.AI 将格式错误的 SSE/JSON-RPC 负载视为提供方错误，并且仅在请求变体之间重试参数形式失败。
  - SearXNG 的 `findAuth()` 在任何 HTTP 调用之前，如果 Basic 认证字段不完整或无效，可能会抛出配置错误。

## 备注
- 面向模型的 schema 不暴露 `provider`，但内部调用方可以通过 `SearchQueryParams` 强制指定一个。
- `executeSearch()` 惰性地遍历 `resolveProviderCandidates()`；`resolveProviderChain()` 仍然是一个加载每个候选的兼容性辅助函数。提供方实例被缓存，通过 `getSearchProviderLabel()` 询问标签不会触发导入。
- 大多数提供方将 `limit` 和 `num_search_results` 视为同一个数字，因为适配器传递 `params.numSearchResults ?? params.limit`。Perplexity 保留两个概念。TinyFish 将合并后的值用作本地上限，按页序列化 `num_results`，并在需要更多结果时进行分页。xAI 仅将其用于对已解析来源/引用进行上限（默认 `10`，最大 `30`）。
- `recency` 在 Brave、Perplexity、Tavily、SearXNG、Kagi、TinyFish、Firecrawl、DuckDuckGo、Startpage、Google 和 Mojeek 中具有原生或引擎查询映射。xAI 将绝对日期指令保留为自然语言查询提示，因为其当前的 Responses 工具没有日期参数；Ecosia 忽略 recency。Public Web 将请求传递给其引擎。
- `packages/coding-agent/src/config/settings-schema.ts` 使用共享的 `SEARCH_PROVIDER_PREFERENCES` / `SEARCH_PROVIDER_OPTIONS` 元数据，因此设置选择器和设置向导会暴露 `auto` 以及自动链中的每个提供方。
- 免凭据的抓取器闭合了自动链：Startpage 和 DuckDuckGo 排在浏览器支持的 Ecosia、Google 和 Mojeek 路径之前；`public` 排在最后，永远不会自动选择。
- `/login exa` 将粘贴的密钥存储在 AuthStorage 中；Exa 在未认证的 `https://mcp.exa.ai/mcp` 回退之前解析已存储或环境的凭据。
