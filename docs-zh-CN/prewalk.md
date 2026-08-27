# Prewalk

Prewalk 是一种在规划阶段进入实现阶段后，由当前模型一次性交接给更快或更便宜模型的机制。它允许起始模型在目标模型继续接管会话之前先检查仓库、创建待办清单，并开始实施变更。

Prewalk 默认关闭。其默认目标是分配给 `@smol` 角色的模型。

## 启用 prewalk

在全局配置中持久启用 prewalk：

```bash
omp config set prewalk.enabled true
```

等价的 YAML 写法，配置在 `~/.omp/agent/config.yml` 或项目的 `.omp/config.yml` 中：

```yaml
prewalk:
  enabled: true
```

会话级标志会覆盖已配置的值：

| 标志 | 作用 |
| --- | --- |
| `--prewalk` | 为新会话启用 prewalk。 |
| `--no-prewalk` | 即使 `prewalk.enabled` 为 `true`，本次会话也保持 prewalk 关闭。 |
| `--prewalk-into <model-or-role>` | 启用 prewalk，并使用指定的模型匹配模式或角色替代 `@smol`。 |

例如：

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

启动时，OMP 按照常规的模型角色和模型匹配规则解析目标。如果目标无法解析或未配置凭据，OMP 会打印警告并以未启用 prewalk 的状态启动。

## 交接触发条件

已启用的 prewalk 会注入一条规划提示。当 `todo` 工具处于激活状态时，任何成功的 `todo` 调用（包括只读的 `view` 操作）都会打开交接闸门。OMP 会在第一次完成的 `edit` 或 `write` 调用之后切换模型。

其他工具的调用不会触发交接。通过 `write` 路由的只读 `xd://` 设备请求（例如 LSP 导航）也不计入；只有归类为工作区写入或执行的设备操作才会被计入。

该切换是一次性的：交接完成后，prewalk 会自动解除武装。如果目标模型和思考级别已经与会话当前设置一致，则不会切换模型，因为这种交接等同于无操作。

## 在活动会话中启用

运行斜杠命令以启用 prewalk，无需重启 OMP 或在配置中开启：

```text
/prewalk
```

`/prewalk` 始终以 `@smol` 角色为目标。如果 prewalk 已经启用，该命令会保持现有目标不变。完成一次交接后，请切换到其他模型并再次运行 `/prewalk` 以启用下一次一次性交接。若要在启动时选择不同的目标，请使用 `--prewalk-into`。

## 子代理 prewalk

任务子代理拥有独立的 prewalk 控制项：代理 frontmatter、`task.prewalk` 以及针对单个代理的 `task.agentPrewalk` 覆盖项。它们的优先级和目标选择请参见 [Task agent discovery](./task-agent-discovery.md)。
