# Mnemopi 记忆后端

Oh My Pi 可以使用 `@oh-my-pi/pi-mnemopi` 作为本地长期记忆后端。

设置：

```yaml
memory:
  backend: mnemopi
```

示例：

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged
```

启用此后端后，编码智能体会：

1. 根据配置的 bank 作用域，打开一个或多个本地 Mnemopi SQLite 数据库。
2. 在会话的第一个模型轮次中，将相关记忆回填到 `<memories>` 块中；若从 `agent_start` 监听器触发回查，则刷新基础提示词。
3. 在智能体轮次之后，将已完成的对话轮次保留到 retain bank 中，频率不高于 `mnemopi.retainEveryNTurns`。
4. 当压缩向记忆后端请求 `preCompactionContext` 时，将回查到的记忆作为额外的压缩上下文加入。
5. 通过共享的记忆后端接口，使用常规的 `/memory view`、`/memory stats`、`/memory diagnose`、`/memory clear` 和 `/memory enqueue` 命令。

回查到的记忆属于背景上下文，而非指令。当与当前用户消息或工具输出发生冲突时，以后者为准。

## 智能体工具

选择 Mnemopi 后，以下工具变为可发现：

- `recall` — 搜索作用域内的记忆。结果为预览形式，并包含记忆 ID。
- `retain` — 显式存储持久化事实。
- `reflect` — 在回查到的记忆之间综合得出答案。
- `memory_edit` — 按 ID 对可编辑的记忆执行 `update`、`forget` 或 `invalidate`。事实表行是只读的。

在替换回查结果之前，使用 `read memory://<memory-id>` 读取完整的内容和元数据；截断的回查预览不能作为安全的更新载荷。当 `autolearn.enabled: true` 时，可选的 `learn` 工具也能向 Mnemopi 中 retain。

## 设置

