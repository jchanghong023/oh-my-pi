# safety-hook

一个 `oh-my-pi` 扩展，用于演示 `tool_call` 阻塞。它会拦截 `bash` 工具调用，当命令包含带普通空格的 `rm -rf /` 时返回 `{ block: true, reason: "..." }`，从而阻止该工具执行。

## 演示内容

- `pi.on("tool_call", ...)` — 执行前的拦截
- `return { block: true, reason: "..." }` — 阻塞契约
- 对 bash 输入的正则守卫（`/\brm\s+-rf\s+\//`）

## 安装

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

重启 `omp`。该钩子对所有会话生效。

或者一次性加载：

```
omp --extension ./safety-hook
```

## 工作原理

```
LLM calls bash tool
       │
       ▼
tool_call handlers run
       │
       ├─ command matches /\brm\s+-rf\s+\// ?
       │       yes → { block: true, reason: "..." }  ←  execution stops, reason sent to LLM
       │       no  → undefined                        ←  execution continues normally
       ▼
tool executes (if not blocked)
```

`reason` 文本就是 LLM 作为工具错误接收到的内容，因此它能够理解调用被拒绝的原因并尝试其他方式。
