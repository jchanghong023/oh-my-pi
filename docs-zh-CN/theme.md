# 主题参考

本文描述了 coding-agent 当前的主题机制：模式、加载、运行时行为以及失败模式。

## 主题系统控制的内容

主题系统驱动：

- 整个 TUI 中使用的前景色/背景色令牌
- Markdown 样式适配器（`getMarkdownTheme()`）
- 选择器/编辑器/设置列表适配器（`getSelectListTheme()`、`getEditorTheme()`、`getSettingsListTheme()`）
- 符号预设与符号覆盖（`unicode`、`nerd`、`ascii`）
- 由原生高亮器使用的语法高亮颜色（`@oh-my-pi/pi-natives`）
- 状态栏分段颜色

主要实现位于：`src/modes/theme/theme.ts`。

## Theme JSON 结构

主题文件是 JSON 对象，依据 `theme.ts`（`themeJsonSchema`）中的运行时模式进行校验，并由 `src/modes/theme/theme-schema.json` 镜像描述。

顶层字段：

- `name`（必填）
- `colors`（必填；所有颜色令牌均为必填）
- `vars`（可选；可复用的颜色变量）
- `export`（可选；HTML 导出颜色）
- `symbols`（可选）
  - `preset`（可选：`unicode | nerd | ascii`）
  - `overrides`（可选：针对 `SymbolKey` 的键/值覆盖）

颜色值接受：

- 十六进制字符串（`"#RRGGBB"`）
- 256 色索引（`0..255`）
- 变量引用字符串（通过 `vars` 解析）
- 空字符串（`""`）表示使用终端默认色（前景 `\x1b[39m`，背景 `\x1b[49m`）

## 必填与可选的颜色令牌

下列所有令牌在 `colors` 中均为必填，`thinkingMax` 除外——它为兼容性考虑是可选的，并回退到 `thinkingXhigh`。

### 核心文本与边框（11）

`accent`、`border`、`borderAccent`、`borderMuted`、`success`、`error`、`warning`、`muted`、`dim`、`text`、`thinkingText`

### 背景块（7）

`selectedBg`、`userMessageBg`、`customMessageBg`、`toolPendingBg`、`toolSuccessBg`、`toolErrorBg`、`statusLineBg`

### 消息/工具文本（5）

`userMessageText`、`customMessageText`、`customMessageLabel`、`toolTitle`、`toolOutput`

### Markdown（10）

`mdHeading`、`mdLink`、`mdLinkUrl`、`mdCode`、`mdCodeBlock`、`mdCodeBlockBorder`、`mdQuote`、`mdQuoteBorder`、`mdHr`、`mdListBullet`

### 工具 diff 与语法高亮（12）

`toolDiffAdded`、`toolDiffRemoved`、`toolDiffContext`、
`syntaxComment`、`syntaxKeyword`、`syntaxFunction`、`syntaxVariable`、`syntaxString`、`syntaxNumber`、`syntaxType`、`syntaxOperator`、`syntaxPunctuation`

### 模式/思考边框（8 必填，1 可选）

`thinkingOff`、`thinkingMinimal`、`thinkingLow`、`thinkingMedium`、`thinkingHigh`、`thinkingXhigh`、可选 `thinkingMax`、`bashMode`、`pythonMode`

### 状态栏分段颜色（13）

`statusLineSep`、`statusLineModel`、`statusLinePath`、`statusLineGitClean`、`statusLineGitDirty`、`statusLineContext`、`statusLineSpend`、`statusLineStaged`、`statusLineDirty`、`statusLineUntracked`、`statusLineOutput`、`statusLineCost`、`statusLineSubagents`

## 可选令牌

### `export` 段（可选）

用于 HTML 导出主题辅助：

- `export.pageBg`
- `export.cardBg`
- `export.infoBg`

若省略，导出代码会从已解析的主题颜色推导默认值。

### `symbols` 段（可选）

