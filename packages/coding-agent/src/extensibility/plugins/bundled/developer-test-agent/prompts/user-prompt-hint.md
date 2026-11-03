检测到单元测试相关意图。若用户请求中已指定具体 skill 或 agent，优先使用该 skill/agent，不调用 developer-test-agent；否则可使用 task 工具，设置 tasks[].agent 为 `developer-test-agent`，作为兜底。

使用 developer-test-agent 时，派发内容必须包含：
G (Goal 目标): <一句话目标>
F (Files 文件): <涉及文件的确切路径>
C (Constraints 约束): <约束：不要做什么>
V (Verify 验收): <验收：什么命令/条件算成功>
T (Task 原始任务): <用户原始任务全文>
（可选）B (Background 背景) / E (Environment 环境) / R (Related 参考): <背景/环境/参考>
