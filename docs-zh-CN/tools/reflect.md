# reflect

> 在当前活动的长期记忆后端上综合生成答案。

## 源文件
- 入口：`packages/coding-agent/src/tools/memory-reflect.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/reflect.md`
- Hindsight 协作者：
  - `packages/coding-agent/src/hindsight/bank.ts` — 尽力而为的首次使用 bank/mission 设置（`ensureBankExists`）。
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、共享 bank 作用域、recall/reflect 配置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` 调用与错误映射。
- Mnemopi 协作者：
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域化的本地 recall 与上下文格式化。
  - `docs/tools/retain.md` — 共享后端、存储、作用域和心智模型行为。

## 注册与可见性
- 工具元数据：`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册；在 `"off"` 和 `"local"` 下不存在。
- 在具有显式工具列表的无限制会话中，注册时会自动包含共享的 `recall`/`retain`/`reflect` 集合。限制列表不会被拓宽。
- 在普通的 `tools.xdev` 会话中，可发现的內建工具可能呈现为 `xd://reflect`；显式请求的工具仍为顶层工具。
- 执行是单次性的，不会发出进度更新。

## 输入

| 字段 | 类型 | 是否必填 | 描述 |
|---|---|---:|---|
| `query` | `string` | 是 | 要从长期记忆中回答的问题。 |
| `context` | `string` | 否 | 额外的指引。Hindsight 将其作为 `context` 发送；Mnemopi 将裁剪后的上下文附加到 recall 查询中的 `Additional context:` 下。 |

## 输出
返回单次性的工具结果。

Hindsight：
- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`
- 工具直接返回 Hindsight 服务器综合的文本；不会暴露原始 recall 命中。

Mnemopi：
- 如果不存在作用域化的 recall 结果：`content[0].text = "No relevant information found to reflect on."`
- 否则：`content[0].text = "Based on recalled memories:\n\n<formatted context>"`
- `details = {}`
- 本地路径执行 recall 加格式化；不会调用综合模型或独立的综合接口。因此其结果可能是原始的 recall 上下文，而非混合后的答案。

## 流程
1. `MemoryReflectTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露该工具。
2. `execute(...)` 在 `untilAborted(...)` 下运行。
3. 如果后端是 `mnemopi`：
   - 读取 `session.getMnemopiSessionState()`，如果后端未启动则抛出异常；
   - 如果 `context` 含有非空白内容，则使用 `<query>\n\nAdditional context:\n<context>` 进行 recall；否则使用 `query` 进行 recall；
   - 使用与 `recall` 相同的本地作用域和合并行为调用 `state.recallResultsScoped(...)`；
   - 如果存在结果，则通过 `state.formatContextScoped(...)` 渲染，并在前面加上 `Based on recalled memories:`。
4. 如果后端是 `hindsight`：
   - 读取 `session.getHindsightSessionState()`，如果后端未启动则抛出异常；
   - 使用当前的 `bankId`、配置和会话状态中的 `banksSet` 调用 `ensureBankExists(...)`；
   - `ensureBankExists(...)` 对 `/v1/default/banks/{bank_id}`（`createBank`）尽力执行 `PUT`，每个会话状态中每个 bank 一次，可选地附带 `reflect_mission` / `retain_mission`；失败会被吞掉；
   - 使用 `query`、可选的 `context`、配置的 recall 预算和 bank 作用域 tag 过滤器调用 `state.client.reflect(...)`；
   - `HindsightApi.reflect(...)` POST `/v1/default/banks/{bank_id}/reflect`，当调用方未指定预算时，其自身默认预算为 `"low"`；此工具始终传入配置的预算；
   - 空白或仅包含空白字符的响应会被替换为 `No relevant information found to reflect on.`。
5. 后端失败会以 `logger.warn("reflect failed", ...)` 记录，并在需要时作为 `Error` 实例重新抛出。

