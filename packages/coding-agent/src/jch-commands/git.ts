import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_GIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchgitstatus",
		description: "JCH Git：查看仓库、分支和工作区状态",
		inlineHint: "[路径或关注范围]",
		prompt: `检查当前 Git 仓库状态并给出简洁但完整的结果：当前分支及 upstream、ahead/behind、staged、unstaged、untracked，以及是否存在冲突。优先使用当前环境已有的 Git/仓库工具。只读检查，不修改任何内容。`,
	}),
	defineJchPromptCommand({
		name: "jchgitpull",
		description: "JCH Git：安全拉取当前分支",
		inlineHint: "[remote/branch 或其他要求]",
		prompt: `安全更新当前 Git 分支。先检查当前分支、upstream 和工作区状态，再按仓库现有配置从对应远端拉取。保留本地工作，不要 reset、clean、丢弃修改，也不要擅自 stash；如果本地修改使拉取不安全，说明阻塞和最小安全处理方式。完成后验证分支和工作区状态。`,
	}),
	defineJchPromptCommand({
		name: "jchgitfetch",
		description: "JCH Git：fetch 并清理失效远端引用",
		inlineHint: "[remote 或 refspec]",
		prompt: `执行 Git fetch，默认获取相关远端并 prune 已失效的远端跟踪引用；如果参数指定 remote/refspec，则只处理指定范围。不要改写工作区或当前分支。完成后总结新增、更新、删除的远端引用以及当前分支的 ahead/behind。`,
	}),
	defineJchPromptCommand({
		name: "jchgitlog",
		description: "JCH Git：查看提交历史",
		inlineHint: "[数量、范围、路径或作者]",
		prompt: `查看 Git 提交历史并以易读形式展示。没有额外参数时默认查看最近约 20 个提交，包含短 SHA、时间、作者和主题；如果参数给出 revision range、路径、作者或数量，则按参数过滤。只读，不修改仓库。`,
	}),
	defineJchPromptCommand({
		name: "jchgitdiff",
		description: "JCH Git：查看并总结差异",
		inlineHint: "[staged、ref、range 或 path]",
		prompt: `检查 Git diff。根据参数判断是工作区、staged、两个 ref/range 或指定路径；没有参数时同时说明 staged 与 unstaged 的总体情况。先给文件级摘要，再展示或概括关键变更。只读，不修改文件。`,
	}),
	defineJchPromptCommand({
		name: "jchgitbranch",
		description: "JCH Git：查看本地/远端分支和跟踪关系",
		inlineHint: "[分支过滤条件]",
		prompt: `检查 Git 分支。展示当前分支、本地分支、相关远端分支、upstream 跟踪关系以及可确认的 ahead/behind；参数存在时按名称或条件过滤。只读，不创建、删除或切换分支。`,
	}),
	defineJchPromptCommand({
		name: "jchgitswitch",
		description: "JCH Git：切换或创建分支",
		inlineHint: "<branch> [创建/起点要求]",
		prompt: `按用户给出的目标切换 Git 分支，必要时从明确指定的起点创建新分支。操作前检查工作区，避免覆盖或丢失本地修改；目标分支不明确、存在同名歧义或切换会损坏本地工作时先说明问题，不做破坏性处理。完成后验证当前分支。`,
	}),
	defineJchPromptCommand({
		name: "jchgitstash",
		description: "JCH Git：暂存当前工作区修改",
		inlineHint: "[message、路径、是否含 untracked]",
		prompt: `按参数创建 Git stash。默认保存 tracked 文件的 staged/unstaged 修改，不包含 untracked/ignored；只有参数明确要求时才扩大范围。使用可识别的 stash message，完成后验证工作区并报告新 stash。`,
	}),
	defineJchPromptCommand({
		name: "jchgitunstage",
		description: "JCH Git：取消暂存但保留文件修改",
		inlineHint: "[path；为空表示全部 staged]",
		prompt: `取消暂存指定文件；没有参数时取消当前所有 staged 修改。必须保留工作区文件内容，不丢弃修改，不 reset --hard。完成后验证 staged/unstaged 状态。`,
	}),
	defineJchPromptCommand({
		name: "jchgitundo",
		description: "JCH Git：撤销最近本地提交并默认保留修改",
		inlineHint: "[数量或 hard/mixed 等明确要求]",
		prompt: `撤销最近的本地 Git commit。默认只撤销 1 个提交并保留其文件修改（优先采用 soft 语义）；只有参数明确要求 mixed/hard 或更多提交时才扩大影响。先确认目标提交未被不安全地改写到共享历史；不要 force-push。完成后报告 HEAD 和工作区状态。`,
	}),
	defineJchPromptCommand({
		name: "jchgitclean",
		description: "JCH Git：清理 untracked 文件（先检查）",
		inlineHint: "[路径、目录、是否含 ignored]",
		prompt: `清理 Git untracked 文件。先执行等价的 dry-run 检查并识别将删除的内容；默认只删除明确属于当前仓库范围的 untracked 文件/目录，不删除 ignored 文件。只有参数明确要求 ignored 时才允许包含它们。遇到疑似用户数据、嵌套仓库或范围歧义时停止并说明。完成后验证状态。`,
	}),
	defineJchPromptCommand({
		name: "jchgitresetcleanpull",
		aliases: ["jchgitrestcleanpull"],
		description: "JCH Git：丢弃本地改动并重置到远端最新状态",
		inlineHint: "[remote/branch；可明确要求 ignored]",
		prompt: `把当前 Git 分支强制恢复到其远端最新状态，执行 clean-reset-sync 语义。这个 slash 命令本身表示用户已明确授权丢弃当前分支的 tracked 本地修改和 untracked 文件。先确认当前分支、目标 upstream、工作区以及将被删除的内容；目标明确时 fetch 最新远端状态，重置当前分支到对应远端 tip，并清理 untracked 文件。默认绝不删除 ignored 文件，不删除其他分支，不 force-push；只有参数明确要求时才扩大到 ignored。若当前分支没有明确 upstream/目标远端，则停止而不是猜测。最后验证 HEAD 与远端一致且工作区干净。`,
	}),
	defineJchPromptCommand({
		name: "jchgitremote",
		description: "JCH Git：查看 remote、URL 和默认跟踪关系",
		inlineHint: "[remote 名称]",
		prompt: `检查 Git remote 配置。展示 remote 名称、fetch/push URL、当前分支 upstream，以及参数指定 remote 的相关配置；必要时区分 origin、upstream 等不同角色。只读，不修改 remote。`,
	}),
	defineJchPromptCommand({
		name: "jchgitblame",
		description: "JCH Git：追踪文件/代码行来源",
		inlineHint: "<path> [行范围或 symbol]",
		prompt: `根据参数对目标文件或行范围执行 Git blame/历史追踪，找出相关提交、作者和时间；如果用户给的是 symbol 或代码片段，先定位对应行。只读，并在有价值时继续查看相关 commit 解释为什么发生该修改。`,
	}),
	defineJchPromptCommand({
		name: "jchgitcommit",
		description: "JCH Git：检查改动并创建合适的 commit",
		inlineHint: "[commit message 或提交范围]",
		prompt: `创建 Git commit。先检查当前改动和仓库提交约定，只包含本次目标相关文件，避免把无关修改混入；参数给出 commit message 时优先采用其意图。必要时拆分明显无关的修改，而不是做一个混杂提交。不要 push。完成后报告 commit SHA、message 和剩余工作区状态。`,
	}),
];
