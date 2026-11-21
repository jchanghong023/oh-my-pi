---
name: big-review-scan
description: Split a committed repository or its integrated fork delta into resumable review assignments and run a small-model first pass. Invoke explicitly with full|fork, a shard count, optional init, and optional fork base.
disable-model-invocation: true
---

# 大仓分片初审

调用 `/skill:big-review-scan full|fork N [init] [--base REF]`。使用 Git 项目根目录及本技能目录的 `review.py`。分别引用解释器、脚本路径与参数。

1. 用 `-c "import sys; sys.exit(sys.version_info < (3, 11))"` 检查解释器。Windows 依次尝试 `python`、`py -3`、`python3`；其他平台先试 `python3`、再试 `python`。都不可用则报告缺少 Python 3.11+，不安装软件。
2. 用通过检查的解释器运行 `review.py plan full|fork N [init] [--base REF]`。只传用户提供的可选参数。full 审查已提交 HEAD；fork 的 `--base REF` 固定用户指定的祖先提交。省略时优先读取 HEAD 中记录的上游基线，否则取本地 `upstream/HEAD` 与 HEAD 的共同祖先。缺少有效基线时让用户提供 `--base`，不猜分支名。脚本为每个根因位置分配唯一归属，优先归并可识别的依赖和测试，再按阅读量分配；全新文件可作上下文。
3. 读取 plan JSON：`directory` 是当前 Git 工作树的 Git 元数据目录下的本轮绝对路径，其下有 `prompts`、`drafts`、`reports`。已有任务继续使用固定版本和任务书；`init` 清理该 Git 工作树的旧任务目录。`missing` 为空时直接汇报。NEVER 向主会话展开全量任务书或报告。
4. 用 OMP 内置 eval 调度 `task` 写报告。读取宿主的 `help://eval/agents`，按实际支持的 Python 或 JS 接口执行。沿用宿主 task 路由；需显式指定时使用操作者已授权的低成本模型完整选择器，不猜供应商 ID。
5. 每个待审编号只投递一次：读取 `<directory>/prompts/<编号>.md`，将报告写入 `<directory>/drafts/<attempt>-<编号>.md`，再从项目根目录执行 `review.py publish <generation> <编号> <attempt>`。发布命令使用 plan JSON 中 `python_executable`，脚本用绝对路径；终结回执只含编号和路径。
6. Python eval 单独执行 `%load "<技能目录>/dispatch.py"`；下一格用 `await dispatch_scan(plan, script, model)`，可省略 model。脚本返回已提交的工作池名，或用独立句柄滚动补位。仅启用 JS eval 时，使用相同消息和原生接口：池开启 `freshAgents` 且有效上限在 1–32 时一次推入全部待审任务；复用会话、无限制或上限高于 32 时改用独立 `agent` 句柄，最多 32 个在途且尊重更低的宿主上限，完成一个立即补位。沿用宿主完成通知和等待机制，不设整批屏障，不改全局设置。
7. 队列结清后用 `python_executable` 执行 `review.py status`，以成功发布的非空报告统计交付。返回目录、已交付/总数、缺号；重试限缺号。自由文本报告也可由用户另行调用 `big-review-verify` 复核。