## 模式 / 变体
- Hindsight 工具路径：一次远程 reflect 请求，可选择由 `context` 聚焦。
- Mnemopi 工具路径：一次本地作用域化的 recall 后接上下文格式化。
- Hindsight bank 作用域：
  - `global` — 不使用 tag 过滤器。
  - `per-project` — 每个项目标签一个独立的 bank id（git 主检出根目录的 basename；非仓库内为 cwd 的 basename）。
  - `per-project-tagged` — 共享 bank id，外加 `project:<project label>` 过滤器，`tagsMatch = "any"`。
- Mnemopi bank 作用域：
  - `global` — 读取共享 bank。
  - `per-project` — 读取由绝对 cwd basename 与该 cwd 的哈希共同派生的 bank。
  - `per-project-tagged` — 读取由 cwd 派生的项目 bank 和共享 bank，然后合并结果。
  - 每次项目模式还可能包含在启动时发现的安全 cwd 匹配遗留 bank。
- 会话作用域：读取跨会话的内存数据，但不持久化本地输出。子代理别名使用父级后端作用域。

## 副作用
- 网络
  - Hindsight：由 `ensureBankExists(...)` 触发的可选 `PUT /v1/default/banks/{bank_id}`，然后是 `POST /v1/default/banks/{bank_id}/reflect`。
  - Mnemopi：除非本地运行时在 recall 期间使用了已配置的 embedding 或 LLM 提供方，否则无网络操作。
- 会话状态
  - 仅读取会话持有的后端作用域和配置。不更新 `lastRecallSnippet`、Hindsight 心智模型缓存或 retain 队列。
- 后台工作 / 取消
  - 如果工具调用信号被取消，则通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`；默认的 `memory.backend` 是 `"off"`。
- 工具级参数：仅 `query` 是必填项；`context` 是可选。两者都是纯字符串，schema 层没有最小长度。
- Hindsight 预算来自 `hindsight.recallBudget`，默认为 `"mid"`。
- Hindsight `reflect` 在此没有客户端 token 上限参数；其请求截止时间默认为 `hindsight.reflectTimeoutMs = 120_000`。
- Hindsight bank 初始化在每个会话状态中最多跟踪 `MISSION_SET_CAP = 10_000` 个 bank id，然后丢弃排序后集合的一半。
- Mnemopi 结果数量受 `mnemopi.recallLimit` 上限约束，默认为 `8` 且运行时下限为 1；每个 recall 到的内容预览默认为 500 字符上限。

## 错误
- 当 `memory.backend == "mnemopi"` 但不存在状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但不存在状态时，抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight 的 HTTP、fetch 和超时失败会变为 `HindsightError`；HTTP 错误在可用时会包含 `statusCode` 和解析后的 `details`。
- Hindsight `ensureBankExists(...)` 的失败会以 debug 级别记录，并对调用者隐藏；只有后续的 reflect 请求可能以可见方式失败。
- Mnemopi recall 按目标捕获失败并记录它们。健康的目标仍会贡献结果；如果每个尝试的目标都失败，则抛出原始错误或多 bank 的 `AggregateError`，而不是转换“无信息”文本。
- 工具捕获到的非 `Error` 失败在重新抛出之前会被规范化为 `new Error(String(err))`。

## 备注
- 共享后端的详细信息见 `docs/tools/retain.md`：存储、子代理别名、bank 作用域、种子心智模型和提示词注入。
- Hindsight `reflect` 不会直接读取缓存的 `<mental_models>` 块。它通过 bank 内容查询 Hindsight 服务器。同一个会话可能在开发者指令中单独拥有心智模型上下文。
- Hindsight reflect 和 retain mission 是 bank 级别的服务器设置，而非每次请求的负载。该工具仅在 reflect 之前尽力确保它们存在。
- Mnemopi `reflect` 是本地 recall 加格式化。它并未实现通用面向模型 `reflect` 提示词所承诺的综合能力。