- `symbols.preset` 设置主题级默认符号集合。
- `symbols.overrides` 可覆盖单个 `SymbolKey` 的值。
- `symbols.spinnerFrames` 覆盖加载旋转动画的帧。可接受扁平 `string[]`（应用于两种旋转类型）或对象 `{ "status"?: string[], "activity"?: string[] }` 以分别覆盖各类型。未指定的类型回退到符号预设的默认帧。`status` 驱动约 12.5fps 的旋转器，用于加载器与工具执行指示器；`activity` 驱动约 30fps 的旋转器，用于 markdown 进度条及类似的高频 UI。

运行时优先级：

1. 设置中的 `symbolPreset` 覆盖（如果已设置）
2. 主题 JSON 中的 `symbols.preset`
3. 回退 `"unicode"`

无效的覆盖键会被忽略并记录（`logger.debug`）。

#### 盒线绘制边框

所有带轮廓的 UI 装饰——工具结果框、浮层、代码围栏、编辑器、欢迎横幅——都使用 `boxRound.*` 令牌绘制：圆角（`╭╮╰╯`）加上 T 形/十字接头（`├┤┬┴┼`，它们没有对应的圆角 Unicode 形式，因此取自 `boxSharp.*` 令牌）。Markdown 表格是唯一的例外，依旧使用完整的直角 `boxSharp.*` 集（`┌┐└┘`）。

覆盖行为依据上述划分：

- `boxRound.{topLeft,topRight,bottomLeft,bottomRight,horizontal,vertical}` 重新定义每条边框的角与边。
- `boxSharp.{cross,teeDown,teeUp,teeRight,teeLeft}` 重新定义所有位置的分割线/接头（圆角框与表格皆然）。
- `boxSharp.{topLeft,topRight,bottomLeft,bottomRight}` 现在只影响 markdown 表格的角。

## 内置与自定义主题来源

主题查找顺序（`loadThemeJson`）：

1. 内置嵌入主题（`dark.json`、`light.json` 以及所有编译进 `defaultThemes` 的 `defaults/*.json`）
2. 自定义主题文件：`<customThemesDir>/<name>.json`

自定义主题目录来自 `getCustomThemesDir()`：

- 默认：`~/.omp/agent/themes`
- 由 `PI_CODING_AGENT_DIR` 覆盖（`$PI_CODING_AGENT_DIR/themes`）

`getAvailableThemes()` 返回合并后的内置与自定义主题名称（已排序），在名称冲突时内置主题优先。

## 加载、校验与解析

对于自定义主题文件：

1. 读取 JSON
2. 解析 JSON
3. 根据 `themeJsonSchema` 进行校验
4. 递归解析 `vars` 引用
5. 根据终端能力模式将解析后的值转换为 ANSI

校验行为：

- 缺少必填颜色令牌：显式分组错误信息
- 令牌类型/值错误：附带 JSON 路径的校验错误
- 未知主题文件：`Theme not found: <name>`

变量引用行为：

- 支持嵌套引用
- 遇到缺失的变量引用会抛出
- 遇到循环引用会抛出

## 终端颜色模式行为

颜色模式检测（`detectColorMode`）：

- `COLORTERM=truecolor|24bit` => truecolor
- `WT_SESSION` => truecolor
- `TERM` 为 `dumb`、`linux` 或空 => 256color
- 其他情况 => truecolor

转换行为：

- 十六进制 -> `Bun.color(..., "ansi-16m" | "ansi-256")`
- 数值 -> `38;5` / `48;5` ANSI
- `""` -> 默认前景/背景重置

## 运行时切换行为

### 初始主题（`initTheme`）

`main.ts` 使用以下设置初始化主题：

- `symbolPreset`
- `colorBlindMode`
- `theme.dark`
- `theme.light`

自动主题槽位选择按以下顺序依据终端外观：

