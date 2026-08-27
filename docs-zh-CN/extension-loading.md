# 扩展加载（TypeScript/JavaScript 模块）

本文档介绍编码代理在启动时如何发现并加载扩展模块。被扫描的原生/已配置目录会自动发现 `.ts` 和 `.js`；显式指定的文件以及已安装插件的清单条目也可以使用 `.mjs` 和 `.cjs`。

本文档**不**涵盖 [`gemini-extension.json` 清单扩展](./gemini-manifest-extensions.md)，相关内容单独记录。

## 本子系统做什么

扩展加载会构建一个模块入口文件列表，使用 Bun 导入每个模块，执行其工厂函数，并返回：

- 已加载的扩展定义
- 每个路径的加载错误（不会中止整个加载过程）
- 一个稍后由 `ExtensionRunner` 使用的共享扩展运行时对象

## 主要实现文件

- `src/extensibility/extensions/loader.ts` — 路径发现 + 导入/执行
- `src/extensibility/extensions/index.ts` — 公共导出
- `src/extensibility/extensions/runner.ts` — 加载之后的运行时/事件执行
- `src/discovery/builtin.ts` — 扩展模块的原生自动发现提供器
- `src/extensibility/plugins/legacy-pi-compat.ts` — 就地模块图加载与宿主包兼容性改写
- `src/config/settings.ts` — 加载合并后的 `extensions` / `disabledExtensions` 设置

---

## 扩展加载的输入

### 1) 自动发现的原生扩展模块

`discoverAndLoadExtensions()` 首先向发现提供器请求 `extension-module` 能力条目，然后只保留提供器为 `native` 的条目。

原生 `extension-module` 的发现来源：

- 项目目录：`<cwd>/.omp/extensions`
- 用户目录：当前 agent 目录的 `extensions/`（默认 `~/.omp/agent/extensions`）
- 原生遗留/settings JSON 条目：`<cwd>/.omp/settings.json#extensions` 以及当前 agent 目录的 `settings.json#extensions`

