# 嵌入式本地小模型实验

本文档汇总了会话标题生成（`providers.tinyModel`）、Mnemopi 记忆提取/整合（`providers.memoryModel`）以及 `auto` 思维层级难度分类器（`providers.autoThinkingModel`，使用记忆模型注册表）三个可选 **local** 小模型路径背后的实验。它是面向维护者的一份客观工程记录：我们测量了什么、哪些方案胜出，以及我们发布了哪些模型。三个设置均默认 `online`，因此除非用户主动启用，否则现有用户不会产生下载或设备端推理开销。在在线路径上，优先使用已配置的 `tiny` 角色；当该角色未设置时，则使用该任务特定的在线回退。

## 运行时 / 环境发现

- **技术栈**：`@huggingface/transformers`（transformers.js）v4，运行在 Bun 之下。在 Bun 中，该库会加载**原生 `onnxruntime-node` 后端**（而非 WASM 构建）。
- **非 FHS 发行版（NixOS，以及任何加载器路径上缺少 `libstdc++.so.6` 的主机）**：按需加载的 `onnxruntime-node` / `sherpa-onnx-node` / `sharp` addon 均为预编译二进制文件，会 `dlopen` `libstdc++.so.6` 和 `libgcc_s.so.1`，并自带 `DT_RUNPATH`，因此 omp 可执行文件自身的 RPATH 无法解析它们。请将 `OMP_NATIVE_LIBRARY_PATH` 设置为包含这些库的、以冒号分隔的目录列表；omp 只会将其追加到推理工作进程子进程的 `LD_LIBRARY_PATH` 中（绝不会追加到 shell/eval/daemon 子进程）。Nix 包（`nix/package.nix`）默认会设置此项。
- **每个模型一个工作进程，keep-alive 但不常驻**：每个本地模型在整台机器上恰好由一个持有套接字 `~/.omp/run/tiny/<model>-<backend>.sock`（Windows 上为命名管道）的工作进程服务。第一个需要该模型的 omp 进程会以分离方式派生该工作进程（日志写在套接字旁边，`*.sock.log`）；其余 omp 进程只是连接上去，因此模型只常驻一份，而不是每个实例各一份。没有任何进程监督它：工作进程在 15 分钟无请求后自行退出（`OMP_TINY_WORKER_IDLE_MS` 可为测试覆盖该时间窗），并删除自己的套接字，之后任何 omp 进程的下一个请求都会派生一个新的工作进程。并发派生会通过 `.bind.lock` 文件锁竞争：输者看到已有活跃套接字便退出，而其父进程会收养赢者。`ping` 会返回启动标签（`<omp version>|onnx|<device>|<dtype>` 或 `mlx|<mlx-lm version>|<script crc>`），因此 omp 升级或 `providers.tinyModelDevice`/`Dtype` 变化会让运行中的工作进程关停并重新派生一个。两个使用*冲突*设备设置的并发实例会不断互相替换对方的工作进程，因此请统一为一套设置。协议是消息级的（`load`，以及携带 messages / prefill / stop / max tokens 的 `chat`）；提示词构建与标题提取逻辑位于客户端，因此两种工作进程可以互换。
- **设备策略**：本地小模型默认仅进行 CPU 推理；当显式指定的加速 provider 无法初始化时，会在 CPU 上重试一次。
  - 可通过 `providers.tinyModelDevice` 设置（`default` 保持 CPU）持久选择 provider，也可通过 `PI_TINY_DEVICE` 环境变量按次选择（其会覆盖该设置）。
  - 接受的值为 `cpu`、`gpu`、`mlx`/`metal`、`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu` 和 `webnn-npu`。
  - 直接使用 `coreml` 仍需通过 `PI_TINY_DEVICE=coreml` 显式启用；它不属于默认项，因为缓存的 decoder-LLM ONNX 在会话初始化阶段可能加载失败。
  - WebGPU/Metal 可在单进程 eval 评测环境中工作，但生产工作进程会把 Darwin 上的 `gpu`/`webgpu`/`auto` 请求强制回退到 CPU，因为 ONNX Runtime/Bun 目前在 WebGPU 推理后的工作进程销毁阶段会硬崩溃。
  - 仅在显式放弃 CPU 默认值时，才使用 `providers.tinyModelDevice` 或 `PI_TINY_DEVICE`。