1. 终端报告的 OSC 11 背景亮度，除非 macOS/Zellij 回退路径处于激活状态
2. `COLORFGBG` 背景索引（`< 8` => dark，`>= 8` => light）
3. 仅针对已知失效的 macOS/Zellij OSC 11 路径启用 macOS 外观回退
4. 回退到 dark 槽位

设置模式中的当前默认值：

- `theme.dark = "titanium"`
- `theme.light = "light"`
- `symbolPreset = "unicode"`
- `colorBlindMode = false`

### 显式切换（`setTheme`）

- 加载所选主题
- 更新全局 `theme` 单例
- 可选地启动监听器
- 触发 `onThemeChange` 回调

失败时：

- 回退到内置 `dark`
- 返回 `{ success: false, error }`

### 预览切换（`previewTheme`）

- 将临时预览主题应用到全局 `theme`
- 其本身**不会**修改已持久化的设置
- 返回成功/失败，不进行回退替换

设置 UI 使用它进行实时预览，并在取消时恢复先前的主题。

## 监听器与实时重载

当监听器启用时（`setTheme(..., true)` / 交互式初始化）：

- 仅在该文件存在时监听 `<customThemesDir>/<currentTheme>.json`
- 内置主题实际上不会被监听；内置主题查找在同名自定义文件上也优先
- 匹配的文件变更会调度一个防抖重载；重载错误或文件临时缺失会保留上一次成功加载的主题
- 监听器不执行删除/重命名回退；它会等待未来的成功重载或显式主题切换

自动模式还会依据终端外观变化、`SIGWINCH` 以及激活时的 macOS 回退观察器，重新评估 dark/light 槽位映射。

## 色盲模式行为

`colorBlindMode` 在运行时仅修改一个令牌：

- `toolDiffAdded` 经过 HSV 调整（绿色向蓝色偏移）
- 仅当解析后的值为十六进制字符串时才会应用调整

其他令牌保持不变。

## 主题设置的持久化位置

主题相关设置由 `Settings` 持久化到全局配置 YAML：

- 路径：`<agentDir>/config.yml`
- 默认 agent 目录：`~/.omp/agent`
- 生效的默认文件：`~/.omp/agent/config.yml`

持久化的键：

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`

存在旧版迁移：旧的扁平 `theme: "name"` 会根据亮度检测迁移为嵌套的 `theme.dark` 或 `theme.light`。

## 创建自定义主题（实操）

1. 在自定义主题目录中创建文件，例如 `~/.omp/agent/themes/my-theme.json`。
2. 包含 `name`、可选的 `vars` 以及**所有必填**的 `colors` 令牌。
3. 可选地包含 `symbols` 与 `export`。
4. 在设置中选择主题（`Appearance -> Dark Theme` 或 `Appearance -> Light Theme`），取决于你希望使用哪个自动槽位。

最小骨架：

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",
    "thinkingMax": "#ff007c",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## 测试自定义主题

使用以下工作流：

1. 启动交互模式（从启动开始就启用监听器）。
2. 打开设置并预览主题值（实时 `previewTheme`）。
3. 对于自定义主题文件，在运行中编辑 JSON 并确认保存时自动重载。
4. 验证关键界面：
   - markdown 渲染
   - 工具块（pending/success/error）
   - diff 渲染（added/removed/context）
   - 状态栏可读性
   - 思考级别边框变化
   - bash/python 模式边框颜色
5. 如果主题依赖字形宽度/外观，请同时验证两种符号预设。

## 实际的约束与注意事项

- 自定义主题中除可选的 `thinkingMax`（回退到 `thinkingXhigh`）外，所有 `colors` 令牌均为必填。
- `export` 与 `symbols` 是可选的。
- 主题 JSON 中的 `$schema` 仅作信息说明；运行时校验由代码中的 ArkType 模式强制执行。
- `setTheme` 失败时回退到 `dark`；`previewTheme` 失败时不会替换当前主题。
- 文件监听器重载错误或文件临时缺失会保留当前已加载的主题，直到成功重载或显式主题切换。
