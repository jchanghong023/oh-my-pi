# 扩展加载（TypeScript/JavaScript 模块）

本文档介绍编码 agent 在启动时如何发现并加载扩展模块。被扫描的原生/已配置目录会自动发现 `.ts` 和 `.js`；显式指定的文件以及已安装插件的清单条目还可以使用 `.mjs` 和 `.cjs`。

本文档**不**涵盖 [`gemini-extension.json` 清单扩展](./gemini-manifest-extensions.md)，相关内容单独记录。

## 本子系统做什么

扩展加载会构建一个模块入口文件列表，使用 Bun 导入每个模块，执行其工厂函数，并返回：

- 已加载的扩展定义
- 每个路径的加载错误（不会中止整个加载过程）
- 一个稍后由 `ExtensionRunner` 使用的共享扩展运行时对象

## 主要实现文件

- `src/extensibility/extensions/loader.ts` — 路径发现 + 导入/执行
- `src/extensibility/extensions/directory-resolution.ts` — 共享的已配置/插件清单与目录优先级
- `src/extensibility/extensions/index.ts` — 公共导出
- `src/extensibility/extensions/runner.ts` — 加载之后的运行时/事件执行
- `src/discovery/builtin.ts` — 扩展模块的原生自动发现 provider
- `src/extensibility/plugins/legacy-pi-compat.ts` — 就地模块图加载与宿主包兼容性改写
- `src/config/settings.ts` — 加载合并后的 `extensions` / `disabledExtensions` 设置

---

## 扩展加载的输入

### 1) 自动发现的原生扩展模块

`discoverAndLoadExtensions()` 首先向发现 provider 请求 `extension-module` 能力条目，然后只保留 provider 的 `native` 条目。

原生 `extension-module` 的发现来源：

- 项目目录：`<cwd>/.omp/extensions`
- 用户目录：当前 agent 目录的 `extensions/`（默认 `~/.omp/agent/extensions`）
- 原生遗留/settings JSON 条目：`<cwd>/.omp/settings.json#extensions` 以及当前 agent 目录的 `settings.json#extensions`

