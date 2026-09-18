/**
 * `/team` per-run task prompt construction.
 *
 * Every prompt starts with an ASCII stage marker (`[team-stage:…]`) so
 * transcripts, stub runners, and smoke-test HTTP stubs can route on them
 * deterministically. The review prompt builder deliberately takes no author
 * identity: anonymity is structural, not best-effort.
 */
import type { TeamAlignmentOutput, TeamDisposition, TeamProposalRecord, TeamReviewOutput } from "./types";

function section(title: string, body: string): string {
	const trimmed = body.trim();
	return `## ${title}\n\n${trimmed.length > 0 ? trimmed : "（无）"}\n`;
}

function bulletList(items: readonly string[]): string {
	if (items.length === 0) return "（无）";
	return items.map(item => `- ${item}`).join("\n");
}

/** Shared preamble: the user's question and the read-only investigation entry points. */
function commonContext(question: string, cwd: string): string {
	return [
		section("用户问题（原始，一字不改）", question),
		section("工作目录", cwd),
		[
			"## 资料入口\n",
			"- 用户问题中提到的需求文档与说明（文件不存在或位置不明时，如实记录，MUST NOT 编造内容）。",
			"- `wiki` 工具：检索公司内部 wiki 的规范、历史方案和接口约定。",
			"- `read` / `grep` / `glob` / `ast_grep`：阅读代码、接口定义和调用关系。",
			"- 未检索到资料不代表公司没有相关规定；历史文档不自动代表当前有效规范。\n",
		].join("\n"),
	].join("\n");
}

export function buildProposalTask(args: { question: string; cwd: string }): string {
	return [
		"[team-stage:proposal]",
		"",
		"# 多模型方案讨论 · 阶段一：独立调查与提案",
		"",
		commonContext(args.question, args.cwd),
		"## 你的任务\n",
		"你是一名独立提案者。基于一手资料形成自己的判断，独立完成：\n",
		"1. 阅读用户指定的需求文档及相关用户说明。",
		"2. 检索公司内部 wiki，查找与任务相关的规范、历史方案和接口约定。",
		"3. 阅读相关代码、接口定义和调用关系，确认现有行为与影响范围。",
		"4. 提出方案或诊断结论，说明依据、关键假设、主要风险及验收建议。",
		"5. 显式记录自己对需求歧义的理解与假设（哪些需求点存在多种解读、本方案采用哪一种）。\n",
		"## 输出纪律\n",
		"- 初稿必须区分事实、推断和假设；证据给出可回查的位置。",
		"- 没有足够依据时，可以报告未形成可行方案（noViableProposal=true），MUST NOT 虚构接口、规范或代码行为。",
		"- 方案全文 ≤ 4000 字；不输出详细实现代码。",
		"- 不要假设其他模型的存在或输出；你看到的就是全部输入。\n",
	].join("\n");
}

export function buildAlignmentTask(args: {
	question: string;
	cwd: string;
	proposals: readonly TeamProposalRecord[];
}): string {
	const proposalBlocks = args.proposals
		.map(record => {
			const proposal = record.latestProposal;
			if (!proposal) return "";
			return [
				`### 方案 ${record.label}${proposal.noViableProposal ? "（提案者声明：未形成可行方案）" : ""}\n`,
				proposal.proposal,
				"",
				`关键假设：\n${bulletList(proposal.keyAssumptions.map(a => `${a.content}（${a.status}；依据：${a.basis}）`))}`,
				`验收建议：\n${bulletList(proposal.acceptanceCriteria)}`,
				`歧义理解：\n${bulletList(proposal.ambiguityInterpretations.map(a => `${a.ambiguity} → 采用：${a.interpretation}`))}`,
				`证据：\n${bulletList(proposal.evidence.map(e => `${e.claim}（${e.source}）`))}`,
			].join("\n");
		})
		.filter(block => block.length > 0)
		.join("\n\n");

	return [
		"[team-stage:alignment]",
		"",
		"# 多模型方案讨论 · 阶段二：对齐与比较",
		"",
		commonContext(args.question, args.cwd),
		section("全部提案（原始稿）", proposalBlocks),
		[
			"## 你的任务\n",
			"你是对齐阶段的分析调用。比较上述提案，结构化输出：\n",
			"1. 统一的需求理解（可查清部分）与共同验收标准。各提案的验收建议用于发现遗漏，",
			"   但不能各自定义一套较容易满足的标准。",
			"2. 事实差异清单：各提案在接口存在性、规范适用性等事实上的矛盾，标注需回查的来源位置。",
			"3. 需求理解差异清单：无法通过现有资料查清的歧义，列出不同理解及其对方案与验收的影响，",
			"   并标注是否实质影响方案选择（affectsChoice）。\n",
			"## 约束\n",
			"- 本阶段不向用户提问、不中断流程；不需要产出最终方案。",
			"- 事实差异靠回查来源确认，查不清的标为未知，不靠辩论决定真假。",
			"- 相似方案可以归类，但保留原稿依据与重要差异。\n",
		].join("\n"),
	].join("\n");
}

