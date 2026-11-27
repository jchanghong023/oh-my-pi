---
name: big-review-verify
description: Verify raw big-review scan reports against repository source with OMP's native reviewer subagents and workflow and return confirmed issues that require a change.
disable-model-invocation: true
---

workflowz

从 Git 项目根目录运行相邻 `big-review-scan/review.py` 的 `status`。先用 `-c "import sys; sys.exit(sys.version_info < (3, 11))"` 检查解释器：Windows 依次尝试 `python`、`py -3`、`python3`，其他平台先试 `python3`、再试 `python`。用通过检查的命令执行脚本；都不可用则明确报告缺少 Python 3.11+，不安装软件。

通过 OMP 内置工作流派发。批量用 `workpool("bundled:reviewer", …)`；独立 eval `agent` 的 `agent` 参数也 MUST 为 `bundled:reviewer`。NEVER 使用可能被覆盖的裸名 `reviewer`。池内 MUST 每项按实际项号提交一次 `yield`：`{key, data}` 包含完整 `findings` 数组及 `overall_correctness`、`explanation`、`confidence`；受阻用 `{key, error}`。池内 NEVER 用 `type` 分段提交。独立 `agent` 沿用 reviewer 的原生结构化协议。主会话按项号收齐结果；回执被截断时，用 `peek()` 取完整结果，不把失败、缺失或截断当作无问题。

每项交接包含已交付的报告原文、同编号任务书和固定版本。包括缺少章节的报告和未证实的疑点。允许追读任意依赖，每个确认的问题都要落到任务书的负责对象。
- full：主会话用 `git hash-object -t tree --stdin` 读取空输入，取得本仓库格式的空树 ID。让 reviewer 以空树到固定 HEAD 的差异为审查补丁，按本片负责的路径和行段查看。这样也能复核长期存在的问题。
- fork：让 reviewer 使用任务书中的上游基线到固定目标提交的真实补丁。删除的问题锚定基线位置，重命名同时给出两端路径。

若 HEAD 已移动，再核实问题在当前代码中仍然成立。

按优先级返回去重后的真实问题，每项附源码位置、触发条件、影响和证据。简述覆盖和缺号；没有确认项时如实说明。到报告为止，修复由用户决定。
