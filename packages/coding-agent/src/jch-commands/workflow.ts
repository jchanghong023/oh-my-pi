import { parseSubcommand, usage } from "../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";
import { handleQuickGitSummary } from "./git";

const JCH_FUNCTIONAL_REVIEW_FIX_USAGE =
	"用法：/jchfuncreviewfix uncommitted | /jchfuncreviewfix commit <ref> | /jchfuncreviewfix repo";
const JCH_FUNCTIONAL_REVIEW_USAGE =
	"用法：/jchfuncreview uncommitted | /jchfuncreview commit <ref> | /jchfuncreview path <path>";
const JCH_VERIFY_USAGE = "用法：/jchverify uncommitted | /jchverify commit <ref> | /jchverify path <path>";
const JCH_CATCHUP_USAGE = "用法：/jchcatchup | /jchcatchup full [路径、提交范围或关注点]";

const JCH_CATCHUP_FULL_PROMPT = `恢复当前代码工作现场。不修改工作区，先运行 git fetch --all 更新远端引用；不 pull、push、reset、clean、stash、commit、切换分支或自动继续实现。识别仓库、当前分支和 upstream；检查 conflicts、staged、unstaged、untracked，阅读 staged/unstaged diff，并读取与当前工作相关的 untracked 文本源文件，跳过生成物、依赖、二进制和大文件。确认相对最新 upstream 的 ahead/behind、local-only 和 remote-only commits。存在本地修改时，按涉及路径读取足以解释修改的相关 commits，默认不超过 20 个；工作区干净时，根据分支差异和最近提交恢复上下文。结合真实代码总结“已完成 / 当前状态 / 未完成与异常 / 建议下一步”。参数只缩小路径、提交范围或关注点。`;

function resolveJchScope(args: string, mode: "review-fix" | "read-only"): string | undefined {
	const { verb, rest } = parseSubcommand(args);
	if (verb === "uncommitted" && !rest) {
		return "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。";
	}
	if (verb === "commit" && rest && !/\s/.test(rest)) {
		return `指定 commit ${JSON.stringify(rest)} 引入的修改。`;
	}
	if (mode === "review-fix" && verb === "repo" && !rest) {
		return "当前整个代码仓库（以工作区现状为准，包括未提交内容）。";
	}
	if (mode === "read-only" && verb === "path" && rest) {
		return `指定路径 ${JSON.stringify(rest)} 中的代码（以工作区现状为准，包括该路径下的未提交内容）。`;
	}
	return undefined;
}

const JCH_FUNCTIONAL_REVIEW_CONTRACT = `REVIEW_CONTRACT_BEGIN
Review 范围：{{REVIEW_SCOPE}}

- MUST 只 Review 指定范围；范围外代码仅用于理解，NEVER 报告范围外问题。
- 仅当问题同时满足以下全部条件时才报告：
  1. 正常、受支持的用户路径现实可达；
  2. 正确行为有项目功能、调用关系、文档、测试或示例等可靠依据；
  3. 当前行为确实与正确行为不一致；
  4. 用户能感知实际功能影响；
  5. 修复价值足以承担复杂度和回归风险。
- NEVER 报告安全、隐私、合规、风格、命名、格式、注释、lint、类型标注、测试覆盖率、重复、可读性、设计模式、纯重构、防御性编程、未来扩展性、微小性能优化或无用户影响的理论问题。
- 正常用户几乎不会进入、需要刻意构造或影响轻微的问题默认淘汰；低频问题仅在真实支持场景可能造成明显严重功能后果时报告。
- 每个问题 MUST 给出文件和位置、正常用户触发步骤、实际错误结果、正确行为依据、用户影响及值得修改的理由。
- 子代理 MUST 只读并独立调查；只返回自己确认确实应该修改的问题，NEVER 返回可能项、不确定项、建议、可选优化或最佳实践。
- 没有符合全部条件的问题时，只返回“没有问题”。
REVIEW_CONTRACT_END`;

const JCH_FUNCTIONAL_REVIEW_DELEGATION = `主代理 MUST 委派一名独立只读 Review 子代理执行审查，不得自行代替。子代理不继承本提示词；创建 task 时 MUST 原样携带以下契约块全部内容，NEVER 概括或省略：

${JCH_FUNCTIONAL_REVIEW_CONTRACT}

主代理收到问题后 MUST 独立复核真实性、范围、可达性、正确行为依据、fallback、有意设计、用户影响以及收益/回归风险；不得因为子代理报告、多个代理同意或修改简单就接受。`;

const JCH_FUNCTIONAL_REVIEW_PROMPT = `# jchfuncreview

${JCH_FUNCTIONAL_REVIEW_DELEGATION}

主代理和子代理都 MUST 保持只读：不修改代码、文件或配置，不 commit、push 或触发外部写操作。

最终只列主代理复核后仍成立的问题；每项给出位置、触发路径、实际与正确结果、证据、用户影响和优先级。没有问题时明确说明没有符合门槛的功能问题。不要输出修复、优化、安全或最佳实践建议。`;

