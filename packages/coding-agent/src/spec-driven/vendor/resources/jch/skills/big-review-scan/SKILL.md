---
name: big-review-scan
description: Split a committed repository or its integrated fork delta into resumable review assignments and run a small-model first pass. Invoke explicitly with full|fork, a shard count, and optional init.
disable-model-invocation: true
---

# 大仓分片初审

调用 `/skill:big-review-scan full|fork N [init]`。使用项目 Git 根目录作为工作目录，使用本技能目录随附的 `review.py`。脚本使用 Python 3.11 标准库和本地 Git。项目路径、脚本路径与参数分别传入，正确引用路径。

1. 执行 `python3 <技能目录>/review.py plan full|fork N [init]`（将模式、数字替换为实参，仅在用户传 init 时传入）。full 读已提交 HEAD。fork 优先读 HEAD 中记录的上游基线，其他 fork 取本地 upstream 默认分支和 HEAD 的共同祖先。脚本为每个重点对象分配唯一归属，优先把可识别的相对导入、实现和测试放在一起，再按阅读量分配。项目依赖及新增文件可按需阅读。只上报根因落在分片范围内的问题和疑点。
2. 读取脚本返回的 JSON。相同参数恢复原版本和任务书；init 在重新分片前直接删除先前任务目录。输出中的 directory 是本轮绝对目录，其下有 prompts、drafts、reports。missing 已按编号核对；为空就汇报已有报告。不要向主会话展开所有任务书或报告。
3. 用 OMP 内置 eval 调度 `task` 写报告。读取宿主的 `xd://eval/agents`，按实际支持的 Python 或 JS 接口执行。用当前配置的低成本 task 模型；如果需显式指定，使用操作者已授权的廉价模型完整选择器。使用宿主已配置的 task 路由或获准的模型，不猜供应商 ID。
4. 每个待审编号生成一条消息：读取 `<directory>/prompts/<编号>.md`；将报告写到 `<directory>/drafts/<attempt>-<编号>.md`；写完后，在项目根目录执行 `python3 <脚本绝对路径> publish <generation> <编号> <attempt>`。直接从 plan JSON 取 attempt 和 generation。本调用内同一编号只投递一次。任务的终结回执只含编号和路径。
5. 在 Python eval 单独执行 `%load "<技能目录>/dispatch.py"`；下一格用 `await dispatch_scan(plan, script, model)` 调度。plan 是步骤 1 的 JSON 对象，script 是 review.py 的绝对路径，model 省略时沿用 task 配置。脚本立即投递工作池并返回池名，或用独立句柄有界补位。用宿主完成通知处理进度并等到结清。若宿主仅启用 JS eval，采用同样的原生接口：使用单个有名称的工作池（Python 为 `pool = workpool("task", name=...)`，`pool.push(*messages)`），并使用独立分片上下文、最多 32 个在途。若池状态的 freshAgents 为真且 limit 为 32，可一次推入全部消息。若宿主上限更低，尊重该上限。若池将复用会话，或上限高于 32／无限，则改用 eval 的独立 `agent(..., agent="task")` 句柄按同样上限调度，收到任一完成事件立即补位。使用宿主 wait 和完成通知；不设整批屏障，不改用户的全局设置。进度、失败、取消均按实际状态报告。
6. 队列结清后执行 `python3 <脚本> status`，以发布成功的非空报告统计交付。失败的任务只重试缺号；缺章节的自由文本报告可直接交给复核。返回本轮路径、已交付/总数和缺号。用户另行调用 big-review-verify 决定复核时机。