项目根是原生提供器的 `.omp` 目录（`SOURCE_PATHS.native.projectDir`），仅使用 cwd；它不会向上回溯祖先目录。用户根通过 `getAgentDir()` 取自当前 profile 的 agent 目录，因此在 `omp --profile <name>` 下它变为 `~/.omp/profiles/<name>/agent/extensions`（并遵循 `PI_CODING_AGENT_DIR`）。参见 [Profiles](./config-usage.md#profiles)。

注意：

- 原生自动发现目前基于 `.omp`。
- 在包清单（`pi.extensions`）和项目 override 查找中仍然接受遗留的 `.pi`，但 `.pi/extensions` 在这里不是原生根目录。

### 2) 发现的 JS/TS hook 工厂

在原生自动发现之后，`discoverAndLoadExtensions()` 还会从 `hook` 能力中追加 JS/TS hook 工厂——任何入口路径为 `.ts`/`.js` 文件的 hook——以便它们通过相同的模块管道加载。

hook 能力加载已经应用了它自己的 hook 专用禁用 id，因此这些路径不会被 `disabledExtensions` 中的扩展模块名称额外过滤。

### 3) 已安装插件的扩展条目

在 hook 发现之后，`discoverAndLoadExtensions()` 通过 `getAllPluginExtensionPaths(cwd)` 追加来自已启用的已安装插件的扩展入口点。

插件扩展条目来自包的 `omp.extensions` / `pi.extensions` 清单，包括已启用的 feature 条目。

已安装插件的清单解析接受显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。对于指向目录的清单条目，它会识别 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`；扩展目录的展开也使用这四个后缀。这比原生和已配置目录的自动扫描更广，后者仍然仅限于 `.ts` 和 `.js`。

### 4) 显式配置的路径

在插件扩展条目之后，配置的路径会被追加并解析。

主会话启动路径（`sdk.ts`）中已配置路径的来源：

1. CLI 提供的路径（`--extension/-e`，`--hook` 也被视作扩展路径）
2. 合并后的 settings `extensions` 数组

设置文件：

- 用户：当前 agent 目录的 `config.yml`（默认 `~/.omp/agent/config.yml`；在 `--profile <name>` 下为 `~/.omp/profiles/<name>/agent/config.yml`；`PI_CODING_AGENT_DIR` 可覆盖 agent 目录）
- 项目/原生设置能力：`<cwd>/.omp/config.yml` 和 `<cwd>/.omp/settings.json`

原生扩展模块发现还会从以下来源读取遗留 JSON 扩展列表：

- 当前 agent 目录的 `settings.json`（默认 `~/.omp/agent/settings.json`）
- `<cwd>/.omp/settings.json`

示例：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.omp/extensions/my-extra"]
}
```

---

## 启用/禁用控制

### 禁用发现

- CLI：`--no-extensions`
- SDK 选项：`disableExtensionDiscovery`

行为差异：

- SDK：当 `disableExtensionDiscovery=true` 时，环境扩展工厂被排除，而 `additionalExtensionPaths` 仍会正常解析（包括带有 `package.json#omp.extensions` 的包目录）。
- CLI：`--no-extensions` 遵循相同的“仅显式”契约。显式的 `-e/--extension` 和 `--hook` 路径仍会加载，且只有来自显式命名扩展包的兄弟能力根仍然合格。项目/用户的 `extensions:` 设置以及已安装的 OMP 扩展包在该兄弟表面中被排除。

该标志管理扩展工厂和 OMP 扩展包的兄弟根；它不是全进程能力隔离开关。其他发现子系统拥有的 Skills、MCP 服务器、工具、prompts 和 rules 仍保留各自的启用/禁用控制。

### 禁用特定的扩展模块

`disabledExtensions` 设置按扩展 id 格式进行过滤：

- `extension-module:<derivedName>`

`derivedName` 基于入口路径（`getExtensionNameFromPath`），例如：

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

示例：

```yaml
disabledExtensions:
  - extension-module:foo
```

### 禁用其他能力的特定条目

`disabledExtensions` 不仅限于扩展模块。每个定义了 `toExtensionId` 的能力都会向同一个列表贡献 id，加载过程会在条目到达 session 之前将其过滤掉。

Context 文件使用 `context-file:<level>:<basename>`，其中 `<level>` 为 `user` 或 `project`：

```yaml
disabledExtensions:
  - context-file:user:CLAUDE.md
```

id 不包含目录和深度，因此一个 `project` 条目会禁用发现遍历所到达的每一层中同名的文件。参见 [Context files](./context-files.md#disabling-a-single-context-file)。

---

## 路径与入口解析

### 路径规范化

对于已配置的路径：

1. 规范化 Unicode 空格和支持的路径简写（包括 `file://`、`@/absolute/path`，以及在绝对/相对路径之前多余的 `:`）
2. 展开 `~`
3. 如果是相对路径，基于当前 `cwd` 解析
4. 拒绝内部的 `local://` scheme；它必须由其协议处理器解析，不能被当作文件系统路径

### 如果已配置的路径是文件

直接将其用作模块入口候选。支持显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。

### 如果已配置的路径是目录

解析顺序：

1. 该目录中带 `omp.extensions`（或遗留的 `pi.extensions`）的 `package.json` -> 使用声明的条目
2. `index.ts`
3. `index.js`
4. 否则扫描一层以寻找扩展条目：
   - 直接的 `*.ts` / `*.js`
   - 子目录的 `index.ts` / `index.js`
   - 子目录中带 `omp.extensions` / `pi.extensions` 的 `package.json`

规则与约束：

- 不进行超过一层子目录的递归发现
- 声明的 `extensions` 清单条目相对于该包目录解析
- 只有文件存在/允许访问时，声明的条目才会被包含
- 在 `*/index.{ts,js}` 对中，TypeScript 优先于 JavaScript
- 符号链接被视为合格的文件/目录

### 不同来源的忽略行为不同

- 原生自动发现（discovery helpers 中的 `discoverExtensionModulePaths`）使用原生 glob，配置为 `gitignore: true` 和 `hidden: false`。
- `loader.ts` 中显式配置的目录扫描使用 `readdir` 规则，并且**不**应用 gitignore 过滤。

---

## 加载顺序与优先级

`discoverAndLoadExtensions()` 构建一个有序列表，然后调用 `loadExtensions()`。

顺序：

1. 原生自动发现的模块
2. 发现的 JS/TS hook 工厂
3. 已安装插件的扩展条目
4. 显式配置的路径（按提供顺序）

在 `sdk.ts` 中，配置的顺序为：

1. CLI 额外路径
2. settings `extensions`

去重：

- 基于绝对路径
- 首次出现的路径胜出
- 后续重复项被忽略

含义：如果同一模块路径既被自动发现又被显式配置，它将在第一个位置（自动发现阶段）加载一次。

---

## 模块导入与工厂契约

每个候选路径通过 `loadLegacyPiModule()`（`src/extensibility/plugins/legacy-pi-compat.ts`）加载：

- 入口的 realpath 被解析，然后使用 `?mtime` 缓存破坏器进行动态导入，以便编辑后的源码能够重新加载
- 作用域内的 Bun `onLoad` hook 会在求值前将遗留的 pi-package 说明符（`@mariozechner/*`、`@earendil-works/*`）和裸的 `@sinclair/typebox` 改写到宿主打包的副本
- 工厂由 `getExtensionFactory(module)` 选择：如果模块本身是函数则使用它，否则使用 `module.default`
- 工厂必须是函数（`ExtensionFactory`），可以返回 `void` 或 promise；加载会 await 它，然后再继续下一个路径

如果导出不是函数，该路径会以结构化错误失败，加载会继续。

---

## 失败处理与隔离

### 加载过程中

对于每个扩展路径，失败会被捕获为 `{ path, error }`，不会阻止其他路径的加载。

常见情况：

- 导入失败 / 文件缺失
- 无效的工厂导出（非函数）
- 执行工厂时抛出异常

### 运行时隔离模型

- 扩展**不被沙箱化**（同一进程/运行时）。
- 它们共享一个 `EventBus` 和一个 `ExtensionRuntime` 实例。
- 在加载过程中，运行时 action 方法会故意抛出 `ExtensionRuntimeNotInitializedError`；action 接线稍后在 `ExtensionRunner.initialize()` 中完成。

### 加载之后

当事件通过 `ExtensionRunner` 运行时，处理函数的异常会被捕获并作为扩展错误发出，而不是让 runner 循环崩溃。

---

## 最小化的用户/项目布局示例

### 用户级

```text
~/.omp/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

### 项目级

```text
<repo>/
  .omp/
    settings.json
    extensions/
      checks/
        package.json
      lint-gates.ts
```

`checks/package.json`：

```json
{
  "omp": {
    "extensions": ["./src/check-a.ts", "./src/check-b.js"]
  }
}
```

仍然接受遗留的清单 key：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