const JCH_FUNCTIONAL_REVIEW_FIX_PROMPT = `# jchfuncreviewfix

${JCH_FUNCTIONAL_REVIEW_DELEGATION}

主代理只修复自己复核后确认真实、现实可达、影响明确且值得修复的问题。修改 MUST 最小充分，保留用户无关修改；必要的范围外配套修改仅限维持受影响契约，NEVER 顺手重构、清理、升级或扩大功能。

验证规则：
- 项目或目录规则要求的检查 MUST 执行，不受快速验证上限约束。
- 其他可选验证仅在直接覆盖问题且预计 10 秒内完成时运行，并设置最多 10 秒硬超时；超时立即停止，不重复慢检查。
- 优先使用明确调用链、最小复现、小型针对性测试或实际场景；验证失败则继续定位，NEVER 用配置放宽或症状压制换取通过。

最终只报告：实际修复的问题、主代理否决的子代理问题、修改文件、验证命令与结果、未验证阻塞。没有值得修改的问题时明确说明未修改代码。`;

const JCH_VERIFY_PROMPT = `验证以下范围，不修复问题：

{{VERIFY_SCOPE}}

保持源代码和配置只读，不 commit、push 或触发外部写操作。先阅读范围内修改、受影响调用方、可观察契约及适用的项目/目录规则，再选择能够证明行为的最小验证：直接复现或 smoke 场景、相关既有测试，以及所有项目强制检查。项目强制检查不得因耗时被跳过；除此之外，不运行与范围无关的大型全套测试。

验证 commit 时确认当前代码是否包含该 commit；需要隔离执行时使用临时工作树，NEVER 污染当前工作区。任何失败只调查到足以给出准确证据，不修改代码。最终按“结论（通过/失败/未验证）/ 覆盖的契约 / 命令与结果 / 剩余风险或阻塞”报告。`;

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchfix",
		description: "JCH：定位根因、修复问题并验证",
		inlineHint: "<问题、错误或失败现象>",
		requiredArgsUsage: "用法：/jchfix <问题、错误或失败现象>",
		prompt: `解决 Slash 参数指定的问题。用户已经报告的现象 MUST 视为事实，不重复运行仅为确认；只有定位根因需要时才做最小复现。读取真实实现、相关调用方、类型、配置、数据流和错误路径，根据证据定位根因；修复源头，NEVER 忽略异常、关闭检查、硬编码特例或压制症状。只做最小必要修改，检查全部受影响调用方和跨文件契约，测试按可观察行为更新；配置仅在其本身属于根因时修改。完成后运行直接覆盖原问题的复现、测试或实际场景，并执行项目强制检查；失败则继续定位。不要无关重构，不 commit 或 push。最终报告根因、修改和验证证据；环境阻塞时准确说明，NEVER 伪造结果。`,
	}),
	defineJchPromptCommand({
		name: "jchdiagnose",
		description: "JCH：只读定位问题根因与修复边界",
		inlineHint: "<问题、错误或失败现象>",
		requiredArgsUsage: "用法：/jchdiagnose <问题、错误或失败现象>",
		prompt: `只读诊断 Slash 参数指定的问题。用户已经报告的现象 MUST 视为事实，不重复运行仅为确认；只有定位根因需要时才做非破坏性的最小复现。阅读真实实现、调用方、类型、配置、数据流和错误路径，确定预期行为依据、当前行为差异、用户影响、根因和受影响范围。不要修改代码、文件或配置，不 commit、push 或触发外部写操作。最终按“诊断结论 / 根因证据 / 影响范围 / 最小修复边界 / 未确认项或阻塞”报告；无法确认问题时明确说明证据缺口，不猜测。`,
	}),
	{
		name: "jchfuncreview",
		description: "JCH：只读审查高置信、现实可达的功能问题",
		allowArgs: true,
		inlineHint: "<uncommitted|commit <ref>|path <path>>",
		subcommands: [
			{ name: "uncommitted", description: "只读 Review 当前未提交修改" },
			{ name: "commit", description: "只读 Review 指定 commit", usage: "<ref>" },
			{ name: "path", description: "只读 Review 指定路径", usage: "<path>" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "read-only");
			if (!scope) return usage(JCH_FUNCTIONAL_REVIEW_USAGE, runtime);
			return { prompt: JCH_FUNCTIONAL_REVIEW_PROMPT.replace("{{REVIEW_SCOPE}}", scope).trim() };
		},
	},
	{
		name: "jchfuncreviewfix",
		description: "JCH：审查高置信功能问题并在复核后修复",
		allowArgs: true,
		inlineHint: "<uncommitted|commit <ref>|repo>",
		subcommands: [
			{ name: "uncommitted", description: "Review 并修复当前未提交修改" },
			{ name: "commit", description: "Review 并修复指定 commit", usage: "<ref>" },
			{ name: "repo", description: "Review 并修复整个代码仓库" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "review-fix");
			if (!scope) return usage(JCH_FUNCTIONAL_REVIEW_FIX_USAGE, runtime);
			return { prompt: JCH_FUNCTIONAL_REVIEW_FIX_PROMPT.replace("{{REVIEW_SCOPE}}", scope).trim() };
		},
	},
	{
		name: "jchverify",
		description: "JCH：独立验证指定修改并报告是否可交付",
		allowArgs: true,
		inlineHint: "<uncommitted|commit <ref>|path <path>>",
		subcommands: [
			{ name: "uncommitted", description: "验证当前未提交修改" },
			{ name: "commit", description: "验证指定 commit", usage: "<ref>" },
			{ name: "path", description: "验证指定路径", usage: "<path>" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "read-only");
			if (!scope) return usage(JCH_VERIFY_USAGE, runtime);
			return { prompt: JCH_VERIFY_PROMPT.replace("{{VERIFY_SCOPE}}", scope).trim() };
		},
	},
	defineJchPromptCommand({
		name: "jchci",
		description: "JCH：只读检查当前分支与关联 PR 的 GitHub Actions",
		inlineHint: "[workflow 或关注点]",
		prompt: `只读检查当前 Git 分支及其关联 PR 的 GitHub Actions 状态。确认当前分支、upstream、本地 HEAD 和 upstream branch；从 upstream remote URL 解析起始 GitHub 仓库，关联 PR 只有在 GitHub 元数据能确认 head repo/branch 匹配时才纳入，NEVER 猜测其他 remote。查询相关 workflow 的最新 run；区分 queued/in_progress、当前有效失败、已被同一目标 ref 与可比 event 的更新成功覆盖的旧失败。读取有效失败的 workflow、event、head SHA、run URL、job、step 和日志；startup_failure 没有 job/log 时读取 run 级错误。核对 run 对应代码：push/workflow_dispatch 使用 head SHA，pull_request 允许 merge SHA但必须解析 PR head SHA。全程不修改文件，不 rerun、dispatch、cancel、commit 或 push。最终报告分支/PR、HEAD 关系、有效 run、失败证据及最小下一步；参数只缩小 workflow 或关注点。`,
	}),
	defineJchPromptCommand({
		name: "jchcifix",
		description: "JCH：修复、提交并推送当前分支 CI，最多验证三轮",
		inlineHint: "[workflow=<name> 或关注点]",
		prompt: `修复当前分支 upstream 所属 GitHub 仓库中与当前分支相关的最新有效 GitHub Actions 失败。先运行 git fetch --all，确认当前分支、upstream、upstream remote/branch 和工作区；从 upstream remote URL 解析唯一目标 owner/repo，NEVER 用其他 remote 猜测。参数可缩小 workflow，但不得改为其他 branch。目标结论仅限 failure、timed_out、startup_failure；cancelled、skipped 和未完成 run 不是失败目标。只有同一 workflow、同一目标 ref、可比 event 且验证失败代码后继版本的更新成功 run 才能覆盖旧失败。

读取目标 run 的 workflow、event、branch、head SHA、run URL、失败 job/step/log；startup_failure 没有 job/log 时分析 run 级错误。push 事件核对失败 SHA 与当前分支历史；pull_request 事件允许 merge SHA，但 MUST 解析 PR head branch/SHA。结合对应源码、workflow 和调用方定位根因，只修改本次 CI 根因需要的文件并保留无关本地修改；执行直接本地验证和全部项目强制检查。

提交前检查 index、ahead/behind 和待提交 diff，只提交本次修复；准确提交并普通 push 当前分支，NEVER force-push、merge、rebase 或改写历史。优先等待该 push 自然产生的新 run。不会触发时，仅当同一 workflow 定义 workflow_dispatch 才运行 gh workflow run，并 MUST 使用 --ref 指向已推送的 upstream branch；只传已定义且可可靠确定的 inputs。捕获命令返回的 run URL/ID；无返回 ID 时，按 workflow、workflow_dispatch、ref、head SHA 和触发时间唯一定位，无法唯一确定则停止。

验证 run 必须对应刚推送的代码：push/workflow_dispatch 的 head SHA 等于 pushed HEAD；pull_request run 可使用 merge SHA，但 PR head SHA必须等于 pushed HEAD。失败则读取新日志继续最小修复、提交、push 和验证，总计最多 3 轮；第 3 轮仍失败时停止并报告证据和尝试。不要修改其他仓库、删除或回滚无关修改。`,
	}),
	{
		name: "jchcatchup",
		description: "JCH：快速摘要工作现场；full 深度恢复",
		allowArgs: true,
		subcommands: [{ name: "full", description: "通过代理深度恢复工作现场", usage: "[路径、提交范围或关注点]" }],
		async handle(command, runtime) {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) return handleQuickGitSummary(runtime);
			if (verb !== "full") return usage(JCH_CATCHUP_USAGE, runtime);
			const focus = rest ? `\n\nFull 模式关注点如下；只缩小路径、提交范围或关注点，不改变只读性质：\n${rest}` : "";
			return { prompt: `${JCH_CATCHUP_FULL_PROMPT}${focus}` };
		},
	},
];
