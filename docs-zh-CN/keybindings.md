# 键盘快捷键

在 `omp` 会话中运行 `/hotkeys` 即可查看当前构建的可用快捷键组合。列表会反映从磁盘加载的所有重映射以及扩展添加的所有绑定。
普通编辑状态下，`Tab` 优先接受已打开的自动补全；补全未接管且主会话空闲时，则在共享同一会话的 Main 与 Discuss 主代理间切换。`Shift+Tab` 仍用于切换 Plan。


## 自定义键盘快捷键

用户重映射保存在 `~/.omp/agent/keybindings.yml` 中。该文件是一个 YAML 映射，其键是键盘快捷键动作 ID，其值是一个快捷键字符串或一组快捷键字符串所组成的数组。该文件不会从 `~/.omp/agent/config.yml` 读取，也没有任何嵌套的 `keybindings` 对象。

在使用命名 profile 的情况下，默认 profile 的 agent 目录中的绑定会先被加载，随后活动 profile 的 `keybindings.yml` 会按动作逐个覆盖它们。在该 profile 启动期间，被继承的文件是只读的。

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Ctrl+T
app.plan.toggle: Alt+Shift+P
```

快捷键名称不区分大小写，并使用 UI 中显示的同一套表示法，例如 `Ctrl+P`、`Alt+Shift+P`、`Shift+Enter` 和 `Ctrl+Backspace`。

将动作设置为空数组即可禁用该动作：

```yaml
app.history.search: []
```

## 常用动作 ID

| Action ID                    | Default                                                               | Meaning                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | Cycle role models forward                                                                                                                                                            |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | Cycle role models backward                                                                                                                                                           |
| `app.model.selectTemporary`  | `Ctrl+T`                                                               | Pick a model temporarily for this session                                                                                                                                            |
| `app.model.select`           | `Alt+M`                                                               | Open the model selector and set roles                                                                                                                                                |
| `app.plan.toggle`            | `Shift+Tab`                                                           | Toggle plan mode                                                                                                                                                                     |
| `app.history.search`         | `Ctrl+R`                                                              | Search prompt history                                                                                                                                                                |
| `app.tools.expand`           | `Ctrl+O`                                                              | Toggle tool-output expansion                                                                                                                                                         |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | Show or hide tool activity                                                                                                                                                           |
| `app.thinking.toggle`        | `Alt+P`                                                              | Toggle thinking-block visibility                                                                                                                                                     |
| `app.thinking.cycle`         | `Alt+,`                                                               | Cycle thinking level                                                                                                                                                                 |
| `app.editor.external`        | `Ctrl+G`                                                              | Edit the draft in `$VISUAL` / `$EDITOR`                                                                                                                                              |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | Queue a follow-up message                                                                                                                                                            |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | Dequeue a queued message back into the editor                                                                                                                                        |
| `app.retry`                  | `Alt+R`                                                               | Retry the last failed assistant turn                                                                                                                                                 |
| `app.display.reset`          | `Alt+L`                                                               | Reset terminal display                                                                                                                                                               |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | Copy the current line                                                                                                                                                                |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | Copy the whole prompt                                                                                                                                                                |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | Paste clipboard text without collapsing it                                                                                                                                           |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | Paste from the clipboard (image preferred, text fallback)                                                                                                                            |
| `app.stt.toggle`             | Unbound (hold `Space`)                                                | Toggle speech-to-text. By default there is no key chord — hold the space bar to record (push-to-talk) and release to transcribe; bind a chord here for a press-to-toggle alternative |
| `app.live.toggle`            | `Ctrl+L`                                                              | Start or stop live voice mode (same as `/live`)                                                                                                                                      |
| `app.agents.hub`             | `Alt+A`                                                               | [Open the Agent Hub](./agent-hub.md)                                                                                                                                                 |

在 Windows Terminal 中，`Ctrl+V` 可能会被终端的粘贴命令截获，导致 `omp` 接收不到；当剪贴板图片粘贴似乎没有反应时，请使用 `Alt+V` 作为备用方案。当剪贴板中没有图片时，`app.clipboard.pasteImage` 会改为粘贴剪贴板中的文本，因此仅提供此快捷键的主机（配置为转发 `Ctrl+V` 的 VS Code 集成终端、通过 `Win+V` 调用的 Windows 剪贴板历史记录）可以同时处理这两种内容类型。Windows Terminal 同样会吞掉 `Ctrl+Enter`，因此 `app.message.followUp` 还绑定了 `Ctrl+Q` —— 这与 GitHub Copilot CLI 所使用的快捷键相同 —— 同一快捷键还会提交 agent dashboard 的新 agent 描述和 hook 编辑器提示。如果你现有的 `keybindings.yml` 已将 `Ctrl+Q` 分配给其他动作，该 u…

支持 OSC 5522 enhanced paste 的终端可以直接将剪贴板 MIME 数据发送给 `omp`；图片粘贴会作为 `[Image #N]` 附件添加，而 text/plain 粘贴事件则保持正常的粘贴行为。当 OSC 5522 不可用时，bracketed paste 仍可处理文本粘贴；若粘贴的单个图片文件路径可从 `omp` 主机读取，则会作为图片加载。

加载 `keybindings.yml` 时，较旧的未限定动作名称会被迁移，但新的文档和新的配置应使用上述带命名空间的动作 ID。现有的 `keybindings.json` 文件仍然可读，并会被迁移到 `keybindings.yml`；`keybindings.yaml` 也同样可读。
