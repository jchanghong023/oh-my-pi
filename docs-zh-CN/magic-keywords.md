# 魔法关键词

魔法关键词是用户提示中的独立散文词，可为该轮添加隐藏的、归属于用户的指令。通知注入默认启用。TUI 在编辑时以动画渐变高亮已识别的词，在已发送消息中以静态渐变高亮；高亮只是一种视觉提示，目前即使在设置中关闭了通知注入，它仍然会保留。

## 关键词

| 关键词          | 效果                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | 添加一条仔细的多步推理通知。当自动思考生效时，它还会为该轮选择当前模型所支持的最高推理力度。                                                                                                                                                                                                                                              |
| `orchestrate` | 添加多智能体编排契约：对完整任务进行范围界定，并行委派重要的独立工作，验证每个阶段，并持续推进直至请求完成。                                                                                                                                                                                                                              |
| `workflowz`   | 添加以持久 `eval` 内核的 `agent()`、`parallel()`、`pipeline()` 和 `completion()` 辅助函数为核心的确定性多子智能体工作流契约。它适用于广泛的研究、评审、迁移以及对抗性覆盖。仅当 `eval` 和 `task` 同时启用时，该通知才会被注入。                                                                                                              |
| `fullsend`    | 将速度和经过验证的质量共同置于最高优先级，不受金钱或 token 成本限制。在质量相同的前提下，按预计完成时间选择直接执行或并行委派；若预计同速，则以子智能体的干净上下文作为质量决胜因素而选择委派。必要验证仍不可省略。 |

在提示的散文中任意位置使用关键词：

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

fullsend complete and verify the release
```

斜杠命令 `/ultrathink`、`/orchestrate`、`/workflowz` 和 `/fullsend` 都接受可选任务文本。例如，`/fullsend complete and verify the release` 会发送 `fullsend complete and verify the release`；不带任务文本时只发送关键词。

## 匹配规则

匹配规则经过精心设计，确保源代码和路径不会意外地改变智能体的行为：

- 使用精确的全小写拼写。`Ultrathink`、`Orchestrate`、`Workflowz` 和 `Fullsend` 不会触发。
- 关键词必须是独立的散文。标点符号和引号可以紧贴它，但字母、数字、下划线、斜杠、反斜杠、连字符、文件扩展名、符号引用和调用语法不会匹配。例如，`orchestrate,` 匹配；而 `orchestrated`、`orchestrate.ts`、`foo::orchestrate` 和 `orchestrate()` 不匹配。
- 围栏代码块（反引号或波浪号）、内联代码片段、HTML/XML 注释/标签/元素及其内容会被忽略。
- 同一提示中所有已启用的关键词都可以各自添加通知。可见词保留在用户消息中；隐藏通知是不显示的、归属于用户的自定义消息。
- 该指令仅对包含该关键词的那一轮生效。

## 配置

打开 `/settings` 并使用 **Interaction → Magic Keywords**，或从 shell 更改设置：

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
omp config set magicKeywords.fullsend false
```

全局开关和四个按关键词开关的默认值均为 `true`。全局开关控制所有隐藏通知；按关键词开关仅控制该通知（以及 ultrathink 的最高自动思考覆盖）。这些设置目前不会禁用编辑器/消息的渐变。运行 `omp config list` 以检查每个设置及其当前值。有关配置作用域、优先级和项目本地覆盖，请参阅 [Settings](./settings.md)。
