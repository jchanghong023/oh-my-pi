# 键盘快捷键

在 `omp` 会话中运行 `/hotkeys` 即可查看当前构建生效的组合键。该列表会反映从磁盘加载的所有重映射，以及扩展添加的所有绑定。
在普通编辑器中，`Tab` 用于接受补全；`Shift+F2` 会在空闲的共享会话中切换 Main 与 Discuss 主代理。`Shift+Tab` 保留其切换计划模式的行为。


## 自定义键盘快捷键

用户重映射保存在 `~/.omp/agent/keybindings.yml` 中。该文件是一个 YAML 映射：键为快捷键动作 ID，值为单个组合键字符串或组合键字符串数组。它不会从 `~/.omp/agent/config.yml` 中读取，也不存在嵌套的 `keybindings` 对象。

使用命名 profile 时，会先加载默认 profile 的 agent 目录中的绑定，再由活动 profile 的 `keybindings.yml` 按动作逐项覆盖。在该 profile 启动期间，被继承的文件是只读的。

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Ctrl+T
app.plan.toggle: Shift+Tab
```

组合键名称不区分大小写，并使用与 UI 中所示相同的表示法，例如 `Ctrl+P`、`Alt+Shift+P`、`Shift+Enter` 和 `Ctrl+Backspace`。

将某个动作设置为空数组即可禁用它：

```yaml
app.history.search: []
```

## 常用动作 ID

| 动作 ID | 默认值 | 含义 |
| --- | --- | --- |
| `app.model.cycleForward` | `Ctrl+P` | 向前循环切换角色模型 |
| `app.model.cycleBackward` | `Shift+Ctrl+P` | 向后循环切换角色模型 |
| `app.model.selectTemporary` | `Ctrl+T` | 为当前会话临时挑选一个模型 |
| `app.model.select` | `Alt+M` | 打开模型选择器并设置角色 |
| `app.plan.toggle` | `Shift+Tab` | 切换计划模式 |
| `app.primaryAgent.cycle` | `Shift+F2` | 空闲时在 Main 与 Discuss 之间切换 |
| `app.history.search` | `Ctrl+R` | 搜索提示词历史 |
| `app.tools.expand` | `Ctrl+O` | 切换工具输出的展开状态 |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O` | 显示或隐藏工具活动 |
| `app.thinking.toggle` | `Alt+P` | 切换思考块的可见性 |
| `app.thinking.cycle` | `Shift+F1` | 循环切换思考级别 |
| `app.editor.external` | `Ctrl+G` | 在 `$VISUAL` / `$EDITOR` 中编辑草稿 |
| `app.message.followUp` | `Ctrl+Q`、`Ctrl+Enter` | 将一条后续消息排入队列 |
| `app.message.dequeue` | `Alt+Up`、`Shift+Up` | 将已排队的消息移出队列并放回编辑器 |
| `app.retry` | `Alt+R` | 重试上一次失败的 assistant 回合 |
| `app.display.reset` | `Alt+L` | 重置终端显示 |
| `app.clipboard.copyLine` | `Alt+Shift+L` | 复制当前行 |
| `app.clipboard.copyPrompt` | `Alt+Shift+C` | 复制整个提示词 |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`、`Alt+Shift+V` | 粘贴剪贴板文本且不将其折叠 |
| `app.clipboard.pasteImage` | Linux：`Ctrl+V`；macOS：`Ctrl+V`、`Cmd+V`；Windows：`Ctrl+V`、`Alt+V` | 从剪贴板粘贴（优先图片，文本作为后备） |
| `app.stt.toggle` | 未绑定（按住 `Space`） | 切换语音转文字。默认没有任何组合键——按住空格键即可录音（按住说话），松开后转写；如需按下即切换的替代方式，可在此绑定组合键 |
| `app.live.toggle` | `Ctrl+L` | 启动或停止实时语音模式（与 `/live` 相同） |
| `app.agents.hub` | `Alt+A` | [打开 Agent Hub](./agent-hub.md) |

## 恢复已清除的提示词

按 `Ctrl+C` 可清除输入框中尚未发送的草稿，再按 `Up` 即可将其找回。更早的草稿与已提交的提示词共用现有的 Up/Down 导航。找回的草稿仍可编辑，并且在提交之前绝不会发送。

已清除的草稿会在当前编辑器的有界历史（100 条）中保留空白字符、已折叠的粘贴内容和图片附件。它们不会写入持久化的提示词历史，也不会出现在 `Ctrl+R` 搜索中。关闭进程会丢弃这些被取消的草稿；单独的退出时保存行为仍然适用于输入框中当前的文本。这不是按 agent 隔离的暂存区：历史跟随编辑器，即使在 Agent Hub 切换焦点时也是如此。

现有的连按两次 `Ctrl+C` 退出行为保持不变。内容为空的清除不会添加历史条目。

该恢复功能默认开启。可在 `/settings` 的 Interaction > Input 下关闭 **Recall Cleared Drafts**，或设置 `composer.recallClearedDrafts: false`。此更改在下一次清除时即生效，无需重启；此前保留的草稿会留在历史中，直到被淘汰或编辑器关闭。

在 Windows Terminal 中，`Ctrl+V` 可能在 `omp` 收到之前就被终端的粘贴命令处理；当剪贴板图片粘贴看起来没有任何反应时，请改用 `Alt+V` 作为后备。当剪贴板中没有图片时，`app.clipboard.pasteImage` 会改为粘贴剪贴板文本，因此仅投递这一个组合键的宿主（配置为转发 `Ctrl+V` 的 VS Code 集成终端、通过 `Win+V` 触发的 Windows 剪贴板历史记录）对两种负载都能正常工作。Windows Terminal 还会吞掉 `Ctrl+Enter`，因此 `app.message.followUp` 同时绑定了 `Ctrl+Q`——与 GitHub Copilot CLI 使用的组合键相同——同一组合键还会提交 agent dashboard 中新建 agent 的描述以及 hook 编辑器的输入。如果你现有的 `keybindings.yml` 已将 `Ctrl+Q` 分配给其他动作，则用户重映射优先，后续消息将保留 `Ctrl+Enter`，除非你显式绑定 `app.message.followUp`。

支持 OSC 5522 enhanced paste 的终端可以直接把剪贴板 MIME 数据发送给 `omp`；图片粘贴会作为 `[Image #N]` 附加，而 text/plain 粘贴事件则保持正常的粘贴行为。当 OSC 5522 不可用时，bracketed paste 仍可处理文本；当粘贴的单个图片文件路径可从 `omp` 宿主读取时，会将其作为图片加载。

加载 `keybindings.yml` 时，较旧的未限定动作名称会被迁移，但新的文档和新的配置应使用上述带命名空间的动作 ID。现有的 `keybindings.json` 文件仍会被接受并迁移为 `keybindings.yml`；`keybindings.yaml` 同样可被接受。

## Vim 编辑模式

默认关闭。可在 `/settings`（Interaction → Input）中通过 **Vim Editing Mode** 开启，或直接设置：

```yaml
tui.vimMode: true
```

此后提示符将以 Insert 模式启动，行为与以往完全一致。`Escape` 切换到 Normal 模式；提示符边框会改变颜色，让当前模式一目了然。Vim 模式开启期间，Insert 模式绘制竖线光标，Normal/Visual 模式绘制块状光标——始终使用软件光标，在 `PI_HARDWARE_CURSOR` 下则通过 DECSCUSR 使用真实终端光标——并覆盖终端已配置的光标形状，直到会话退出时将其恢复。这是 Vim 的一个实用子集，而非完整实现——足以完成纯键盘的导航与选择，又不会增加更多早已被终端、shell 和 tmux 占用的 `Ctrl` 组合键。

| 模式 | 进入方式 | 退出方式 |
| --- | --- | --- |
| Insert | `i` `a` `I` `A` `o` `O` | `Escape` |
| Normal | 从 Insert 模式按 `Escape` | 任意 Insert 模式按键 |
| Visual | `v` | `Escape`，或一个操作符（`y` `d` `c`） |
| Visual line | `V` | `Escape`，或一个操作符（`y` `d` `c`） |

### Normal 模式

| 按键 | 含义 |
| --- | --- |
| `h` `j` `k` `l` | 按字符和行移动（方向键也可用） |
| `0` `^` `$` | 行首 / 第一个非空白字符 / 行尾 |
| `w` `b` `e` | 下一个词、上一个词、词尾 |
| `gg` `G` | 首行、末行（`5gg` 和 `5G` 跳转到第 5 行） |
| `1`–`9` 前缀 | 重复移动或操作符，例如 `3w`、`5j`、`2dd` |
| `i` `a` `I` `A` | 在光标前 / 后插入，在行首 / 行尾插入 |
| `o` `O` | 在下方 / 上方新开一行并插入 |
| `x` `D` `C` | 删除字符、删除至行尾（`2D` 可带 `count` 指定行数）、更改至行尾（`2C` 同理） |
| `d` `y` `c` + 移动 | 对一段移动范围进行操作，例如 `dw`、`d$`、`yb`、`cw` |
| `dd` `yy` `cc` | 按行删除 / 复制 / 更改 |
| `d` `y` `c` + 文本对象 | 对一个文本对象进行操作，例如 `diw`、`ca(`、`ci"`、`dap` |
| `p` `P` | 把最近一次复制或删除的内容放到光标后 / 前 |
| `u` | 撤销 |

### 文本对象

文本对象可以跟在操作符后面（`diw`），也可以用来扩展 Visual 选区（`viw`）。`i` 取内部，`a` 连同外围一起取；计数同样适用，例如 `d2aw`。

| 对象 | 覆盖范围 |
| --- | --- |
| `iw` `aw` | 词；`aw` 还会连同相邻空白一起取 |
| `iW` `aW` | 以空白分隔的 WORD |
| `i"` `i'` `` i` `` | 当前行上引号的内部（`a"` 也会连同引号一起取） |
| `i(` `i[` `i{` `i<` | 最内层匹配括号对的内部，可感知嵌套并可跨行 |
| `a(` `a[` `a{` `a<` | 同一括号对并包含其定界符（`b` 和 `B` 分别等价于 `(` 和 `{`） |
| `ip` `ap` | 段落——连续的非空行（或空行），按行处理 |

### Visual 模式

`v` 开始字符级选区，`V` 开始行级选区；移动键用于移动选区的自由端。`y` 将选区复制到系统剪贴板（同时复制到内部寄存器，因此 `p` 可将其放回），`d` 删除选区，`c` 删除选区并进入 Insert 模式。`x` 的删除效果与 `d` 相同，`s` 的更改效果与 `c` 相同。`o` 跳转到选区的另一端。`Escape` 取消选区。

如果选区本会从某个附件占位符（例如 `[Image #1, 800x600]` 或 `[Paste #2, +30 lines]`）中间截断，则会连同整个占位符一起选中，因此删除操作绝不会留下损坏的片段。

### Escape

`Escape` 与应用级中断共用，因此只有当它确有用途时，Vim 模式才会接管它：

- **Insert 模式** → 切换到 Normal 模式。
- **Visual 模式**，或输入到一半的计数或操作符 → 取消并回到无待处理操作的 Normal 模式。
- **无待处理操作的 Normal 模式** → 按其通常含义生效（关闭自动补全、中止正在运行的回合、清除草稿）。

Vim 按键绝不会遮蔽应用组合键：`Ctrl` 组合键、`Enter` 和 `Tab` 在所有模式下都保持正常行为，因此在 Normal 模式下仍可用 `Enter` 提交。提示词历史仅在 Insert 模式下保留在 `Up`/`Down` 上——在 Normal 模式中这两个键是 `k` 和 `j`，因此在多行草稿中移动光标绝不会载入上一条提示词。