/**
 * Build the anonymous review prompt. Structurally authorless: the arguments
 * carry no proposer identity, so the rendered text cannot leak it.
 */
export function buildReviewTask(args: {
	question: string;
	cwd: string;
	alignment: TeamAlignmentOutput;
	targetLabel: string;
	proposalText: string;
	keyAssumptions: readonly { content: string; basis: string; status: string }[];
	round: number;
	recheck: boolean;
	unresolvedBlocking?: readonly string[];
}): string {
	const header = args.recheck
		? `# 多模型方案讨论 · 复核（第 ${args.round} 轮修订后）`
		: `# 多模型方案讨论 · 阶段三：交叉审查`;
	const target = `方案 ${args.targetLabel}`;
	const task = args.recheck
		? [
				"## 你的任务\n",
				"你是一名新的审查子代理，复核该方案本轮修订中受影响的部分：\n",
				"1. 判断此前未解决的阻断问题现在是否真正解决（priorBlockingStatus）。",
				"2. 检查修订是否引入新的错误或新的阻断/重要问题。",
				"3. 只复核受影响部分；作者自述不作为结论，未解决就是未解决。\n",
			]
		: [
				"## 你的任务\n",
				`你是一名审查子代理，独立审查${target}。审查重点：\n`,
				"1. 是否误读或遗漏用户需求、适用规范和必须保持的行为。",
				"2. 对接口、代码、调用关系的判断是否有事实错误。",
				"3. 哪些关键假设一旦不成立，就会使方案失败。",
				"4. 是否存在影响正确性、兼容性或可实施性的实质风险。",
				"5. 方案是否能够满足共同验收标准。\n",
				"## 审查纪律\n",
				"- 每条反驳必须说明具体问题、影响及依据，并区分 blocking / important / minor。",
				"- 已有事实提供可回查的资料位置；新设计可用明确的逻辑推导或反例，MUST NOT 冒充已运行的验证结果。",
				"- 允许返回“未发现实质问题”（noSubstantiveIssues=true）；没有发现问题不等于证明方案绝对正确。",
				"- 即使所有提案方向一致，也要审查其共同前提；不能以“大家一致”代替审查。\n",
			];

	return [
		`[team-stage:review target=${args.targetLabel} round=${args.round}${args.recheck ? " recheck" : ""}]`,
		"",
		header,
		"",
		commonContext(args.question, args.cwd),
		section(
			"统一的需求理解与共同验收标准",
			`${args.alignment.unifiedUnderstanding}\n\n验收标准：\n${bulletList(args.alignment.acceptanceCriteria)}`,
		),
		section(`待审方案（${target}）`, args.proposalText),
		section(
			"该方案的关键假设",
			bulletList(args.keyAssumptions.map(a => `${a.content}（${a.status}；依据：${a.basis}）`)),
		),
		section(
			"事实差异清单（供回查）",
			bulletList(
				args.alignment.factDifferences.map(d => `${d.topic}：${d.contradiction}（回查：${d.sourceToCheck}）`),
			),
		),
		args.recheck && args.unresolvedBlocking?.length
			? section("此前未解决的阻断问题", bulletList(args.unresolvedBlocking))
			: "",
		task.join("\n"),
	]
		.filter(block => block.length > 0)
		.join("\n");
}