项目根是原生 provider 的 `.omp` 目录（`SOURCE_PATHS.native.projectDir`），仅使用 cwd；它不会向上回溯祖先目录。用户根通过 `getAgentDir()` 取自当前 profile 的 agent 目录，因此在 `omp --profile <name>` 下它变为 `~/.omp/profiles/<name>/agent/extensions`（并遵循 `PI_CODING_AGENT_DIR`）。参见 [Profiles](./config-usage.md#profiles)。

注意：

- 原生自动发现目前基于 `.omp`。
- 在包清单（`pi.extensions`）和项目 override 查找中仍然接受遗留的 `.pi`，但 `.pi/extensions` 在这里不是原生根目录。

### 2) 发现的 JS/TS hook 工厂

在原生自动发现之后，`discoverAndLoadExtensions()` 还会从 `hook` 能力中追加 JS/TS hook 工厂——任何入口路径为 `.ts`/`.js` 文件的 hook——使它们通过相同的模块管道加载。原生 provider 只会在 `<cwd>/.omp/hooks/pre|post/` 和 `<agentDir>/hooks/pre|post/` 下发现这些 hook；所需的 `pre/`/`post/` 目录布局参见 [Hooks：原生发现位置](./hooks.md#native-discovery-location)。

hook 能力加载已经应用了它自己的 hook 专用禁用 id，因此这些路径不会被 `disabledExtensions` 中的扩展模块名称额外过滤。

### 3) 已安装插件的扩展条目

在 hook 发现之后，`discoverAndLoadExtensions()` 通过 `getAllPluginExtensionPaths(cwd)` 追加来自已启用的已安装插件的扩展入口点。

插件扩展条目来自包的 `omp.extensions` / `pi.extensions` 清单，包括已启用的 feature 条目。

已安装插件的清单解析接受显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。对于指向目录的清单条目，它会识别 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`；扩展目录的展开也使用这四个后缀。这比原生和已配置目录的自动扫描更广，后者仍然仅限于 `.ts` 和 `.js`。

### 4) 显式配置的路径

在插件扩展条目之后，已配置的路径会被追加并解析。

主会话启动路径（`sdk.ts`）中已配置路径的来源：

1. CLI 提供的路径（`--extension/-e`，且 `--hook` 也被视作扩展路径）
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
- CLI：`--no-extensions` 遵循相同的“仅显式”契约。显式的 `-e/--extension` 和 `--hook` 路径仍会加载，且只有来自显式命名扩展包的兄弟能力根仍有资格加载。项目/用户的 `extensions:` 设置以及已安装的 OMP 扩展包会被排除在这一兄弟范围之外。

该标志管控扩展工厂和 OMP 扩展包的兄弟根；它不是全进程的能力隔离开关。由其他发现子系统拥有的 skill、MCP 服务器、工具、提示词和规则仍保留各自的启用/禁用控制。

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

`disabledExtensions` 并不限于扩展模块。每个定义了 `toExtensionId` 的能力都会向同一个列表贡献 id，加载过程会在条目到达会话之前将其过滤掉。

上下文文件使用 `context-file:<level>:<basename>`，其中 `<level>` 为 `user` 或 `project`：

```yaml
disabledExtensions:
  - context-file:user:CLAUDE.md
```

该 id 不携带目录与深度信息，因此一个 `project` 条目会禁用发现遍历所到达的每一层中同名的文件。参见 [上下文文件](./context-files.md#disabling-a-single-context-file)。

---

## 路径与入口解析

### 路径规范化

对于已配置的路径：

1. 规范化 Unicode 空格和支持的路径简写（包括 `file://`、`@/absolute/path`，以及绝对/相对路径之前多余的 `:`）
2. 展开 `~`
3. 如果是相对路径，基于当前 `cwd` 解析
4. 拒绝内部的 `local://` scheme；它必须由其协议处理器解析，不能被当作文件系统路径

### 如果已配置的路径是文件

直接将其用作模块入口候选。支持显式的 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。

### 如果已配置的路径是目录

解析顺序：

1. 该目录中带有非空 `omp.extensions`（或遗留的 `pi.extensions`）数组的 `package.json` -> 使用声明的条目
2. `index.ts`
3. `index.js`
4. 否则扫描一层以寻找扩展条目：
   - 直接的 `*.ts` / `*.js`
   - 子目录的 `index.ts` / `index.js`
   - 子目录中带有 `omp.extensions` / `pi.extensions` 的 `package.json`

规则与约束：

- 不进行超过一层子目录的递归发现
- 声明的 `extensions` 清单条目相对于该包目录解析
- 非空的声明数组是权威的：即使每一条声明条目都缺失，基于约定的 index/扫描回退也保持被抑制
- 缺失或不可访问的声明条目会被单独跳过，因此部分缺失的清单中仍然存在的条目依旧会加载
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

含义：如果同一个模块路径既被自动发现又被显式配置，它会在第一个位置（自动发现阶段）加载一次。

---

## 模块导入与工厂契约

每个候选路径通过 `loadLegacyPiModule()`（`src/extensibility/plugins/legacy-pi-compat.ts`）加载：

- 会解析入口的 realpath，然后使用 `?mtime` 缓存破坏器动态导入，使编辑过的源码得以重新加载。自 16.3.7 起，同一个 mtime 标记会通过作用于整个依赖图的 `onLoad` 改写，传播到扩展自有依赖图中的每个模块——相对 `./`/`../` 导入、包 `imports` 别名（`#alias/*`）以及扩展本地的裸依赖——因此同进程内的重新导入能获取整个图范围内的修改，而不只是入口文件。由宿主解析的改写（遗留 pi-package 说明符、TypeBox shim）保持为不带标记的 `file://` URL，因为它们指向进程内的宿主代码，而这些代码在多次重载之间从不变化
- 限定作用域的 Bun `onLoad` hook 会在求值之前，把遗留 pi-package 说明符（`@mariozechner/*`、`@earendil-works/*`）和裸的 `@sinclair/typebox` 改写到宿主打包的副本上。遗留 Pi 包根导入通过兼容 shim 解析：已迁移到 `@oh-my-pi/pi-catalog/models` 的 catalog 符号（`calculateCost`、`modelsAreEqual`、`getBundledProviders`，以及 `getModel`/`getModels` 别名）由遗留 pi-ai shim（`src/extensibility/legacy-pi-ai-shim.ts`）重新导出，而遗留的 `@oh-my-pi/pi-coding-agent` 导入——包括 `DefaultResourceLoader`——会解析到 `src/extensibility/legacy-pi-coding-agent-shim.ts` 中的兼容加载器
- 依赖图自有的 CommonJS 模块使用同步的 Bun `onLoad` 对象模块，暴露运行时的自有字符串导出键，包括计算属性名与不可枚举属性名；`default` 仍保留完整的 `module.exports` 值。共享求值器会保留循环依赖以及 `require`/导入的同一性，而被 require 的宿主 ESM shim 会在同步求值之前准备好。无需生成 facade 文件，也无需基于 AST 的具名导出重建
- 打包的宿主模块使用 Bun 的原生对象加载器。导出 `theme` 的模块会添加一个轻量的 ESM 绑定桥接，使现有的 `theme` 导入同步跟随宿主的赋值，而无需替换 UI 的变更监听器
- 包的 `imports` 与 `exports` 模式优先选择 `*` 之前最长的前缀，其次是最长的完整模式；精确匹配优先，被排除的目标绝不会回退到更宽泛的模式
- 工厂由 `getExtensionFactory(module)` 选择：如果模块本身是函数则使用模块本身，否则使用 `module.default`
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

### 受限子进程与复活

受限的 task/eval 子进程会把父进程已导入的扩展工厂重新绑定到自己的会话上。在没有环境扩展发现的情况下，hook 与 provider 仍然可用。扩展工具不能扩大受限工具集，也不能替换内置工具，包括通过延迟注册的方式。新的扩展路径、已加载的父进程绑定实例以及额外的内联工厂仍然被排除。

被复活的子进程继承当前所属会话的扩展根与已准备好的工厂，而不是来自已保存 transcript 的扩展授权。在没有已准备好工厂的情况下进行冷发现时，会遵循所有者的仅显式或合并后的根。

扩展工厂在重新绑定时仍会执行宿主代码；工具限制并不是扩展沙箱。现有的按模块加载失败处理保持不变。

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
