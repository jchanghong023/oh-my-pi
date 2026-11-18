---
name: big-review-verify
description: Verify raw big-review scan reports against repository source with OMP's native reviewer subagents and workflow and return confirmed issues that require a change.
disable-model-invocation: true
---

workflowz

从项目根目录运行 `python3 <本技能目录>/../big-review-scan/review.py status`。通过 OMP 内置工作流派发复核，每个复核子任务显式选择内置 `reviewer`。批量派发用 `workpool("reviewer", ...)`，需要单独取得结构化审查结果时用 eval 的 `agent` 并指定类型 `reviewer`。主会话负责汇总。

每项交接包含已交付的报告原文、同编号任务书和固定版本。包括缺少章节的报告和未证实的疑点。允许追读任意依赖，每个确认的问题都要落到任务书的负责对象。
- full：主会话用 `git hash-object -t tree --stdin` 读取空输入，取得本仓库格式的空树 ID。让 reviewer 以空树到固定 HEAD 的差异为审查补丁，按本片负责的路径和行段查看。这样也能复核长期存在的问题。
- fork：让 reviewer 使用任务书中的上游基线到固定目标提交的真实补丁。删除的问题锚定基线位置，重命名同时给出两端路径。

若 HEAD 已移动，再核实问题在当前代码中仍然成立。

按优先级返回去重后的真实问题，每项附源码位置、触发条件、影响和证据。简述覆盖和缺号；没有确认项时如实说明。到报告为止，修复由用户决定。