| 设置                          | 默认值            | 描述                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`              | `off`             | 设置为 `mnemopi` 以启用此后端。                                                                                                                                                                                                                                                        |
| `mnemopi.dbPath`              | 智能体记忆目录    | 可选的 SQLite 数据库路径。                                                                                                                                                                                                                                                             |
| `mnemopi.bank`                | 未设置            | 传递给 `Mnemopi` 的可选共享 bank 基础名称；编码智能体包装器会根据 `mnemopi.scoping` 从该基础派生作用域。未设置 → 共享 bank `default`；per-project 模式从工作目录的 basename 加上其绝对路径的稳定哈希中派生项目 bank。                                                                       |
| `mnemopi.scoping`             | `per-project`     | 记忆可见性模式：`global` = 一个共享 bank，`per-project` = 隔离的项目记忆，`per-project-tagged` = 项目本地写入加上全局回查可见性。                                                                                                                                                     |
| `mnemopi.autoRecall`          | `true`            | 在会话的第一个轮次回查记忆。                                                                                                                                                                                                                                                           |
| `mnemopi.autoRetain`          | `true`            | 自动保留已完成的轮次。                                                                                                                                                                                                                                                                 |
| `mnemopi.polyphonicRecall`    | `false`           | 启用 4 路多声部回查（向量、图谱、事实、时间），采用倒数排名融合；当设置了 `MNEMOPI_POLYPHONIC_RECALL` 时由其覆盖。                                                                                                                                                                    |
| `mnemopi.enhancedRecall`      | `false`           | 为重复或相似的回查查询启用分层查询结果缓存；当设置了 `MNEMOPI_ENHANCED_RECALL` 时由其覆盖。                                                                                                                                                                                            |
| `mnemopi.proactiveLinking`    | `false`           | 在存储新记忆时将其摄入情景图谱，并链接到相关实体/记忆；当设置了 `MNEMOPI_PROACTIVE_LINKING` 时由其覆盖。                                                                                                                                                                              |
| `mnemopi.retainEveryNTurns`   | `4`               | 自动 retain 写入之间的最小用户轮次数。                                                                                                                                                                                                                                                 |
| `mnemopi.recallLimit`         | `8`               | 提示词块中回查记忆的最大数量。                                                                                                                                                                                                                                                         |
| `mnemopi.recallContextTurns`  | `3`               | 回查查询中包含的先前用户限定轮次。                                                                                                                                                                                                                                                     |
| `mnemopi.recallMaxQueryChars` | `4000`            | 组合回查查询的最大长度。                                                                                                                                                                                                                                                               |
| `mnemopi.injectionTokenLimit` | `5000`            | 记忆提示词注入的大致 token 预算。                                                                                                                                                                                                                                                      |
| `mnemopi.debug`               | `false`           | 启用后端失败时的调试日志。                                                                                                                                                                                                                                                             |
| `mnemopi.noEmbeddings`        | `false`           | 将 `noEmbeddings` 传递给 `Mnemopi` 并强制仅使用 FTS 的回查。                                                                                                                                                                                                                          |
| `mnemopi.embeddingVariant`    | `en`              | 本地嵌入模型变体：`en` = `BAAI/bge-base-en-v1.5`（768d），`multilingual` = `intfloat/multilingual-e5-large`（1024d）。`mnemopi.embeddingModel` / `MNEMOPI_EMBEDDING_MODEL` 会覆盖它；更改它会在下一次可写启动时重建已存储的嵌入。                                                            |
| `mnemopi.embeddingModel`      | 变体默认值        | 显式嵌入模型 id；覆盖 `mnemopi.embeddingVariant`。优先级：本设置 > `MNEMOPI_EMBEDDING_MODEL` 环境变量 > 变体默认值。                                                                                                                                                                   |
| `mnemopi.embeddingApiUrl`     | 环境变量/默认值   | 传递给 `Mnemopi` 的 OpenAI 兼容嵌入端点。                                                                                                                                                                                                                                              |
| `mnemopi.embeddingApiKey`     | 环境变量/默认值   | 传递给 `Mnemopi` 的嵌入 API 密钥。                                                                                                                                                                                                                                                     |
| `mnemopi.llmMode`             | `smol`            | `smol` 先解析已配置的 pi-ai `tiny` 角色再解析 `smol`；`remote` 使用下面的设置；`none` 禁用 LLM 调用。                                                                                                                                                                                  |
| `mnemopi.llmBaseUrl`          | 环境变量/默认值   | `llmMode: remote` 使用的 OpenAI 兼容 LLM 端点。                                                                                                                                                                                                                                        |
| `mnemopi.llmApiKey`           | 环境变量/默认值   | `llmMode: remote` 使用的 LLM API 密钥。                                                                                                                                                                                                                                                |
| `mnemopi.llmModel`            | 环境变量/默认值   | `llmMode: remote` 使用的 LLM 模型 id。                                                                                                                                                                                                                                                 |

## 作用域

编码智能体包装器在底层 `Mnemopi` 包之上应用作用域：

- `global` 对回查和写入使用一个共享 bank。
- `per-project` 写入并回查一个仅从当前工作目录派生的 bank —— 由其 basename 加上其绝对路径的稳定哈希组成，与周围的 git 布局无关。
- `per-project-tagged` 写入项目本地 bank，并同时从项目本地 bank 和共享全局 bank 进行回查，重复的回查结果会合并。

项目加全局的组合行为由包装器实现。`@oh-my-pi/pi-mnemopi` 包本身仍然直接暴露 bank 和构造选项，包括用于选择 bank 名称的 `bank`。除共享 bank 之外的项目本地 bank 存储为由 Mnemopi 的 `BankManager` 管理的兄弟 bank 数据库。

## LLM 与嵌入

FTS 和嵌入路径使用下面的设置。基于 LLM 的抽取/整合在选定的情况下使用配置的本地设备端记忆模型（`providers.memoryModel`），否则 `llmMode: smol` 先解析 `tiny` 角色再解析 `smol`；`llmMode: remote` 使用 OpenAI 兼容端点设置；`llmMode: none` 禁用 LLM 调用。如果无法解析 tiny/smol 模型或当前的凭证，Mnemopi 会在没有基于 LLM 的工作的情况下继续运行。

仅 FTS：

```yaml
memory:
  backend: mnemopi
