import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchfix",
		description: "JCH：定位根因、修复问题并验证",
		inlineHint: "<问题、错误或失败现象>",
		prompt: `解决 slash 参数指定的问题。参数必须包含具体问题、错误、失败现象或目标行为；参数为空时只提示用法，不开始无目标调查。按“确认现象 → 阅读真实实现和调用链 → 定位根因 → 最小修复 → 验证”的流程推进。先复现或确认现象，再读取真实实现、相关调用方、类型、配置、数据流和错误路径，根据证据定位根因；修复源头，不忽略异常、关闭检查、硬编码特例或压制症状。只做最小必要修改；检查所有受影响调用方和跨文件契约，仅更新实际受影响部分；测试按可观察行为更新。配置只有在配置本身属于根因或目标行为时才可修改，禁止为了让验证通过而放宽配置。修改后运行直接覆盖原问题的复现、测试或实际场景；失败则继续定位和修正。环境无法完成运行时验证时，明确报告阻塞，不伪造验证结果。不要做无关重构，不 commit 或 push。最终报告根因、修改和验证证据。`,
	}),
	defineJchPromptCommand({
		name: "jchfixactions",
		description: "JCH：修复当前分支最近失败的 GitHub Actions 流水线并验证",
		inlineHint: "[workflow、branch 或关注范围]",
		prompt: `修复当前分支 upstream 所属 GitHub 仓库中与当前分支相关的最新失败 GitHub Actions 流水线。先运行 git fetch --all，确认当前分支、upstream 和工作区状态；从当前分支的 upstream remote URL 解析目标 GitHub 仓库 owner/repo，不要求所有 GitHub remote 唯一，也不使用其他 remote 猜测目标。查询该仓库中与当前分支相关的、结论为 failure、timed_out 或 startup_failure 的最新有效失败 run；cancelled、skipped 和仍在运行的记录不算失败目标；若同一 workflow 和分支已有更新的成功 run 覆盖旧失败，则不修旧失败。读取目标 run 的 workflow、event、branch、head SHA、失败 job/step 和失败日志；startup_failure 没有 job/step/log 时，直接分析 workflow/run 级错误、配置和权限信息，不强求 job log。根据 event 判定 head SHA：push 事件检查失败 SHA 与当前分支历史的关系；pull_request 事件允许 GitHub 合成的 merge SHA，并解析 PR 的 head branch 与 head SHA，不要求 merge SHA 属于当前分支历史。阅读失败 workflow、run 对应源码、job/step/log、workflow 配置和相关调用方，根据证据定位真实根因。只修改本次 CI 根因需要的文件，保留所有无关本地修改；完成本地可执行的直接验证。提交前检查 index、当前分支相对 upstream 的 ahead/behind 和完整 outgoing commit range，禁止夹带无关 staged 内容或无关 commits；创建仅包含本次 CI 修复的 commit，普通 push 到当前分支现有 upstream，不 force-push，不自动 merge/rebase。push 后优先使用原始事件自然产生且包含 fix commit 的新 run 作为验证；若 push 已产生新 run，则不重复手动触发。workflow_dispatch 只有在确认其实际覆盖原失败路径时才能作为验证；不同 event 下失败 job 未执行时，不得判定修复成功。最多进行 3 轮代码修复，每轮代码修复必须产生新的 fix commit；外部基础设施、权限、secret 等非代码问题应停止并报告直接证据。最终报告原失败 run、根因、修改、fix commit、push 目标、新 run 和最终结论。`,
	}),
	defineJchPromptCommand({
		name: "jchcatchup",
		description: "JCH：重新理解当前代码工作现场",
		inlineHint: "[路径、提交范围或关注点]",
		prompt: `恢复当前代码工作现场。不修改工作区，允许并要求先运行 git fetch --all 更新远端引用；不 pull、push、reset、clean、stash、commit 或切换分支，也不自动继续实现。识别当前仓库、当前分支和 upstream；检查 conflicts、staged、unstaged 和 untracked 状态，阅读 staged diff 与 unstaged diff；确认当前分支相对最新 upstream 的 ahead/behind、local-only commits 和 remote-only commits。存在本地修改时，根据修改涉及路径查看约 10–20 个相关 commits；工作区干净时，根据当前分支相对 upstream 的提交差异和最近提交恢复上下文。结合真实代码理解正在进行的工作：已完成内容、当前停留位置、未完成或异常状态、影响继续的风险。最后按“已完成 / 当前状态 / 未完成与异常 / 建议下一步”给出紧凑总结。参数存在时只用于缩小路径、提交范围或关注点。`,
	}),
];
