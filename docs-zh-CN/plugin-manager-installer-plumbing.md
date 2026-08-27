# 插件管理器与安装器内部机制

本文档说明 `omp plugin` 的 npm/git/link 与 marketplace 操作如何修改磁盘上的插件状态,并使其成为运行时能力。Marketplace 安装各自维护其注册表和缓存,然后通过 npm/git/link 安装所使用的相同 `node_modules` 和 `omp-plugins.lock.json` 运行时接口来注册缓存中的插件;参见 `docs/marketplace.md`。

## 范围与架构

代码库中存在两套插件管理实现:

1. **CLI 命令使用的当前路径**:`PluginManager`(`src/extensibility/plugins/manager.ts`)
2. **遗留辅助模块**:安装器函数(`src/extensibility/plugins/installer.ts`)

`omp plugin` 的 npm/git/link 操作走 `PluginManager`;marketplace 操作走 `MarketplaceManager`。`install` 会对每个目标进行分类(`cli/classify-install-target.ts` 中的 `classifyInstallTarget`):`name@marketplace` 路由到 marketplace manager,本地路径路由到 `PluginManager.link()`,git 与 npm 规格(spec)路由到 `PluginManager.install()`。

`installer.ts` 仍然记录着重要的安全检查与文件系统行为,但它并不是 `src/commands/plugin.ts` + `src/cli/plugin-cli.ts` 实际使用的路径。

## 生命周期:从 CLI 调用到运行时可用

```text
omp plugin <npm/link action> ...
  -> src/commands/plugin.ts
  -> runPluginCommand(...) in src/cli/plugin-cli.ts
  -> PluginManager method (install/list/uninstall/link/...)
  -> mutate user plugins data root {package.json,node_modules,omp-plugins.lock.json}
  -> enabled-plugin enumeration discovers user and nearest project plugin roots
  -> direct loaders resolve manifest-declared tool/extension entries
  -> `omp-plugins` capability discovery scans conventional skills/hooks/tools/commands/rules/prompts/MCP content; task discovery scans `agents/`

omp plugin install name@marketplace / omp install name@marketplace
  -> MarketplaceManager
  -> mutate scope registry and shared cache
  -> symlink the cached package into the scope's node_modules and update omp-plugins.lock.json
  -> `claude-plugins` discovery loads marketplace skills/commands/hooks/tools/MCP; task discovery loads `agents/`; extension loader imports `package.json#omp.extensions`