mnemopi:
  noEmbeddings: true
```

等价的构造形式：

```ts
new Mnemopi({ noEmbeddings: true });
```

远程嵌入：

```yaml
mnemopi:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

等价的构造形式：

```ts
new Mnemopi({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

远程 LLM：

```yaml
mnemopi:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

等价的构造形式：

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

用于轮换 OAuth 令牌的动态函数 LLM：

```ts
new Mnemopi({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithPiAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

pi-ai tiny/smol 角色 LLM：

```yaml
mnemopi:
  llmMode: smol
```

编码智能体先解析 `tiny` 再解析 `smol`，并传入一个动态的完成函数，以便每次 Mnemopi LLM 调用都能在调用时获取当前的提供者凭证：

```ts
new Mnemopi({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## 运行注意事项

- 默认共享数据库位于智能体记忆目录下的 `mnemopi/mnemopi.db`；项目作用域的 bank 使用该 Mnemopi 目录下的兄弟数据库路径。
- `/memory clear` 会移除当前配置下每个作用域内的 Mnemopi SQLite 数据库以及对应的 WAL/SHM 边车文件。
- `/memory enqueue` 强制保留当前会话、刷新待处理的事实抽取，并为符合条件的工作记忆行运行 Mnemopi 的 sleep/consolidation。
- 当 Mnemopi 后端处于激活状态时，`/memory stats` 和 `/memory diagnose` 会呈现特定于后端的 bank 统计/诊断信息。
- 子智能体不拥有独立的 Mnemopi retain 循环；当存在父级 Mnemopi 状态时，它们复用父级状态，否则保持静默。
- 后端启动是尽力而为的。如果数据库/模型初始化失败，会话将以 Mnemopi 静默的方式继续，并记录一条警告；随后记忆工具会报告后端尚未初始化。

## 关闭与持久性

常规的交互式和打印模式退出使用的路径刻意比 `/memory enqueue` 更轻量：

1. 主状态保留当前对话记录，并禁用新的事实抽取。
2. 它会刷新已经在进行中的抽取，但不运行单次会话的 sleep 或完整的跨会话提升。
3. 仅在该排空完成之后，它才会关闭所拥有的 SQLite bank 句柄；由于排空过程可能仍在使用嵌入工作线程，嵌入工作线程在状态释放之后才关闭。

别名复用的子智能体状态不拥有或不关闭共享 bank；父级状态负责最终的 retain、刷新和句柄关闭。

交互式和打印退出为该排空提供 1.5 秒的时间。如果预算耗尽，关闭过程会分离正在进行的排空，并安排在排空完成时再关闭句柄，以避免与已关闭的数据库产生写入竞争。进程可能会先退出。已经写入的工作记忆行保持持久，但最后几轮的记忆提升或嵌入可能仍未完成；在智能体结束时执行的较早轮次的 retain 不受影响。

`/memory enqueue` 是显式且更强的持久性边界：它强制 retain、刷新待处理的抽取，并在拥有的 bank 上运行完整的 sleep/consolidation。它不会绕过 Mnemopi 的 age gate：`sleepAllSessions` 选取早于 `Math.floor(workingMemoryTtlHours / 2)` 小时（在默认 24 小时 TTL 下为 12 小时）的未整合工作记忆行。因此，新鲜的行在立即执行 enqueue 后仍保留在工作记忆中。在退出前使用该命令以强制 retain 并刷新待处理工作，或者在 age gate 之后再使用以提升符合条件的行；正常的关闭不会提升它们。
