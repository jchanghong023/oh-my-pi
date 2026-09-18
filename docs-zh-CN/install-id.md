# Install ID

一个跨会话与配置文件共享、按安装持久保存的 UUID。当 provider 兼容协议、账户范围的设备元数据、auth-broker 用量上报或去重的诊断推送需要一个稳定安装标识时，它提供稳定的安装身份。UUID 本身是随机生成的，并非派生自主机名、用户名、硬件或账户数据。

## API

从 `@oh-my-pi/pi-utils`（`packages/utils/src/dirs.ts`）导出：

| 符号                                    | 用途                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | 返回 install ID；首次调用时会生成并持久化一个。结果在运行时的生命周期内缓存于进程内。                                             |
| `__resetInstallIdCacheForTests(): void` | 清除进程内缓存。仅限测试使用 —— 严禁（MUST NOT）在生产代码中调用。                                                                |

生成的 ID 为小写的 RFC 4122 UUID。已持久化的现有值若匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（正则带 `i` 标志），则以大小写不敏感的方式接受，并按存储原样返回。

## 存储

- 路径：`<base-config-root>/install-id` —— 即默认的 `~/.omp/install-id`，遵循 `PI_CONFIG_DIR`。无论当前激活哪个配置文件，都相对基础配置根目录（`getBaseConfigRoot()`）解析，因此同一主机上的所有配置文件共享同一个 install ID（安装身份按安装计，而非按配置文件计）。
- 格式：单行 UUID（末尾带 `\n`）。
- 权限：文件以模式 `0o600` 创建。
- 生命周期：独立于 `~/.omp/agent/`。清除 agent 状态（会话、设置、数据库）并不会重新生成 install ID；只有删除 `install-id` 文件本身才会。

## 生成与生命周期

1. 首次调用 `getInstallId()` 时读取文件。若内容可解析为有效 UUID，则缓存并返回该值。
2. 否则，辅助函数会调用 `crypto.randomUUID()`（Node 基于 CSPRNG 的 UUID v4）生成一个新 ID。
3. 新值通过 `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)` 写入。独占创建保护意味着两个进程同时进行首次调用时不可能都成功 —— 落败方会看到 `EEXIST`，重新读取胜出方的文件，并采用其 ID。
4. 若现有文件包含非空的垃圾内容（未通过 UUID 正则），则会在独占创建之前先将其 `unlink`，以免 `O_EXCL` 因陈旧数据而触发。
5. 其他任何写入失败（只读文件系统、权限错误）都会被静默吞掉：新生成的 UUID 仍会缓存于内存中，使进程其余部分看到稳定的值，后续进程启动时会重试持久化。
6. 进程内的后续调用直接返回缓存值，不再触碰磁盘。首次调用之后改动磁盘上的文件不会产生任何效果，直至进程重启（或测试调用 `__resetInstallIdCacheForTests`）。

## 使用者

| 使用者                                                                                               | 用途                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/providers/openai-codex-responses.ts`                                                | 将该值作为 OpenAI Codex 兼容的 `installationId` 发送，同时附带每个会话/线程/窗口的 ID。                                                                                                  |
| `packages/ai/src/providers/anthropic.ts` 和 `packages/coding-agent/src/session/session-metadata.ts`  | 从 install ID 派生 Claude 兼容的 `device_id` 元数据，并在存在 Anthropic 账户 UUID 时以其作为作用域。原始 install ID 不会被直接用作 device ID。                                            |
| `packages/ai/src/auth-broker/remote-store.ts`                                                        | 将其包含在发送给已配置 auth broker 的观测用量报告中。这些报告还会包含主机名；install-ID 辅助函数本身并不生成或组合该元数据。                                                              |
| `packages/coding-agent/src/tools/report-tool-issue.ts`                                               | 将其作为 `installId` 包含在自动 QA 投诉推送中，以便后端能够关联来自同一安装的上报。                                                                                                       |

新增使用者必须（MUST）将该值视为不透明。该辅助函数本身不贡献任何 PII，但传输层仍可能将其与其他元数据一同发送；每个使用者仍需自行负责记录并最小化其完整负载。

## 另请参阅

- [environment-variables.md](environment-variables.md) —— `PI_CONFIG_DIR` 控制 `install-id` 的存放位置。
- [config-usage.md](config-usage.md) —— 更广泛的配置根目录布局。
