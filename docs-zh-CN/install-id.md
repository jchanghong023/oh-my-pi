# Install ID

跨会话和配置文件共享的、持久化的、每安装一次的 UUID。它在提供商兼容协议、账户范围的设备元数据、auth-broker 使用上报或去重的诊断推送需要稳定安装标识时，提供一个稳定的安装身份。该 UUID 本身是随机的，并非派生自主机名、用户名、硬件或账户数据。

## API

从 `@oh-my-pi/pi-utils`（`packages/utils/src/dirs.ts`）导出：

| Symbol                                  | Purpose                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | 返回 install ID，并在首次调用时生成并持久化一个。结果在运行时生命周期内以进程内缓存的形式保存。|
| `__resetInstallIdCacheForTests(): void` | 清除进程内缓存。仅用于测试 —— 严禁（MUST NOT）在生产代码中调用。|

生成的 ID 为小写的 RFC 4122 UUID。当已持久化的值与 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（带 `i` 标志）正则匹配时，大小写不敏感地接受，并原样按存储形式返回。

## Storage

- 路径：`<base-config-root>/install-id` —— 即默认的 `~/.omp/install-id`，遵循 `PI_CONFIG_DIR`。相对于基础配置根目录（`getBaseConfigRoot()`）解析，与当前激活的配置文件无关，因此同一主机上的所有配置文件共享同一个 install ID（安装身份是按安装计，而非按配置文件计）。
- 格式：单行 UUID（末尾带 `\n`）。
- 权限：文件以模式 `0o600` 创建。
- 生命周期：独立于 `~/.omp/agent/`。清除 agent 状态（会话、设置、数据库）不会重新生成 install ID；只有删除 `install-id` 文件本身才会。

## Generation and lifecycle

1. 首次调用 `getInstallId()` 时读取文件。若内容可解析为有效的 UUID，则该值被缓存并返回。
2. 否则助手会调用 `crypto.randomUUID()`（Node 由 CSPRNG 支持的 UUID v4）来生成新的 ID。
3. 新值通过 `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)` 写入。独占创建保护意味着两个进程同时首次调用时不可能都成功 —— 失败方会看到 `EEXIST`，重新读取胜出方的文件，并采用该 ID。
4. 若现有文件包含非空垃圾内容（未通过 UUID 正则），则会在独占创建前执行 `unlink`，以避免 `O_EXCL` 因陈旧数据触发。
5. 任何其他写入失败（只读文件系统、权限错误）都会被吞掉：新生成的 UUID 仍会缓存在内存中，以便进程其余部分看到稳定的值，后续进程启动时将重试持久化。
6. 进程内的后续调用直接返回缓存值，不再访问磁盘。在首次调用之后修改磁盘上的文件不会产生任何效果，除非进程重启（或测试调用 `__resetInstallIdCacheForTests`）。

## Consumers

| Consumer                                                                                             | Use                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/providers/openai-codex-responses.ts`                                                | 将该值作为 OpenAI Codex 兼容的 `installationId` 发送，同时附带每个会话/线程/窗口的 ID。|
| `packages/ai/src/providers/anthropic.ts` 和 `packages/coding-agent/src/session/session-metadata.ts`    | 从 install ID 派生 Claude 兼容的 `device_id` 元数据，并在有 Anthropic 账户 UUID 时按其作用域划分。原始 install ID 不直接用作 device ID。|
| `packages/ai/src/auth-broker/remote-store.ts`                                                        | 在向已配置 auth broker 上报的观测使用情况中包含该值。这些报告同时包含主机名；install ID 助手本身并不生成或组合该元数据。|
| `packages/coding-agent/src/tools/report-tool-issue.ts`                                               | 将其作为 `installId` 包含在自动 QA 投诉推送中，以便后端关联来自同一安装的举报。|

新增的使用者必须（MUST）将该值视为不透明的。助手本身不提供任何 PII，但传输层仍可能将其与其他元数据一起发送；每个使用者仍需负责记录并最小化其完整负载。

## See also

- [environment-variables.md](environment-variables.md) —— `PI_CONFIG_DIR` 控制 `install-id` 的存放位置。
- [config-usage.md](config-usage.md) —— 更广泛的配置根目录布局。