- **MLX 后端（Apple silicon）**：`PI_TINY_DEVICE=mlx`（或 `metal`）替换的是工作进程本身，而非 ONNX provider：每个模型的工作进程是 `mlx-server.py`，它运行在一个锁定版本的 `mlx-lm` venv 中，omp 会在首次使用时把该 venv 安装到 `~/.omp/agent/cache/tiny-mlx-runtime/`（优先通过 `uv`，否则用 Python ≥ 3.10 的 `python3 -m venv`）。它会把模型预量化的 4-bit MLX 导出（注册表中的 `mlxRepo`）下载到 `~/.omp/agent/cache/tiny-models/mlx/`（带逐字节进度），用 `mlx_lm.load` 加载，并使用与 ONNX 工作进程完全相同的协议，因此标题生成、记忆补全和 `auto` 思维分类器都无需改动即可照常工作，且 Python 进程是唯一参与的进程。`PI_TINY_DTYPE` 会被忽略。如果 venv 引导失败（无 Python、安装出错、非 Apple 主机），omp 会记录一条警告，并在该进程剩余运行期间改用 ONNX CPU 工作进程。在 M4 Max 上实测：首次冷启动的 venv 安装 + LFM2.5-230M 下载 + 加载共耗时 15.7 秒；第二个 omp 实例在远不足一秒内即可接入运行中的工作进程；预热后标题生成耗时 15–60ms；Qwen3-1.7B（在 onnxruntime-node 上被阻塞）下载 984MB，并能在约 200ms 内完成一次记忆提取。
- **量化：q4 是最佳折中** — 磁盘占用更小、加载更快、推理也快。在 CPU 上，q8/int8 加载更慢_并且_推理也更慢。每个已发布模型默认均为 `q4`；可通过 `providers.tinyModelDtype` 设置持久覆盖精度（`default` 保持 `q4`，例如 `fp16` 以获得更高保真度），或通过 `PI_TINY_DTYPE`（其会覆盖该设置）按次覆盖。接受 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`；无法识别的值会在工作进程启动时直接报错。
- **加载时间修正（重要）。**此前认为“q4 >=1B 模型加载需要数分钟”的观点是**测量假象**，由并行运行约 5 个多 GB 的 HuggingFace 下载（I/O 饱和）所致。干净、隔离的**热**加载均低于 3 秒：
  - TinyLlama-1.1B q4：约 0.5 秒
  - Llama-3.2-1B q4：约 2.8 秒（`graphOpt=all`）/ 约 0.5 秒（`disabled`）
  - LFM2-1.2B q4：约 0.36 秒
  - Qwen2.5-1.5B q4：约 1.5 秒
  - Qwen3-1.7B q4：约 1.6 秒
  - gemma-3-1b q4：约 1.1 秒
  - 结论：**1B–1.7B 模型在 CPU 上是可行的。**
- **`session_options.graphOptimizationLevel`** 在加载速度与推理速度之间权衡：`disabled` = 加载最快，推理略慢；`all` = 默认值。
- **首次运行**会把权重从 HF Hub 下载到缓存目录（q4 权重约 150MB–1.1GB，取决于模型）；后续的**热**加载在亚秒级到约 3 秒之间。推理是异步的，适合记忆任务在后台执行；标题生成则是半交互式的。

## 任务 1：会话标题生成（`providers.tinyModel`）

**任务**：把第一条用户消息转换为 3–7 个单词的标题。小模型（亚 1B）即可胜任。

**胜出方案**：

- 朴素的系统提示词（无少样本示例）。
- 用 `<title>` **预填充**助手轮次，并**在 `</title>` 处停止**，然后取第一行。
- 贪婪解码（`do_sample:false`），聊天模板中设置 `enable_thinking:false`。

**我们的发现**：

- **少样本示例会污染亚 0.6B 模型的标题**：示例主题会被照抄进输出。共享提示词为嵌入式模型关闭了示例，同时为能力更强的在线模型保留示例。
- **在最小的模型上，大小写指令本身会变成输出内容**。[`normalizeGeneratedTitle`](../packages/coding-agent/src/tiny/text.ts) 会在生成后修正大小写，因此提示词中省略了这条规则。
- **Token 偏置（`bad_words_ids`）在此被证实无效** — 预填充已经控制了开头。

**替代基准测试**（30 条近期首次会话提示词，q4 CPU，无示例）：

| 模型               |  缓存 | 热加载均值 / p95 |      3–7 词 | 观察到的权衡                     |
| ------------------ | ----: | --------------: | ----------: | ----------------------------------------------- |
| LFM2.5-230M        | 214MB |      93 / 194ms |       21/28 | 语义平衡最佳；偶尔出现泛泛的标题 |
| Falcon-H1-Tiny-90M | 147MB |     117 / 174ms |       17/29 | 最小；复杂输入下保真度较低       |
| LFM2.5-350M        | 292MB |     166 / 266ms |        4/30 | 过度简短，常是单个单词的标签     |

**已发布的本地选项**：`lfm2.5-230m`、`lfm2.5-350m`、`falcon-h1-90m`。
**默认设置**：`online`。`omp tiny-models` 的默认本地下载为 `lfm2.5-230m`。

## 任务 2：Mnemopi 记忆（`providers.memoryModel`）

Mnemopi 运行两个小 LLM 任务：

1. **提取** — 从单条消息中抽取持久且结构化的条目。
2. **整合** — 将一组记忆概括为 1–3 句忠实的句子。

这些任务**需要比标题生成更大的模型：1B–1.7B**。我们通过四个并行 agent 各运行 27–31 次实验，测试了 LFM2-1.2B、Qwen2.5-1.5B、Qwen3-1.7B 和 gemma-3-1b（q4，CPU）。

### 提取发现

标准的 5 类 JSON 提示词在小模型上会以两种方式失败：

1. 全空示例 `{"facts":[],...}` 被**逐字复制** → 提取到 0 条事实。
2. 能力足够的模型会输出**数组内嵌 JSON 对象**，而 Mnemopi 的 `String(item)` 会将其强制转换为字面字符串 `[object Object]`。

稳健的修复方案是**每行一条的输出格式**（由 Mnemopi 解析器的行回退消费）或**扁平的字符串 JSON 数组**。每个模型也都会过度提取纯闲聊；显式的闲聊 → NONE 示例是最佳缓解手段。

### 与标题生成相比的技术极性反转

- 在 1B+ 时，**少样本是主导的质量杠杆**：例如 Qwen2.5-1.5B 的提取 F1 从 1 样本到 3 样本由 0.52 提升至 0.83；gemma 在 2 样本下召回率由 0.65 提升至 0.92。
- **预填充对提取有害** — 它会在闲聊上强制产生输出，导致假阳性。
- **系统拆分**（指令放在 system 角色中）对具备 system 角色的模型有帮助。
- **贪婪解码 >= 温度采样**，对两个任务皆成立。
- **Token 偏置**同样无效。

### 各模型判定（直接对比，16 样本集）

- **Qwen3-1.7B** — 提取最有纪律：闲聊时返回空，无埋藏事实泄漏，保留语言，干净的扁平 JSON。弱点：粒度较粗，漏掉了一次多轮的价值更新。
- **Qwen2.5-1.5B** — 提取粒度最佳（原子级事实），捕获了价值更新，零闲聊泄漏。弱点：整合最弱（连写、无去重），并出现过一次退化的埋藏事实输出。
- **gemma-3-1b** — 整合最佳（去重有效、忠实、干净的单条记忆）。弱点：会泄漏闲聊和德语翻译内容。
- **LFM2-1.2B** — 稳健且加载最快。弱点：`Label: value` 噪声、闲聊 + 埋藏事实泄漏，以及一条空洞的单条记忆摘要。

### 推荐与当前可用情况

实验倾向于在提取精度上选择 **Qwen3-1.7B**，但其已发布的 ONNX 导出当前无法在 `onnxruntime-node` 下运行：其 RotaryEmbedding 缓存更新不受支持。运行时会在加载模型之前直接拒绝此选择，而不是在推理期间失败。

在可运行的选项中，注册表将 `lfm2-1.2b` 标记为推荐的本地记忆模型。`gemma-3-1b` 偏向整合质量，而 `qwen2.5-1.5b` 偏向细粒度提取。

**已配置的本地选项**：`llama3.2:3b`、`qwen3-1.7b`（当前因上文所述原因被禁用）、`gemma-3-1b`、`qwen2.5-1.5b`、`lfm2-1.2b`。
**默认设置**：`online`。

### 已知 Mnemopi 解析器缺陷（由这些实验暴露）

- `String(item)` 在对象数组项上会产生 `[object Object]`。
- 行回退会丢弃 `<=10` 个字符的条目，因此类似 `Name: Can` 的正确短事实会被丢弃。

## 集成说明

- `providers.tinyModel`、`providers.memoryModel` 和 `providers.autoThinkingModel` 默认均为 `online`，因此现有用户**除非主动启用，否则不会产生下载或设备端推理开销**。
- 本地推理在**工作进程**中运行（不占用主线程）；模型缓存在磁盘上，并在首次使用时下载。
- 记忆的本地路径通过 Mnemopi 提示词覆盖应用了精炼后的方案（行格式 + 带闲聊防护的提取提示词、强化的整合提示词）；**在线路径未发生变化**。
- `providers.autoThinkingModel` 使用与 `providers.memoryModel` 相同的已发布本地选项。
