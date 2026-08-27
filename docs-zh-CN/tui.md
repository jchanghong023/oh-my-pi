# 扩展与自定义工具的 TUI 集成

本文档介绍 `packages/coding-agent` 和 `packages/tui` 当前用于扩展 UI、自定义工具 UI 和自定义渲染器的 **当前** TUI 契约。

## 这个子系统是什么

运行时分为两层：

- **渲染引擎（`packages/tui`）**：差分式终端渲染器、输入分发、焦点、覆盖层、光标定位。
- **集成层（`packages/coding-agent`）**：挂载扩展/自定义工具组件、绑定按键与主题，并恢复编辑器状态。

## 各模式的运行时行为

| 模式                | `ctx.ui.custom(...)` 可用性 | 备注                                                                                                                          |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 交互式 TUI          | 支持                             | 组件被挂载到编辑器区域或覆盖层中并获得焦点，必须调用 `done(result)` 才能完成。                                                  |
| 后台/无头模式       | 非交互                           | UI 上下文为 no-op（`hasUI === false`）。                                                                                       |
| RPC 模式            | 不挂载                           | `custom()` 实现为不支持的 UI，并返回 `undefined as never`；不要在 RPC 处理器中依赖交互式 UI。                                |

如果你的扩展/工具可以在非交互模式下运行，请使用 `ctx.hasUI` / `pi.hasUI` 进行判断。

## 核心组件契约（`@oh-my-pi/pi-tui`）

`packages/tui/src/tui.ts` 定义了：

```ts
export interface Component {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate?(): void;
  setIgnoreTight?(ignore: boolean): any;
  dispose?(): void;
}
```

渲染结果由组件自身拥有，对调用方不可变。未发生变化的组件可以（且应该）返回 **与上次相同的数组引用**；当内容发生变化时，必须返回新数组。引用相等性使得容器可以记忆化并跳过稳定前缀的处理。如果某个组件就地修改了之前返回的数组，则还必须实现 `RenderStablePrefix` 并报告有多少前缀行保持不变。

`Focusable` 是独立的：

```ts
export interface Focusable {
  focused: boolean;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
}
```

光标行为使用 `CURSOR_MARKER`（而不是 `getCursorPosition`）。获得焦点的组件在渲染文本中输出该标记；`TUI` 提取该标记并定位硬件光标。

## 渲染约束（终端安全）

你的 `render(width)` 输出必须是终端安全的：

1. **任何一行都不要故意超过 `width`**。渲染器会将过宽的非图像行作为最后一道防线进行截断，但组件仍应返回宽度安全的输出。
2. **测量视觉宽度**而不是字符串长度：使用 `visibleWidth()`。
3. **截断/换行 ANSI 感知的文本**，使用 `truncateToWidth()` / `wrapTextWithAnsi()`。
4. **清理来自外部源的制表符/内容**，使用 `replaceTabs()`（以及 coding-agent 渲染路径中更高级的清理器）。

最小化模式：

```ts
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

render(width: number): readonly string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## 输入处理与按键绑定

### 原始按键匹配

使用 `matchesKey(data, "...")` 来匹配导航键和组合键。

### 匹配应用按键绑定动作

扩展 UI 工厂会接收一个 `KeybindingsManager`（交互模式下，这是一个承载默认绑定的内存实例，而非用户的 `keybindings.yml`），从而你可以通过动作 id 来匹配，而无需硬编码按键：

```ts
if (keybindings.matches(data, "app.interrupt")) {
  done(undefined);
  return;
}
```

### 按键释放/重复事件

除非你的组件设置：

```ts
wantsKeyRelease = true;
```

否则按键释放事件会被过滤掉。

然后根据需要使用 `isKeyRelease()` / `isKeyRepeat()`。

## 焦点、覆盖层与光标

- `TUI.setFocus(component)` 将输入路由到该组件。
- 覆盖层 API 存在于 `TUI` 中（`showOverlay`、`OverlayHandle`）。在交互式扩展/自定义 UI 中，`custom(..., { overlay: true })` 通过 `TUI.showOverlay(...)` 挂载你的组件；不传 `overlay` 时，它会直接替换编辑器组件区域。
- 覆盖层自定义 UI 锚定在 `bottom-center`，具有完整的终端宽度和最大高度，并在 `done(...)` 关闭流程时通过返回的覆盖层句柄被移除。

### 内置全屏界面

coding-agent 集成还在 `ctx.ui.custom(...)` 之外挂载了内置的全屏界面。[Agent Hub](./agent-hub.md) 是子代理的实时花名册与控制界面。其基于文件的转录查看器在打开期间借用备用屏幕，关闭后再在下方恢复 Hub。

## 挂载点与返回契约

## 1) 扩展 UI（`ExtensionUIContext`）

当前签名（`extensibility/extensions/types.ts`）：

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: { overlay?: boolean },
): Promise<T>
```

