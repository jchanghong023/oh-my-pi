# TUI 核心渲染器 —— 显式历史与视口契约

本文档描述核心渲染器契约。相关实现位于：

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) —— 帧规划、历史发射、视口差分、覆盖层与光标定位。
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) —— 终端 I/O、能力探测与私有 CSI 重组。
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) —— ANSI 感知宽度、切片、截断与换行。
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) 与
  [`packages/tui/src/components/image.ts`](../packages/tui/src/components/image.ts)
  —— 内联图像及其内存预算。

应用代码负责 transcript 生命周期。渲染器不会通过检查组件树来猜测哪些行是已完成的。

## 1. 帧归属

产品通过 `TUI.setFrameProvider()` 安装一个 `TerminalFrameProvider`。每次渲染时，提供者接收当前的 `ViewportSize` 并返回一个 `TerminalFramePlan`：

```ts
interface HistoryBatch {
  id: number;
  rows: string[];
  kind?: "append" | "replay";
}

interface TerminalFramePlan {
  history?: HistoryBatch;
  viewport: string[];
}
```

`viewport` 是本帧的完整可变屏幕图像。`append` 历史批次包含已完成的行或稳定的仅追加头行。`replay` 批次包含完整的逻辑账本，包括活动仅追加头的任何自然发出的前缀。因此，行的完成性（finality）是应用层的决定，永远不是从行越过终端顶部推断出来的。

历史批次具有单调递增的 id。TUI 对每个已接受的批次只写入一次，然后向提供者确认该 id。提供者持有待确认批次直到收到确认，并且不会重用或重排 id。这一握手协议使得重试与合并渲染是安全的，而无需渲染器将新的 transcript 与终端回滚区进行比较。

编码代理的 `TranscriptContainer` 负责活动、待定与已提交块的生命周期。块默认是可变的。Assistant / thinking 生产者显式选择启用仅追加的呈现方式，并且只发布单调延伸的、完整的稳定语义行前缀。每一行都会按当前宽度重新渲染；未关闭的 Markdown 与当前的部分后缀保持可变。在压力下，只有当前逻辑头可以在不完成的情况下发射这样的一行。最终的归档（retirement）只写入其尚未发射的后缀。

## 2. 渲染一帧

对于每一帧，TUI 会：

1. 向产品的帧提供者请求一个 plan。
2. 若存在未确认的历史批次，则恰好追加一次并确认其 id。
3. 将可变视口锚定在保留的终端历史之后。
4. 规范化视口行并按宽度适配，合成覆盖层，只发射发生变化的视口行。
5. 在同步输出帧内将硬件光标停在真实的内容位置。

历史与视口有意采用不同的更新规则。历史是有序的追加流；视口行可被替换，并与上一视口做差分。replay 是一种原子性例外：渲染器将适配进入前导空白视口行的账本后缀移动，前缀作为历史余量保留，准备 `remainder || finalViewport`，并执行一次同步的 `terminal.write`。观察不到逐块的 replay 帧。普通渲染绝不会审计或重写终端历史。

可见的覆盖层是屏幕坐标内容。它们合成在视口之上，永远不会成为历史。显示、更新或关闭覆盖层只会重绘视口。

## 3. 重置与调整大小行为

破坏性显示重置是由手势驱动的。`resetDisplay()` 与显式会话替换可以清空终端历史并重绘当前产品状态，因为用户操作建立了一个新的显示边界。普通渲染绝不会清空历史。

调整大小会作废视口几何并按新宽度与高度重绘视口。在一次已稳定（settled）的调整大小之后，`ResizeScrollbackMode` 选择如何处理保留的历史（包括清理在调整大小回调运行前因高度收缩而可能下推的活动行）：

- `rebuild` 清空原生历史并重放一份当前宽度的 transcript；
- `append` 保留原生历史并追加一份当前宽度的 transcript 副本；
- `preserve` 仅重绘视口，保留旧宽度的历史不变。

原始 TUI 默认为 `preserve` 并接受 `PI_TUI_RESIZE_SCROLLBACK`；编码代理默认为 `rebuild`。`append` 与 `rebuild` 调整大小策略各自准备一份完整的自底向上重放事务；`preserve` 不准备任何重放。重放消耗一个新的单调历史 id，但不会回退逻辑归档状态，确认操作只在同步写返回之后发生。

渲染器从不探测用户的滚动位置。这使得在用户阅读较早的终端历史时更新是安全的，并避免了与终端或平台相关的完成性策略。

## 4. ANSI 与宽度不变量

`visibleWidth`、`truncateToWidth`、`sliceByColumn` 与 `wrapTextWithAnsi` 共享同一套 ANSI 感知的 UAX#11 宽度模型。测量、切片、截断与换行都必须通过这些辅助函数，以保证转义序列保持零宽度并使列边界一致。

- 可打印 ASCII 使用快速的每码位一格（one-cell-per-code-unit）路径。
- 非 ASCII 文本使用共享的窄歧义（narrow-ambiguous）宽度模型。
- 制表符使用 `DEFAULT_TAB_WIDTH`。
- OSC 66 尺寸化区间贡献其声明的格宽。
- 过宽的行会被截断到视口宽度；渲染热路径在外观宽度失配时不得抛出。

ANSI 状态在行边界处被规范化，以保证独立更新的行仍然有效。光标写入保持在同步输出之内、在 ESU 之前，以避免出现第二帧可见内容。

## 5. 终端能力与输入探测

终端检测会选择同步输出、DECCARA 与图像协议等优化，但不会改变历史语义。

`ProcessTerminal` 将能力查询与类型化的 DA1 哨兵所有者配对。私有 CSI 应答可能跨 stdin 刷新被拆分，因此重组必须保留部分应答直到其终止符，并且不得将探测字节泄露为用户输入。新的探测需要类型化的哨兵所有者并覆盖按字节拆分的应答。

## 6. 内联图像与内存

Kitty 图像是“传输一次、放置多次”的。`ImageBudget` 只保留最近的图像；降级（demotion）按 id 删除图像像素，并以保留高度的文本回退重绘受影响的视口行。它不会重放历史。已保留在终端历史中的图像在降级时可能会丢失其像素，因为历史行是不可变的。

绝不要在每一帧上重新传输完整的 base64 图像数据。Kitty Unicode 占位符仍是能力门控的，并可通过现有的图像环境设置被覆盖。

## 7. 核心不变量

1. 产品决定行的完成性，并只通过有序的 `HistoryBatch` 提交已完成的行。
2. TUI 对一个历史批次恰好写入一次并确认其单调 id；它从不通过视口行位置推导历史。
3. 普通帧只对视口做差分与重绘。它们从不重写、审计、清空或重放保留的历史。
4. 已稳定（settled）的调整大小遵循所配置的重放模式，且不从跨宽度的物理行算术推导历史。
5. 只有显式显示重置与 `rebuild` 调整大小模式会破坏性地清空原生历史。
6. 覆盖层与图像预算变更保持为视口局部。
7. 宽度处理使用共享的 ANSI 感知辅助函数，并在渲染热路径中进行钳制而非抛出。
8. 渲染器从不探测终端滚动位置，也不按终端、多路复用器或平台分叉历史策略。
