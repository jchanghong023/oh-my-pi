import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchfix",
		description: "JCH：定位根因、修复问题并验证",
		inlineHint: "<问题、错误或失败现象>",
		prompt: `解决 slash 参数指定的问题。参数必须包含具体问题、错误、失败现象或目标行为；缺失时只说明用法，不开始无目标调查。先复现或确认现象，再读取真实实现、相关调用方、类型、配置、数据流和错误路径，根据证据定位根因；修复源头，不忽略异常、关闭检查、硬编码特例或压制症状。只做最小必要修改，迁移所有受影响调用方，并按可观察契约更新必要测试或配置。修改后运行直接覆盖原问题的复现、测试或实际场景；失败则继续定位和修正，直到问题已解决或存在无法从当前环境取得的明确阻塞。不要做无关重构，不 commit 或 push。最终报告根因、修改和验证证据。`,
	}),
	defineJchPromptCommand({
		name: "jchfixactions",
		description: "JCH：修复最近失败的 GitHub Actions 流水线并重新触发",
		inlineHint: "[workflow、branch 或关注范围]",
		prompt: `修复当前仓库最近一次失败的 GitHub Actions 流水线，并在修复进入远端后使用 gh 触发验证。先从当前仓库 Git remote 确认唯一的 GitHub owner/repo，检查 gh 认证、当前分支、upstream 和工作区；保留所有无关本地修改。查询结论为 failure、timed_out 或 startup_failure 的最近 1 次已完成 workflow run；参数指定 workflow 或 branch 时，仅在同时满足这些条件的范围内选择。读取目标 run 的 workflow、event、branch、head SHA、失败 job/step 和失败日志；不得把 cancelled、skipped 或仍在运行的记录当成目标。结合失败 run 对应源码、当前分支代码和 workflow 定义，根据证据定位根因；如果目标不唯一、失败 SHA 不属于当前分支历史、失败已不适用于当前代码、需要不可读取的 secrets/权限或会覆盖本地工作，则停止并报告阻塞。只做修复根因所需的最小修改，检查调用方和相关配置，运行直接覆盖失败路径的本地验证；验证失败则继续修正。提交前检查当前分支相对 upstream 的 ahead/behind、远端 tip 和完整 outgoing commit range；远端包含未整合提交或 outgoing range 含无关提交时停止，不自动 merge、rebase 或扩大推送范围。确认解决后，只暂存本次 CI 修复相关文件，按仓库约定创建 commit，并普通 push 到明确 upstream；不混入无关修改，不 force-push。修复 commit 已在远端后，优先使用 gh 触发同一 workflow 在该分支上的新运行；如果 push 已自动创建对应新 run，则不要重复触发。如果 workflow 不支持手动触发且 push 未创建运行，报告阻塞，不擅自修改触发器，也不得重跑不包含修复 commit 的旧 SHA。确认新 run ID、URL 和 head SHA 对应修复 commit，并监看结果；最多进行 3 轮远程修复验证，每轮重新触发前必须存在新的 fix commit，同一 head SHA 不得重复手动触发。同一根因仍失败时继续诊断；达到上限、外部故障或权限问题时停止并报告直接证据。最终报告原失败 run、根因、修复 commit、push 目标、每轮新 run 和结论。`,
	}),
	defineJchPromptCommand({
		name: "jchcatchup",
		description: "JCH：重新理解当前代码工作现场",
		inlineHint: "[路径、提交范围或关注点]",
		prompt: `恢复当前代码工作现场。严格只读，不修改文件，不 stage、commit、stash、pull、push 或切换分支，也不自动继续实现。识别当前仓库、分支和 upstream；检查 conflicts、staged、unstaged 和 untracked 状态；阅读当前 diff，并查看最近约 10–20 个与现有修改相关的 commits。结合真实代码理解这些修改正在实现什么，识别已经完成的内容、当前停留位置、未完成或异常状态，以及可能影响继续工作的风险。最后按“已完成 / 当前状态 / 未完成与异常 / 建议下一步”给出紧凑总结。参数存在时只用于缩小路径、提交范围或关注点。`,
	}),
];
