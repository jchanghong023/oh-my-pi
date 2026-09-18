# Gemini 清单扩展（`gemini-extension.json`）

本文档介绍 coding-agent 如何发现并解析 Gemini 风格的清单扩展（`gemini-extension.json`），并将其接入 `extensions` 能力。

本文档**不**涉及 TypeScript/JavaScript 扩展模块加载（`extensions/*.ts`、`index.ts`、`package.json omp.extensions`），相关内容见[扩展加载](./extension-loading.md)。

## 实现文件

- [`packages/coding-agent/src/discovery/gemini.ts`](../packages/coding-agent/src/discovery/gemini.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/capability/extension.ts`](../packages/coding-agent/src/capability/extension.ts)
- [`packages/coding-agent/src/capability/extension-module.ts`](../packages/coding-agent/src/capability/extension-module.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts)

---

## 发现范围

Gemini provider（`id: gemini`，优先级 `60`）注册了一个 `extensions` 加载器，扫描两个固定根目录：

- 用户级：`~/.gemini/extensions`
- 项目级：`<cwd>/.gemini/extensions`

路径解析通过 `getUserPath()` / `getProjectPath()` 直接基于 `ctx.home` 与 `ctx.cwd` 完成。

重要的范围规则：项目级查找**仅限 cwd**，不会向上遍历父目录。

---

## 目录扫描规则

对每个根目录（`~/.gemini/extensions` 与 `<cwd>/.gemini/extensions`），发现流程会执行：

1. `readDirEntries(root)`
2. 仅保留直接子目录（`entry.isDirectory()`）
3. 对每个子目录 `<name>`，尝试精确读取：
   - `<root>/<name>/gemini-extension.json`

一级目录之外不会进行递归扫描。

### 隐藏目录

Gemini 清单发现**不会**过滤以点号开头的目录名。如果隐藏子目录存在且其中包含 `gemini-extension.json`，同样会被纳入考虑。

### 文件缺失或不可读

如果 `gemini-extension.json` 缺失或不可读，该目录会被静默跳过（不产生警告）。

---

## 清单结构（按实现）

能力类型定义了如下清单结构：

```ts
interface ExtensionManifest {
  name?: string;
  description?: string;
  mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
  tools?: unknown[];
  context?: unknown;
}
```

发现阶段的行为有意保持宽松：

- 文件必须非空，并且 `tryParseJson()` 必须返回真值。因此，无效 JSON 与语法合法但为假值的 JSON 字面量 `null`、`false`、`0` 或 `""` 走的是同一条警告路径。
- 通过这道门槛后，不会再对字段类型/内容做任何运行时 schema 校验。
- 解析出的值会作为 `manifest` 存储在能力项上。

### 名称规范化

`Extension.name` 按以下规则设置：

1. 若 `manifest.name` 不是 `null`/`undefined`，则使用它
2. 否则使用扩展目录名

此处不做字符串类型强制。

---

## 物化为能力项

一份解析成功的有效清单会创建一个 `Extension` 能力项：

```ts
{
	name: manifest.name ?? <directory-name>,
	path: <extension-directory>,
	manifest: <parsed-json>,
	level: "user" | "project",
	_source: {
		provider: "gemini",
		providerName: "Gemini CLI" // attached by capability registry
		path: <absolute-manifest-path>,
		level: "user" | "project"
	}
}
```

说明：

- `_source.path` 会由 `createSourceMeta()` 规范化为绝对路径。
- 针对 `extensions` 的注册表级能力校验只检查 `name` 与 `path` 是否存在。
- 清单内部字段（`mcpServers`、`tools`、`context`）在发现阶段不做校验。

---

## 错误处理与警告语义

### 触发警告

- 非空清单文件中出现无效 JSON，或语法合法但为假值的 JSON 字面量：
  - 警告格式：`Invalid JSON in <manifestPath>`

### 不触发警告（静默跳过）

- `extensions` 目录缺失
- 子目录中没有 `gemini-extension.json`
- 清单文件不可读或为空
- 清单 JSON 为真值但语义上奇怪/不完整

也就是说，语义有效性不会被强制；警告的门槛是 `tryParseJson()` 结果的真值性，而不是 `ExtensionManifest` 运行时校验器。

---

## 与其他来源的优先级与去重

`extensions` 能力由能力注册表跨 provider 聚合。

该能力当前的 provider：

- `native`（`packages/coding-agent/src/discovery/builtin.ts`）优先级 `100`
- `gemini`（`packages/coding-agent/src/discovery/gemini.ts`）优先级 `60`

去重键为 `ext.name`（`extensionCapability.key = ext => ext.name`）。

### 跨 provider 优先级

出现重名扩展时，优先级更高的 provider 胜出。

- 若 `native` 与 `gemini` 都产出名为 `foo` 的扩展，则保留 native 项。
- 优先级较低的重复项仅在 `result.all` 中保留，并带有 `_shadowed = true`。

### 同 provider 内的顺序影响

由于去重遵循“先发现者胜出”，provider 内部的项顺序会影响结果。

- Gemini 加载器按**先用户级、后项目级**的顺序追加。
- 因此，当 `~/.gemini/extensions` 与 `<cwd>/.gemini/extensions` 之间出现重名时，会保留用户级条目，遮蔽（shadow）项目级条目。

相比之下，native provider 构建配置目录的顺序不同（`getConfigDirs()` 中先 `project` 后 `user`），因此 native provider 内部的遮蔽方向正好相反。

---

## 用户级与项目级行为总结

针对 Gemini 清单而言：

- 每次加载都会扫描用户级与项目级两个根目录。
- 项目级根目录固定为 `<cwd>/.gemini/extensions`（不向上遍历祖先目录）。
- Gemini 源内部的重名解析为用户级优先。
- 与更高优先级的 provider（尤其是 native）重名时，按优先级落败。

---

## 边界：清单元数据与运行时扩展模块

`gemini-extension.json` 的发现为 `extensions` 元数据能力提供输入，它**不**标识可运行的 TS/JS 入口点。

Gemini provider 会另行填充 `extension-module` 能力：扫描相同的两个扩展根目录，寻找直接的 `.ts`/`.js` 文件、`<name>/index.ts` / `index.js`，以及 `package.json` 中的 `omp`/`pi` 扩展条目。这些模块记录独立于 `gemini-extension.json`。

`discoverExtensionPaths()` 中启动时的隐式路径目前只请求 `native` provider，因此 Gemini 发现的模块记录不会在那里被自动执行。显式配置的扩展路径仍然可以被加载。

实际影响：Gemini 清单是可被发现的元数据，但无论是清单本身还是相邻的模块，都不会仅仅因为出现在 `.gemini/extensions` 下就被自动执行。