交互模式下的行为（`extension-ui-controller.ts`）：

- 保存编辑器文本。
- 不传 `options.overlay` 时，使用你的组件替换编辑器组件。
- 传入 `options.overlay` 时，将你的组件挂载为底部居中的覆盖层，而不是替换编辑器。
- 聚焦到你的组件。
- 在 `done(result)` 时：调用 `component.dispose?.()`，如果存在覆盖层则隐藏它，对于非覆盖层流程恢复编辑器和文本，重新聚焦编辑器，解析 promise。
  因此 `done(...)` 是完成流程的必需调用。

## 2) Hook/自定义工具 UI 上下文（运行时/类型不匹配）

`HookUIContext.custom` 仍然被类型化为 `(tui, theme, done)`，但交互式
控制器将工厂调用为
`(tui, theme, keybindings, done)`。因此第三个运行时参数是
`KeybindingsManager`，**而不是** 完成回调。一个三参数工厂
如果调用其第三个参数将在运行时失败，并导致自定义 UI
无法完成。

在 hook/自定义工具类型与控制器对齐之前，请勿从类型声明中
复制旧式的三参数示例。运行时安全的
交互式代码必须从第四个位置参数获取完成回调，
例如使用 rest 参数适配器，并应使用 `pi.hasUI`
来守护该流程：

```ts
const picked = await pi.ui.custom<string | undefined>(
  (...runtimeArgs: unknown[]) => {
    const done = runtimeArgs[3];
    if (typeof done !== "function") {
      throw new Error(
        "Interactive custom UI completion callback is unavailable",
      );
    }
    return new MyPickerComponent(
      done as (value: string | undefined) => void,
      signal,
    );
  },
);
```

这是针对当前实现的兼容性变通方案，并非
稳定的四参数 hook 类型。上述 `ExtensionUIContext.custom`
才具有受支持的四参数契约。

## 3) 自定义工具调用/结果渲染器

自定义工具和扩展工具可以从以下位置返回组件：

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

`options` 当前包括：

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

这些渲染器由 `ToolExecutionComponent` 挂载。

## 生命周期与取消

- `dispose()` 在类型层面是可选的，但当你拥有定时器、子进程、监视器、套接字或覆盖层时应该实现它。它必须是幂等的：容器会传播释放，重置/移除路径可能会汇聚到同一处。
- 在你的组件流程中，`done(...)` 应该被精确调用一次。
- 对于可取消的长时间运行的 UI，请将 `CancellableLoader` 与 `AbortSignal` 配对，并在 `onAbort` 中调用 `done(...)`。

取消模式示例：

```ts
const loader = new CancellableLoader(
  tui,
  theme.fg("accent"),
  theme.fg("muted"),
  "Working...",
);
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then((result) => done(result));
return loader;
```

## 真实的自定义组件示例（扩展命令）

```ts
import type { Component } from "@oh-my-pi/pi-tui";
import {
  SelectList,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import {
  getSelectListTheme,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): readonly string[] {
    return this.list
      .render(width)
      .map((line) => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          const items = [
            { value: "fast", label: theme.fg("accent", "Fast") },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Quality" },
          ];
          return new Picker(items, keybindings, done);
        },
      );

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## 关键实现文件

- `packages/tui/src/tui.ts` — `Component`、`Focusable`、光标标记、焦点、覆盖层、输入分发。
- `packages/tui/src/utils.ts` — 宽度/截断/清理原语。
- `packages/tui/src/keys.ts` / `keybindings.ts` — 按键解析与可配置的动作映射。
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — 扩展/hook/自定义工具 UI 的交互式挂载/卸载。
- `packages/coding-agent/src/extensibility/extensions/types.ts` — 扩展 UI 与渲染器契约。
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI 契约（旧式 custom 签名）。
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — 自定义工具 execute/render 契约。
- `packages/coding-agent/src/modes/components/tool-execution.ts` — 挂载 `renderCall`/`renderResult` 组件及 partial-state 选项。
- `packages/coding-agent/src/tools/context.ts` — 工具 UI 上下文传播（`hasUI`、`ui`）。