import { parseSubcommand, usage } from "../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

const JCH_FAST_REVIEW_FIX_USAGE =
	"用法：/jchfastreviewfix uncommitted | /jchfastreviewfix commit <ref> | /jchfastreviewfix repo";

function resolveJchFastReviewScope(args: string): string | undefined {
	const { verb, rest } = parseSubcommand(args);
	if (verb === "uncommitted" && !rest) {
		return "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。";
	}
	if (verb === "commit" && rest && !/\s/.test(rest)) {
		return `指定 commit ${JSON.stringify(rest)} 引入的修改。`;
	}
	if (verb === "repo" && !rest) {
		return "当前整个代码仓库（以工作区现状为准，包括未提交内容）。";
	}
	return undefined;
}

const JCH_FAST_REVIEW_FIX_PROMPT = `# jchfastreviewfix

你是快速功能 Review 与修复的主代理。

## 1. Review 范围

本次 Review 范围由内置子命令参数确定：

\`{{REVIEW_SCOPE}}\`

只 Review 指定范围，不得自行扩大、缩小、替换或猜测范围。

为了理解代码，可以读取范围外的调用方、测试、文档、历史和相关实现，但不得把范围外的问题作为本次 Review 问题。

保留用户已有的无关修改。

## 2. Review 目标

这不是寻找尽可能多问题的 Review。

先建立足够的项目理解，明确：

* 项目实际提供什么功能；
* 用户从什么入口使用；
* 相关代码位于什么真实用户流程；
* 用户正常输入和预期结果是什么。

只需要理解到足以判断本次 Review 范围，不要进行无关的全仓库研究。

判断问题时始终从真实用户角度出发：

**代码理论上存在缺陷，不代表需要修改。**

只有真实用户正常使用项目时可能遇到，并且会产生有意义的功能影响的问题，才值得继续处理。

## 3. 必须使用独立子代理 Review

必须把 Review 工作分配给独立 Review 子代理，主代理不得代替这一阶段。

子代理不会继承本提示词、主代理对话或未写入委派内容的规则。

主代理创建 task 时，MUST 将下列每一项逐项写入共享 context 或每个 task，NEVER 概括、合并、省略或假定子代理已经知道：

1. MUST 只 Review 指定范围，范围外代码只用于理解，不得报告范围外问题；
2. MUST 只报告在正常、受支持用户路径中现实可达，且正确行为有可靠依据、当前行为确实不一致、用户能感知实际功能影响、修复价值足以承担回归风险的问题；
3. MUST 只返回子代理自己确认确实应该修改的问题，NEVER 返回可能项、不确定项、建议、可选优化、最佳实践、理论风险或低价值问题；
4. MUST 完全排除安全、隐私、合规、风格、命名、格式、注释、lint、类型标注、测试覆盖率、重复、可读性、设计模式、纯重构、防御性编程、未来扩展性和微小性能优化；
5. MUST 默认淘汰正常用户几乎不会进入、需要刻意构造、只存在于极端环境或影响轻微的问题；低频问题只有属于真实支持场景且可能造成明显严重功能后果时才可报告；
6. 每个问题 MUST 给出文件和位置、正常用户触发步骤、实际错误结果、可靠的正确行为依据、用户影响及为什么值得修改；
7. 子代理 MUST 只读，不修改代码；MUST 自己调查和筛选；NEVER 为了产生结果而凑问题；
8. 没有符合全部条件的问题时，MUST 只返回“没有问题”。

发起 task 前，主代理 MUST 检查以上每一项已经实际出现在将发送给子代理的内容中。

范围较大时可以并行分配多个子代理；各子代理必须独立判断，不得因为其他代理的结论产生锚定。

Review 子代理：

* 只读，不修改代码；
* 自己先调查和筛选；
* **只返回它自己认为确实应该修改的问题。**

不要返回：

* 可能的问题；
* 不确定的问题；
* 建议；
* 可选优化；
* 最佳实践；
* 理论风险；
* 低价值问题。

如果没有值得修改的问题，直接返回没有问题。

不要为了让 Review 有结果而凑问题。

## 4. 子代理的问题门槛

子代理提交的问题必须同时满足：

1. 属于本次 Review 范围；
2. 能从项目正常、受支持的用户使用路径现实到达；
3. 正确行为能够从项目功能、调用关系、文档、测试、示例或其他可靠上下文确定；
4. 当前行为确实与正确行为不一致；
5. 用户能够感知实际功能影响；
6. 问题具有足够实际价值，值得承担修改和回归风险。

典型有效影响包括：

* 正常功能失败；
* 得到错误结果；
* 配置或参数没有按预期生效；
* 状态错误；
* 明确功能回归；
* 正常使用导致崩溃、卡死或无法完成任务。

如果无法说明真实用户如何触发、实际错误是什么以及为什么值得修改，就不要报告。

## 5. 低概率问题

不要因为代码路径理论上可以出错就报告。

正常用户几乎不会进入、需要刻意构造条件、只存在于极端环境，或者即使发生也影响轻微的问题，默认不修。

不要虚构具体发生概率。

低频问题只有在属于真实支持的用户场景，并可能造成明显严重的功能后果时，才值得报告。

判断标准是现实价值，而不是理论完美。

## 6. 明确排除

完全不要进行安全 Review。

明文密码、Token、Secret、凭据、权限、鉴权、注入、信息泄露、依赖漏洞以及其他安全、隐私或合规问题，本身都不是本次 Review 的修改理由。

如果相关代码同时导致普通用户功能失败，只按照功能失败判断，不按照安全问题判断。

同样不要因为以下内容报告或修改：

* 风格、命名、格式、注释；
* lint、类型标注、测试覆盖率；
* 代码重复、可读性、设计模式；
* 最佳实践；
* 纯重构；
* 防御性编程；
* 未来扩展性；
* 微小性能优化；
* 没有真实用户影响的理论问题；
* 与本次 Review 范围无关的历史问题。

## 7. 主代理必须重新裁决

子代理认为应该修改，不代表真的应该修改。

主代理收到每个问题后必须独立复核，不能无脑修改。

重点判断：

* 问题是否真的存在；
* 子代理是否误解了代码或产品行为；
* 是否真的属于本次范围；
* 正常用户是否现实可达；
* 正确行为是否有可靠依据；
* 用户是否真的受到有意义的影响；
* 是否已有 fallback 或正常恢复路径；
* 当前行为是否可能是有意设计；
* 问题是否低频且影响轻微；
* 修复收益是否高于代码复杂度和回归风险。

不要因为子代理报告了、多个代理都同意、修改很简单，或者希望产生代码 diff，就决定修改。

### 主代理认为不需要修改

直接不改。

最终明确报告：

**不需要修改：<简短原因>**

不要为了改而改。

### 主代理认为确实需要修改

只有主代理自己确认问题真实、现实可达、影响明确并且值得修复后，才允许修改。

## 8. 修复原则

对确认的问题直接进行最小充分修复。

只修改解决问题所必需的内容。

不要顺手：

* 重构；
* 清理；
* 升级依赖；
* 修改无关格式或命名；
* 修复其他历史问题；
* 扩大功能范围。

如果修复必须涉及 Review 范围之外的配套代码，可以进行最小必要修改。

不得覆盖用户已有的无关修改。

## 9. 快速验证

这是快速迭代命令，不要求每次修改都运行测试。

优先依靠：

1. 明确的代码逻辑和调用链；
2. 很小的针对性测试；
3. 几秒内可以完成的最小复现。

**预计可能超过 10 秒的测试或验证不要运行。**

对于决定执行的测试或验证命令：

**必须设置最多 10 秒的硬超时。**

10 秒仍未完成：

* 立即终止；
* 不延长；
* 不等待；
* 不重复运行同一个慢测试。

超时只表示该验证不适合本次快速 Review，不代表修复错误。

如果没有必要且能够在 10 秒内完成的测试，可以完全不运行测试。

不要为了形式上的验证而运行慢测试。

## 10. 最终输出

最终只报告三类信息。

### 已修复

对每个实际修复的问题简要说明：

* 问题和用户影响；
* 根因；
* 修改内容；
* 快速验证结果。

### 子代理认为应该修，但主代理判定不需要修改

只列子代理明确提交为应该修改、但主代理复核后否决的问题：

* 问题；
* 为什么不需要修改。

不要列子代理自己已经淘汰的候选项。

### 总结

说明：

* 本次 Review 范围；
* 是否进行了独立子代理 Review；
* 实际修改的文件；
* 实际执行的快速验证及结果；
* 因 10 秒规则未执行或被终止的验证。

不要输出额外优化建议、安全问题、最佳实践或无关问题。

如果最终没有值得修改的问题，明确说明本次未修改代码。`;

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchfix",
		description: "JCH：定位根因、修复问题并验证",
		inlineHint: "<问题、错误或失败现象>",
		prompt: `解决 slash 参数指定的问题。参数必须包含具体问题、错误、失败现象或目标行为；参数为空时只提示用法，不开始无目标调查。按“确认现象 → 阅读真实实现和调用链 → 定位根因 → 最小修复 → 验证”的流程推进。先复现或确认现象，再读取真实实现、相关调用方、类型、配置、数据流和错误路径，根据证据定位根因；修复源头，不忽略异常、关闭检查、硬编码特例或压制症状。只做最小必要修改；检查所有受影响调用方和跨文件契约，仅更新实际受影响部分；测试按可观察行为更新。配置只有在配置本身属于根因或目标行为时才可修改，禁止为了让验证通过而放宽配置。修改后运行直接覆盖原问题的复现、测试或实际场景；失败则继续定位和修正。环境无法完成运行时验证时，明确报告阻塞，不伪造验证结果。不要做无关重构，不 commit 或 push。最终报告根因、修改和验证证据。`,
	}),
	{
		name: "jchfastreviewfix",
		description: "JCH：快速 Review 并自动修复",
		allowArgs: true,
		inlineHint: "<uncommitted|commit <ref>|repo>",
		subcommands: [
			{ name: "uncommitted", description: "Review 当前未提交修改" },
			{ name: "commit", description: "Review 指定 commit", usage: "<ref>" },
			{ name: "repo", description: "Review 整个代码仓库" },
		],
		async handle(command, runtime) {
			const scope = resolveJchFastReviewScope(command.args);
			if (!scope) return usage(JCH_FAST_REVIEW_FIX_USAGE, runtime);
			return { prompt: JCH_FAST_REVIEW_FIX_PROMPT.replace("{{REVIEW_SCOPE}}", scope).trim() };
		},
	},
	defineJchPromptCommand({
		name: "jchfixactions",
		description: "JCH：修复当前分支最近失败的 GitHub Actions 流水线并验证",
		inlineHint: "[workflow、branch 或关注范围]",
		prompt: `修复当前分支 upstream 所属 GitHub 仓库中与当前分支相关的最新失败 GitHub Actions 流水线。先运行 git fetch --all，确认当前分支、upstream 和工作区状态；从当前分支的 upstream remote URL 解析目标 GitHub 仓库 owner/repo，不要求所有 GitHub remote 唯一，也不使用其他 remote 猜测目标。查询该仓库中与当前分支相关的、结论为 failure、timed_out 或 startup_failure 的最新有效失败 run；参数指定 workflow 或 branch 时，仅在同时满足这些条件的范围内选择目标失败 run；cancelled、skipped 和仍在运行的记录不算失败目标；若同一 workflow 和分支已有更新的成功 run 覆盖旧失败，则不修旧失败。读取目标 run 的 workflow、event、branch、head SHA、失败 job/step 和失败日志；startup_failure 没有 job/step/log 时，直接分析 workflow/run 级错误、配置和权限信息，不强求 job log。根据 event 判定 head SHA：push 事件检查失败 SHA 与当前分支历史的关系；pull_request 事件允许 GitHub 合成的 merge SHA，并解析 PR 的 head branch 与 head SHA，不要求 merge SHA 属于当前分支历史。阅读失败 workflow、run 对应源码、job/step/log、workflow 配置和相关调用方，根据证据定位真实根因。只修改本次 CI 根因需要的文件，保留所有无关本地修改；完成本地可执行的直接验证。提交前检查 index、当前分支相对 upstream 的 ahead/behind 和待提交 diff，只提交本次 CI 修复，不混入既有改动；提交消息准确描述修复并普通 push 当前分支，禁止 force-push。优先用该 push 自然产生的新 run 验证；若不会触发，则只允许用 gh workflow run 触发同一 workflow 的 workflow_dispatch，且仅传递已定义并可从上下文可靠确定的 inputs，缺失关键 input 时停止并报告。等待对应新 run 完成：成功则报告；失败则读取该 run 新日志继续修复、提交、push 并验证，最多 3 轮；第 3 轮仍失败时停止，报告剩余失败、已尝试修复和证据，不继续猜测。不要修改其他仓库，不合并或 rebase，不改写历史，不删除或回滚无关本地修改。`,
	}),
	defineJchPromptCommand({
		name: "jchcatchup",
		description: "JCH：重新理解当前代码工作现场",
		inlineHint: "[路径、提交范围或关注点]",
		prompt: `恢复当前代码工作现场。不修改工作区，允许并要求先运行 git fetch --all 更新远端引用；不 pull、push、reset、clean、stash、commit 或切换分支，也不自动继续实现。识别当前仓库、当前分支和 upstream；检查 conflicts、staged、unstaged 和 untracked 状态，阅读 staged diff 与 unstaged diff；确认当前分支相对最新 upstream 的 ahead/behind、local-only commits 和 remote-only commits。存在本地修改时，根据修改涉及路径查看约 10–20 个相关 commits；工作区干净时，根据当前分支相对 upstream 的提交差异和最近提交恢复上下文。结合真实代码理解正在进行的工作：已完成内容、当前停留位置、未完成或异常状态、影响继续的风险。最后按“已完成 / 当前状态 / 未完成与异常 / 建议下一步”给出紧凑总结。参数存在时只用于缩小路径、提交范围或关注点。`,
	}),
];