export function buildRevisionTask(args: {
	question: string;
	cwd: string;
	targetLabel: string;
	round: number;
	proposalText: string;
	review: TeamReviewOutput;
	unresolvedBlocking: readonly string[];
}): string {
	const findings = args.review.findings.length
		? args.review.findings
				.map(
					f =>
						`- [${f.severity}] ${f.issue}\n  - 影响：${f.impact}\n  - 依据：${f.evidence}\n  - 针对部分：${f.targetAspect}`,
				)
				.join("\n")
		: "（无）";

	return [
		`[team-stage:revision target=${args.targetLabel} round=${args.round}]`,
		"",
		`# 多模型方案讨论 · 阶段四：修订与回应（第 ${args.round} 轮）`,
		"",
		commonContext(args.question, args.cwd),
		section(`你的方案（方案 ${args.targetLabel}，当前版）`, args.proposalText),
		section("审查意见（逐项回应）", findings),
		args.unresolvedBlocking.length > 0 ? section("此前仍未解决的阻断问题", bulletList(args.unresolvedBlocking)) : "",
		[
			"## 你的任务\n",
			`你是方案 ${args.targetLabel} 的提案模型，逐项回应审查意见：\n`,
			"- 接受并修订（accepted-and-revised）；或",
			"- 举证说明不接受（rejected-with-evidence）；或",
			"- 保留为真实取舍（genuine-tradeoff）；或",
			"- 说明仍无法解决（unresolved）。\n",
			"## 约束\n",
			"- 对不成立的质疑，不要求修改原本正确的方案；不能只回复“已解决”，不能降低验收标准绕过问题。",
			"- “修订方案”指修改讨论中的方案内容，不是修改项目文件。",
			"- reviewFlags 如实填写：修改了核心设计/接口/数据/兼容策略、声称解决了阻断或严重问题、",
			"  新证据改变关键假设或需求理解、举证反驳了阻断或重要问题——任一为真都会触发新的审查子代理复核。",
			"- 仍有阻断问题未解决时，本轮结束后最多还有一轮修订机会（总共两轮）。\n",
		].join("\n"),
	]
		.filter(block => block.length > 0)
		.join("\n");
}

const DISPOSITION_LABELS: Record<TeamDisposition, string> = {
	"accepted-and-revised": "接受并修订",
	"rejected-with-evidence": "举证不接受",
	"genuine-tradeoff": "保留为真实取舍",
	unresolved: "仍无法解决",
};

/**
 * Full review-processing narrative for the synthesis stage (§2.5: the
 * synthesis input includes "审查处理结果"): initial findings with their
 * evidence, the proposer's per-finding responses, and every recheck's
 * conclusion. Without this the synthesis call would judge "resolved" claims
 * it can never see.
 */
function reviewProcessingLines(record: TeamProposalRecord): string[] {
	const lines: string[] = [];
	const initial = record.reviews[0];
	if (initial) {
		if (initial.findings.length === 0) {
			lines.push("初次审查：未发现实质问题。");
		} else {
			lines.push("初次审查意见：");
			for (const [index, finding] of initial.findings.entries()) {
				lines.push(
					`${index + 1}. [${finding.severity}] ${finding.issue}（影响：${finding.impact}；依据：${finding.evidence}）`,
				);
			}
		}
	}
	if (record.revision) {
		lines.push("修订者逐项回应：");
		if (record.revision.responses.length === 0) {
			lines.push("（未提供逐项回应）");
		}
		for (const response of record.revision.responses) {
			lines.push(
				`- 针对“${response.finding}”：${DISPOSITION_LABELS[response.disposition]} — ${response.explanation}`,
			);
		}
	}
	for (const [index, recheck] of record.reviews.slice(1).entries()) {
		const verdict =
			recheck.priorBlockingStatus === "not-applicable"
				? "（未报告）"
				: `此前阻断问题 ${recheck.priorBlockingStatus}`;
		const news = recheck.noSubstantiveIssues
			? "未发现新实质问题"
			: `新发现：${recheck.findings.map(finding => `[${finding.severity}] ${finding.issue}`).join("；")}`;
		lines.push(`复核 ${index + 1}：${verdict}；${news}。`);
	}
	return lines;
}