```

### 命令入口点

- `src/commands/plugin.ts` 定义命令/标志并转发到 `runPluginCommand`。
- `src/cli/plugin-cli.ts` 将 npm/link 子命令映射到 `PluginManager` 方法:
  - `install`、`uninstall`、`list`、`link`、`doctor`、`features`、`config`、`enable`、`disable`
- `discover`、`upgrade` 和 `marketplace ...` 子命令使用 `MarketplaceManager`。
- 不存在显式的 npm 插件 `update` 操作;更新通过以新的包/版本规格重新运行 `install` 来完成。

## 磁盘上的模型

用户插件状态位于插件数据根目录下(默认为 `~/.omp/plugins`)。在 Linux 和 macOS 上,`omp config init-xdg` 会创建 XDG data、state 和 cache 根目录,但不会移动既有数据;在相关根目录存在且 XDG 变量已设置后,新的用户插件状态将解析到 `$XDG_DATA_HOME/omp/plugins` 下:

- `package.json` —— 由 `bun install`/`bun uninstall` 用于 npm 安装插件的依赖清单
- `node_modules/` —— 已安装的 npm 包,以及 link 与 marketplace 缓存的符号链接
- `omp-plugins.lock.json` —— npm/link/marketplace 插件的运行时状态:
  - 每个插件的启用/禁用
  - 每个插件所选的功能集
  - 持久化的插件设置

当在工作目录或上层存在项目锚点(`.omp/` 或 `.git/`)时,项目级运行时插件位于 `<anchor>/.omp/plugins/{node_modules,omp-plugins.lock.json}`。Marketplace 的项目级安装会填充此根目录;已启用的项目包会按相同包名覆盖用户包。

项目级覆盖通过项目配置目录以 `plugin-overrides.json` 进行搜索(通常为 `<project>/.omp/plugin-overrides.json`)。从管理器/加载器视角来看,覆盖是只读的,可以禁用插件或覆盖功能/设置。

Marketplace 安装除了运行时条目外,还会在其旁边添加注册表与缓存状态:

- 用户数据根目录 `marketplaces.json`(默认为 `~/.omp/marketplaces.json`)—— 已配置的 marketplace 目录
- 用户插件数据根目录 `installed_plugins.json`(默认为 `~/.omp/plugins/installed_plugins.json`)—— 用户作用域的 marketplace 安装
- `<anchor>/.omp/plugins/installed_plugins.json` —— 项目作用域的 marketplace 安装
- 用户插件数据根目录 `cache/{marketplaces,plugins}/` —— 缓存的目录与插件目录
- `<scope>/plugins/node_modules/<package>` —— 指向已缓存插件的符号链接,以便其 `package.json` 中的 `omp.extensions` 与工具能够加载
- `<scope>/plugins/omp-plugins.lock.json` —— 与运行时插件加载器共享的启用与功能状态

## 插件规格解析与元数据解释

## 安装规格语法

`parsePluginSpec`(`parser.ts`)支持:

- `pkg` -> `features: null`(默认行为)
- `pkg[*]` -> 启用清单中所有功能
- `pkg[]` -> 不启用任何可选功能
- `pkg[a,b]` -> 启用指定名称的功能
- `@scope/pkg@1.2.3[feat]` -> 带作用域与版本号的包,并显式选择功能

`PluginManager.install` 还接受 git 源(由 `validateGitSpec` 校验,而不是 npm 正则):命名空间简写 `github:user/repo[#ref]`、`gitlab:`、`bitbucket:`、`codeberg:`、`sourcehut:`/`srht:`,以及完整的 git URL(`https://github.com/user/repo`、`git@github.com:user/repo`、`ssh://…`、`git+https://…`)。git 规格不编码包名,因此安装流程会在 `bun install` 前后对 `plugins/package.json#dependencies` 做 diff 来解析包名。

`extractPackageName` 在安装后剥离版本后缀,以便进行磁盘路径查找。

## 清单来源与必填字段

清单按以下顺序解析:

1. `package.json.omp`
2. 回退到 `package.json.pi`
3. 回退到 `{ version: package.version }`

影响如下:

- 在管理器/加载器中不存在严格的模式校验。
- 缺少 `omp`/`pi` 的包仍可安装并列出。
- 运行时插件加载(`getEnabledPlugins`)会跳过没有 `omp`/`pi` 清单的包。
- `manifest.version` 总是会被包 `version` 覆盖。

格式错误的 `package.json` JSON 在读取时即为硬性错误;清单格式错误只有在具体字段被使用时才可能在之后失败。

## 安装/更新流程(`PluginManager.install`)

1. 从安装规格中解析功能方括号语法。
2. 校验规格:git 规格通过 `validateGitSpec`;npm 规格对照包名校验正则 + shell 元字符黑名单。
3. 确保插件 `package.json` 存在(`omp-plugins`、私有依赖映射)。
4. 在 `~/.omp/plugins` 中运行 `bun install <packageSpec>`。
5. 解析已安装的包名(npm:通过 `extractPackageName` 剥离版本;git:对 `dependencies` 做前后 diff)并读取 `node_modules/<name>/package.json`。
6. 解析清单并计算 `enabledFeatures`:
   - `[*]`:所有已声明的功能(若不存在功能映射则为 `null`)
   - `[a,b]`:校验每个功能是否存在于清单功能映射中
   - `[]`:空的功能列表
   - 裸规格:`null`(稍后由加载器使用默认策略)
7. 校验已声明的扩展条目(`#validateInstalledExtensions`):清单中的每个 `extensions` 条目必须在磁盘上可解析、能够 import 为工厂函数,并能在一次性注册表面上成功初始化。失败时回滚安装——恢复先前的 `plugins/package.json`、删除刚安装的包,并恢复 `bun install` 之前备份中的旧版本——然后中止。
8. 写入或更新锁文件中的运行时状态:`{ version, enabledFeatures, enabled: true }`。

### 更新语义

由于更新是 install 驱动的:

- `omp plugin install pkg@newVersion` 会更新依赖与锁文件中的版本。
- 既有设置保留在独立的设置映射中;插件状态条目将被替换为新版本/功能与启用状态。
- 安装过程会先对先前的包目录、`package.json` 与 `bun.lock` 做快照。安装后任何失败(包括功能校验、扩展校验、运行时配置保存)都会尝试恢复这三项。
- 不存在独立的 npm 插件“检查更新”或迁移操作。

## 移除流程(`PluginManager.uninstall`)

1. 校验包名。
2. 在插件目录中运行 `bun uninstall <name>`。
3. 从锁文件中移除插件运行时状态:
   - `config.plugins[name]`
   - `config.settings[name]`

如果 uninstall 命令失败,运行时状态不会被修改。

## 列出流程(`PluginManager.list`)

1. 读取依赖映射与锁文件运行时条目;它们的并集包含 npm 安装以及仅 link 的插件。
2. 加载项目覆盖。
3. 从 `node_modules` 解析每个包;跳过 marketplace 运行时的符号链接,因为 marketplace 的摘要会单独列出。
4. 构建 `InstalledPlugin` 记录并合并有效状态:
   - 基础来自锁文件(或默认值)
   - 项目覆盖可以替换功能选择
   - 项目的 `disabled` 列表会将插件屏蔽为禁用

`omp plugin list` 将此结果与 `MarketplaceManager.listInstalledPlugins()` 合并。

`PluginManager.getPlugin()` 直接解析单个运行时包,包括被有意从 `list()` 中省略的 marketplace 符号链接。配置类命令使用此路径,以便 marketplace 设置仍可被寻址,而无需在 list 与 status 输出中重复 marketplace 条目。

## link 流程(`PluginManager.link`)

`link` 通过将本地包符号链接到 `~/.omp/plugins/node_modules/<pkg.name>` 来支持本地插件开发。

行为:

1. 将 `localPath` 相对于管理器的 cwd 进行解析。
2. 要求存在本地 `package.json` 与 `name` 字段。
3. 确保插件目录存在。
4. 对于作用域包名,创建作用域目录。
5. 移除目标链接位置的既有路径。
6. 创建符号链接。
7. 添加启用了默认功能(`null`)的运行时锁文件条目。

注意:当前的 `PluginManager.link` 不会强制执行遗留 `installer.ts` 中存在的 `cwd` 路径边界检查(`normalizedPath.startsWith(normalizedCwd)`),因此信任是调用方的责任。

## 运行时加载:从已安装插件到可调用的能力

## 发现门控

`getEnabledPlugins(cwd)`(`plugins/loader.ts`)读取:

- 插件依赖清单(`package.json`),与锁文件插件条目取并集,以便仅通过 `plugin link` 而没有依赖条目的插件仍能被发现
- 锁文件运行时状态
- 通过 `getConfigDirPaths("plugin-overrides.json", { user: false, cwd })` 获取项目覆盖

过滤:

- 若无插件 package.json 则跳过
- 若清单(`omp`/`pi`)缺失则跳过
- 若在锁文件中被全局禁用则跳过
- 若被项目禁用则跳过

## 能力路径解析

对每个已启用插件:

- `resolvePluginExtensionPaths(plugin)`
- `resolvePluginToolPaths(plugin)`
- `resolvePluginHookPaths(plugin)`
- `resolvePluginCommandPaths(plugin)`

每个解析器都包含基础条目与功能条目:

- 基础条目始终包含
- 显式功能列表 -> 仅所选功能
- `enabledFeatures === null` -> 启用标记为 `default: true` 的功能

清单条目可以指向一个文件,也可以指向包含 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs` 的目录。缺失的文件会被静默跳过(`statSync`/`existsSync` 守卫)。

## 当前运行时连接

- 清单声明的 **tools**(工具)通过 `getAllPluginToolPaths(cwd)` 接入 `discoverAndLoadCustomTools`。
- 清单声明的 **extensions**(扩展)通过 `getAllPluginExtensionPaths(cwd)` 接入 `discoverAndLoadExtensions`。
- `omp-plugins` 能力提供器分别在已启用的 npm/link 插件根目录下扫描常规的 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 与 `.mcp.json`。任务代理发现扫描这些根目录下的 `agents/`。Marketplace 根目录在此处被排除,改由 `claude-plugins` 加 marketplace 任务代理发现处理。
- 清单的 hook/command 路径解析器仍被导出,但运行时 hook/slash 发现使用的是常规能力提供器扫描,而不是 `getAllPluginHookPaths()` 或 `getAllPluginCommandPaths()`。
- 直接的自定义工具与扩展路径列表会按已解析的绝对路径去重(`seen`,先到先得)。

## 锁文件/状态管理细节

`PluginManager` 在每个实例的内存中缓存运行时配置(`#runtimeConfig`),并按需懒加载一次。

管理器加载行为:

- 锁文件缺失 -> `{ plugins: {}, settings: {} }`
- 锁文件读取/解析失败 -> 警告 + 同样的空默认值

已启用插件发现会独立加载每个用户/项目根目录:缺失的锁文件视为空;非 ENOENT 的读取/解析失败会向上抛出。

保存行为:

- 每次变更都以美化格式写入完整锁文件 JSON

不存在跨进程锁或合并策略;并发写入可能互相覆盖。

## 安全检查与信任边界

## 输入/包校验

当前管理器路径强制执行包名校验:

- npm 规格:包名校验正则(`VALID_PACKAGE_NAME`),用于带或不带作用域的规格,可选择带版本。
- npm shell 元字符黑名单:`;`、`&`、`|`、反引号、`$`、`(`、`)`、`{`、`}`、`[`、`]`、`<`、`>`、`\`——在 `parsePluginSpec` 剥离功能方括号之后应用,因此普通的 `pkg[feat]` 规格永远不会到达该黑名单。
- git 规格:`validateGitSpec` 仅拒绝共享的 `SHELL_METACHARS` 集合(`;`、`&`、`|`、反引号、`$`、`(`、`)`、`{`、`}`、`<`、`>`、`\`、换行、回车、制表符),而不是 npm 正则,因此允许 `:`、`/`、`#`、`+`、`.`、`-`、`_`、`~`、`@`。

这降低了在调用 `bun install/uninstall` 时的命令注入风险。

## 文件系统信任边界

- 当自定义工具模块被 import 时,插件代码以进程内方式执行;无沙箱。
- 清单中的相对路径会与插件包目录拼接,仅做存在性检查。
- 一旦安装,插件包本身即为受信任的代码。

## 仅遗留安装器的检查

`installer.ts` 包含一些未在 `PluginManager.link` 中体现的额外 link 时检查:

- 本地路径必须解析到项目 cwd 之内
- 针对符号链接目标命名的额外包名/路径穿越防护

由于 CLI 使用的是 `PluginManager`,这些更严格的 link 防护目前不在主路径上。

## 失败、部分成功与回滚行为

插件管理器不是事务性的。

| 操作阶段 | 失败行为 | 回滚 |
| -------- | -------- | ---- |
| `bun install` 或后续的 git `bun update` 失败 | 安装中止并输出 stderr | 恢复先前的 `package.json`、`bun.lock` 与包快照 |
| 功能或扩展校验失败 | 命令失败 | 同样的安装回滚 |
| 运行时锁文件写入失败 | 命令失败 | 同样的安装回滚;回滚失败会被附加到报告的错误中 |
| `bun uninstall` 成功但锁文件写入失败 | 命令失败 | 包已移除,可能残留过时的运行时状态 |
| `link` 移除旧目标后符号链接创建失败 | 命令失败 | 不恢复先前的 link/目录 |

在运维上,`doctor --fix` 可以修复部分偏差(`bun install`、孤立配置清理、无效功能清理),但它是尽力而为。

## 清单格式错误/缺失行为总结

- 缺少 `omp`/`pi` 字段:
  - install/list:可容忍(最小清单)
  - 运行时已启用插件发现:作为非插件跳过
- 安装规格或 `features --set/--enable` 引用的功能缺失:硬性错误,并附带可用功能列表
- 无效的 `plugin-overrides.json`:在管理器与加载器路径中均被忽略,回退到 `{}`
- 清单引用的 tool/hook/command 文件路径缺失:在解析器展开期间静默忽略;仅由 `doctor` 标记为错误

## 模式差异与优先级

- `--dry-run`(install):返回一个合成的安装结果,不会执行 `bun install`、不联网、且不写入锁文件/运行时状态(但仍会确保插件 `package.json` 骨架存在)。
- `--json`:仅影响输出格式,不改变行为。
- 项目覆盖始终优先于锁文件中的全局项,用于功能/设置视图。
- 有效启用状态为 `runtimeEnabled && !projectDisabled`。

## 实现文件

- [`src/commands/plugin.ts`](../packages/coding-agent/src/commands/plugin.ts) —— CLI 命令声明与标志映射
- [`src/cli/plugin-cli.ts`](../packages/coding-agent/src/cli/plugin-cli.ts) —— 操作分派,面向用户的命令处理
- [`src/extensibility/plugins/manager.ts`](../packages/coding-agent/src/extensibility/plugins/manager.ts) —— 当前 install/remove/list/link/state/doctor 实现
- [`src/extensibility/plugins/installer.ts`](../packages/coding-agent/src/extensibility/plugins/installer.ts) —— 遗留安装器辅助函数与额外的 link 安全检查
- [`src/extensibility/plugins/loader.ts`](../packages/coding-agent/src/extensibility/plugins/loader.ts) —— 已启用插件发现与清单 tool/hook/command/extension 路径解析
- [`src/extensibility/plugins/parser.ts`](../packages/coding-agent/src/extensibility/plugins/parser.ts) —— 安装规格与包名解析辅助函数
- [`src/extensibility/plugins/types.ts`](../packages/coding-agent/src/extensibility/plugins/types.ts) —— 清单/运行时/覆盖类型契约
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts) —— 针对 npm/link 扩展包的常规能力发现
- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts) —— 针对扩展与 marketplace 插件根目录的常规 `agents/` 发现
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts) —— marketplace 插件的能力发现
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts) —— 清单声明的插件工具模块的运行时连接
- [`src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) —— 插件扩展模块的运行时连接