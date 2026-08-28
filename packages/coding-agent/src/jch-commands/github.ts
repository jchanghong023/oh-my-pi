import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

const GITHUB_TOOL_GUIDANCE = `优先使用 OMP 当前可用的 GitHub/仓库原生能力读取事实，不要求用户自己记忆或运行 gh 命令。需要写入 GitHub 时只执行用户明确要求的操作；认证或权限不足时准确报告阻塞。`;

export const JCH_GITHUB_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchgithubrepo",
		description: "JCH GitHub：查看仓库、默认分支和 remote 信息",
		inlineHint: "[owner/repo 或 URL]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n检查目标 GitHub 仓库的基本信息：准确的 owner/repo、默认分支、当前可见 remote/upstream 关系，以及与用户问题相关的仓库状态。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubpr",
		description: "JCH GitHub：查看并总结 PR",
		inlineHint: "<PR number/URL 或 branch> [关注点]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n读取目标 Pull Request。总结标题、状态、base/head、作者、提交、changed files、review 状态、checks 和关键讨论；如果参数指定关注点则聚焦对应部分。不要仅依赖 PR 描述，涉及实现行为时读取实际 diff/源码。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubprs",
		description: "JCH GitHub：列出/筛选 Pull Requests",
		inlineHint: "[open/closed、作者、branch、关键词等]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n列出目标仓库中符合参数条件的 Pull Requests。没有参数时优先列出当前最相关的 open PR，并给出编号、标题、head/base、更新时间和状态；结果多时只保留最有用的一组并说明过滤条件。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubprdiff",
		description: "JCH GitHub：查看 PR diff 和关键改动",
		inlineHint: "<PR number/URL> [path 或关注点]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n读取目标 PR 的真实 changed files/diff。按文件概括改动，指出关键控制流、接口、配置或行为变化；参数指定 path/关注点时优先分析。只读，不把 PR 描述当成代码事实。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubprchecks",
		description: "JCH GitHub：查看 PR checks/CI 状态和失败原因",
		inlineHint: "<PR number/URL> [check 名称]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n检查目标 PR 当前 checks/CI。列出成功、失败、进行中或跳过的检查；若存在失败，继续读取对应 workflow run/job/日志中可获得的证据，定位最具体的失败步骤和根因，不要只复述红叉。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubissue",
		description: "JCH GitHub：查看并总结 Issue",
		inlineHint: "<issue number/URL> [关注点]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n读取目标 GitHub Issue，包括正文、状态、labels、assignees 和关键评论；提取已确认事实、未决问题和与当前实现相关的引用。涉及代码行为时继续读取仓库源码验证，而不是只相信 issue 描述。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubissues",
		description: "JCH GitHub：搜索/筛选 Issues",
		inlineHint: "<关键词或过滤条件>",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n在目标仓库搜索符合参数的 GitHub Issues。按相关性和当前状态整理最有价值的结果，给出 issue number、标题、状态和简要匹配原因；不要把 PR 混成 issue，除非用户明确要求一起看。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubrelease",
		description: "JCH GitHub：查看最新或指定 Release/Tag",
		inlineHint: "[latest、tag、版本或仓库]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n检查 GitHub Release/Tag。没有明确版本时获取当前最新正式 release，并区分 prerelease/draft；给出 tag、发布时间、目标 commit 和与任务相关的 release notes。需要比较版本时基于真实 tags/commits，不凭记忆猜测。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubrun",
		description: "JCH GitHub：查看 Actions workflow run",
		inlineHint: "<run ID/URL> [job/step]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n检查指定 GitHub Actions workflow run。确定 workflow、commit、trigger、总体结论和各 job；若失败，继续定位唯一/主要失败 job 与 step，并从可读日志中提取直接证据和最小修复方向。只读，不重新运行 workflow。`,
	}),
	defineJchPromptCommand({
		name: "jchgithubworkflow",
		description: "JCH GitHub：查看 workflow 定义和最近运行",
		inlineHint: "<workflow 名称/文件> [关注点]",
		prompt: `${GITHUB_TOOL_GUIDANCE}\n检查目标 GitHub Actions workflow 的当前 YAML 定义及相关最近运行。解释 triggers、jobs、关键 steps、permissions 和参数；如果用户在排查问题，把 workflow 定义与实际 run 状态对应起来。只读，除非参数明确要求修改。`,
	}),
];
