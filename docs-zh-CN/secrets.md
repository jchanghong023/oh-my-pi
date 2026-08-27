# 密钥混淆

防止敏感值（API 密钥、令牌、密码）被发送给 LLM 提供方。启用后，配置的密钥以及内置的凭据形态令牌模式会在离开进程、对提供方可见的文本中先被替换。可逆的占位符会在执行前于模型生成的工具参数中还原，并在为显示或恢复而重建本地会话上下文时还原。

## 启用

默认关闭。可通过 `/settings` 界面切换，或直接在 `config.yml` 中设置：

```yaml
secrets:
  enabled: true
```

## 工作原理

1. 在会话启动时，密钥从以下来源收集：
   - **环境变量**：名称匹配常见密钥模式（`KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PASS`、`AUTH`、`CREDENTIAL`、`PRIVATE`、`OAUTH`），且值长度至少为 8 个字符
   - **`secrets.yml` 文件**（见下文）
   - 一条内置的可逆正则，用于匹配仅出现在会话内容或工具结果中、形态类似 GitHub、GitLab、OpenAI 凭据令牌的字符串

2. 对提供方可见的文本中，匹配的值会被替换为确定性占位符，例如 `$$3P8W5JH1TK2Q$$`、`$$3P8W5JH1TK2Q:L$$` 或 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`。

3. 实时的模型生成工具参数会被深度遍历，并在工具执行前还原占位符。会话上下文为本地显示/恢复而还原占位符，并在提供方回放前重新混淆。replace 模式的替换是单向的、不可还原。

两种模式控制每个密钥的处理方式：

| 模式                  | 行为                                                                                          | 可逆 |
| --------------------- | --------------------------------------------------------------------------------------------- | ---- |
| `obfuscate`（默认）   | 替换为确定性的 `$$HASH(:hint)$$` 或 `$$FRIENDLY_HASH(:hint)$$` 占位符                          | 是   |
| `replace`             | 替换为配置的 `replacement`，若未提供则替换为长度相同的确定性值                                  | 否   |

obfuscate 模式下的普通值以及短于 8 个字符的正则匹配会被忽略，以避免误改普通的短词。replace 模式可以处理短值；只有当一条 replace 模式的正则无法将每个可能的 1–2 字符匹配替换为不同的稳定值时，没有自定义 replacement 的该正则才会被拒绝。

## secrets.yml

在 YAML 中定义自定义密钥条目。会检查两个位置：

| 级别   | 路径                       | 用途                 |
| ------ | -------------------------- | -------------------- |
| 全局   | `~/.omp/agent/secrets.yml` | 跨所有项目的密钥     |
| 项目   | `<cwd>/.omp/secrets.yml`   | 项目专属的密钥       |

`content` 相同的项目级条目会覆盖全局级条目。

### Schema

数组中每个条目具有以下字段：

| 字段          | 类型                         | 必填 | 描述                                                       |
| ------------- | ---------------------------- | ---- | ---------------------------------------------------------- |
| `type`        | `"plain"` 或 `"regex"`       | 是   | 匹配策略                                                   |
| `content`     | string                       | 是   | 密钥值（plain）或正则模式（regex）                         |
| `mode`        | `"obfuscate"` 或 `"replace"` | 否   | 默认：`"obfuscate"`                                        |
| `replacement` | string                       | 否   | 自定义替换值（仅 replace 模式）                            |
| `flags`       | string                       | 否   | 正则标志（仅 regex 类型）                                  |
| `friendlyName`| string                       | 否   | obfuscate 模式占位符的、经过清理的、对模型可见的标签        |

### 示例

#### 普通密钥

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### 友好名称

`friendlyName` 在不暴露密钥值的前提下，为可逆混淆占位符补充语义上下文：

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

这会生成形如 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$` 的占位符。友好名称会被清理为仅含大写字母与数字，长度上限为 32 个字符；若清理后为空则省略。无效的可选 `friendlyName` 元数据不会使该密钥条目失效；该密钥仍会使用无标签的占位符进行混淆。如果某个占位符的标签会泄露已配置的明文密钥值或匹配到已配置的密钥正则，该标签也会被丢弃。

12 字符的哈希基是精确密钥在某个安装级私有密钥下的 HMAC（该密钥存储在 `~/.omp/agent/secret-placeholder.key`，在启用 XDG 的安装中为 `$XDG_STATE_HOME/omp/secret-placeholder.key`，绝不会发送给模型）。这可以防止会话阅读者通过字典哈希将占位符反推回密钥。仅大小写不同的密钥会得到独立的基，因此仅看到一个占位符无法让提供方通过改变大小写提示合成另一个占位符。在内置令牌懒加载路径上若无法持久化该密钥，会话会发出警告并使用进程级临时密钥；混淆在同一进程内仍可逆，但占位符在重启之间不稳定。大小写提示后缀用于标注被遮蔽值的大小写形式：

| 提示 | 含义                            |
| ---- | ------------------------------- |
| `:U` | 所有有大小写的 ASCII 字母均为大写 |
| `:L` | 所有有大小写的 ASCII 字母均为小写 |
| `:C` | 首个有大小写的 ASCII 字母大写，其余小写 |
| `:M` | 混合的 ASCII 大小写             |

regex 条目上的 `friendlyName` 标注的是所配置的正则条目本身，而非其匹配到的值。请将正则标签设置得足够宽泛，使其对每一次匹配都成立。

#### 正则密钥

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

regex 条目始终以全局方式扫描（`g` 标志会被自动强制启用）。正则字面量语法 `/pattern/flags` 可作为独立的 `content` + `flags` 字段的替代形式。模式中的转义斜杠（`\\/`，按字面量呈现两个反斜杠加斜杠的写法）会被正确处理。

#### replace 模式与正则

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## 无效的条目与文件

- 缺失的 `secrets.yml` 被视为没有条目。
- 解析失败或非数组文档会以警告方式忽略。
- 无效的条目会逐条以警告方式跳过。`type` 必须为 `plain` 或 `regex`；`content` 必须为非空字符串；`mode`、`replacement`、`flags` 以及正则语法需按上文所述进行校验。
- 无效的可选 `friendlyName` 元数据会被丢弃，但不会使原本合法的条目失效。

## 与自动检测的交互

环境变量首先被收集，随后是文件定义的条目，最后运行内置的凭据正则，以便配置的条目能在通用检测器之前看到匹配的内容。环境扫描内部，重复的环境值会被合并。环境条目与文件条目之间不会互相去重，因此同一明文值若同时出现在两处会被登记两次；两个占位符会还原为同一密钥，因此解混淆不受影响。

## 关键文件

- `packages/coding-agent/src/secrets/index.ts` -- 加载、合并、环境变量收集
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` 类、占位符生成、消息混淆
- `packages/coding-agent/src/secrets/regex.ts` -- 正则字面量解析与编译
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` 设置定义

## 另请参阅

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- 远程凭据保险库与转发代理，使提供方 OAuth 刷新令牌与访问令牌完全脱离开发主机（与进程内混淆互补）。