export function buildSynthesisTask(args: {
	question: string;
	cwd: string;
	alignment: TeamAlignmentOutput;
	proposals: readonly TeamProposalRecord[];
}): string {
	const blocks = args.proposals
		.map(record => {
			const latest = record.latestProposal;
			if (!latest) return "";
			const lines = [
				`### 方案 ${record.label}${record.excludedFromOptions ? `（结构化追踪：尚不可采用 — ${record.exclusionReason ?? ""}）` : ""}\n`,
				latest.proposal,
				"",
			];
			if (latest.noViableProposal) {
				lines.push("提案者声明：依据不足，未形成可行方案（见正文中的缺口说明）。\n");
			}
			if (record.revision) {
				lines.push(`修订说明（第 ${record.roundsUsed} 轮）：${record.revision.revisionSummary}\n`);
			}
			const processing = reviewProcessingLines(record);
			if (processing.length > 0) {
				lines.push(`审查意见与处理结果：\n${processing.join("\n")}\n`);
			}
			if (record.unresolvedBlocking.length > 0) {
				lines.push(`未解决的阻断问题（机械标注，该方案尚不可采用）：\n${bulletList(record.unresolvedBlocking)}\n`);
			}
			if (record.proposerFailed || record.reviewFailed || record.revisionFailed || record.recheckFailed) {
				lines.push(
					`参与不完整：${[
						record.proposerFailed ? "提案失败" : "",
						record.reviewFailed ? "审查失败" : "",
						record.recheckFailed ? "复核失败" : "",
						record.revisionFailed ? "修订失败" : "",
					]
						.filter(Boolean)
						.join("、")}\n`,
				);
			}
			return lines.join("\n");
		})
		.filter(block => block.length > 0)
		.join("\n\n");

	return [
		"[team-stage:synthesis]",
		"",
		"# 多模型方案讨论 · 阶段五：汇总方案",
		"",
		commonContext(args.question, args.cwd),
		section(
			"统一的需求理解与共同验收标准",
			`${args.alignment.unifiedUnderstanding}\n\n验收标准：\n${bulletList(args.alignment.acceptanceCriteria)}`,
		),
		section(
			"事实差异清单",
			bulletList(
				args.alignment.factDifferences.map(d => `${d.topic}：${d.contradiction}（回查：${d.sourceToCheck}）`),
			),
		),
		section(
			"需求理解差异清单",
			bulletList(
				args.alignment.interpretationDifferences.map(
					d =>
						`${d.ambiguity}${d.affectsChoice ? "（实质影响选择）" : ""}：${d.interpretations.map(i => i.view).join(" / ")}`,
				),
			),
		),
		section("全部最新提案（含修订与审查处理结果）", blocks),
		[
			"## 你的任务\n",
			"你是综合阶段的子调用，产出用户据以作出选择的最终报告。先核实关键证据、检查硬约束，再比较真实取舍：\n",
			"- 硬约束来自用户明确要求、确认适用的强制规范、必须保持的兼容约定和共同验收标准。",
			"- 违反硬约束或仍有未解决阻断问题的方案，代码会机械标注“尚不可采用”——你不需要、也不得自行给出该判定或推翻它。",
			"- 通过硬约束后，再比较风险、复杂度、修改范围、兼容性、维护负担和可验证性；比较必须说明理由，",
			"  不采用多数票，不能用低工作量抵消正确性缺陷。",
			"- 只能汇总经过审查的方案；MUST NOT 拼接多个候选生成未经审查的新设计再称其已通过。",
			"- 最终方案数量不固定：有一个就输出一个；多个实质不同且有选择价值时分别输出；没有可采用方案时明确说明原因。",
			"- 有明确优势时填 recommendedProposal（标签）+ 理由与前提；没有明确优选时留空，直接说明取舍条件。",
			"- 报告正文不要包含“【推荐】”标记——推荐行由代码生成；理解差异中实质影响选择的会在结果置顶提示。",
			"- MUST NOT 为多样性制造备选，MUST NOT 虚构尚未实测的性能提升。\n",
		].join("\n"),
	].join("\n");
}
