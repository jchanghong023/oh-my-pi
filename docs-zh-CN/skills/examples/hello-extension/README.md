# hello-extension

一个最简的 `oh-my-pi` 扩展，演示两种最常见的编写模式：订阅 `session_start` 在加载时发出通知，以及注册一个 `/hello` 斜杠命令向会话中发送问候。它故意做得非常精简——你可以把它作为编写自己扩展的复制粘贴起点。

## Install

**选项 A — 放入用户扩展目录：**

```
cp -r . ~/.omp/agent/extensions/hello-extension
```

重启 `omp`。你将立即看到启动通知。

使用 `omp --profile <name>` 时，请改用 `~/.omp/profiles/<name>/agent/extensions/hello-extension`。`PI_CODING_AGENT_DIR` 同样会改变 agent 目录。

**选项 B — 在 settings 的 `extensions` 数组中指向它：**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**选项 C — 通过 CLI 标志加载一次：**

```
omp --extension ./hello-extension
```

## Usage

加载完成后，在 omp 提示符中输入 `/hello` 或 `/hello Ada`。该命令会向会话中发送一条可见的问候自定义消息，并显示 "Message sent!" 通知。

## What it demonstrates

- 默认导出工厂接收 `ExtensionAPI`
- `pi.on("session_start", ...)` —— 会话生命周期钩子
- `pi.registerCommand(...)` —— 斜杠命令注册
- `ctx.ui.notify(...)` —— 面向用户的通知
- `package.json` 中的 `omp.extensions` 清单字段
