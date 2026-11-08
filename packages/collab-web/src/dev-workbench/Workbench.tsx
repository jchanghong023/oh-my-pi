import { ArrowRight, Boxes, Check, Copy, Download, FileText, Lock, Menu, Plus, RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
	DevActionIntent,
	DevActionPreview,
	DevActionResult,
	DevGitTarget,
	DevMaterialRef,
	DevRequirementSnapshot,
	DevStage,
	SpecCandidate,
} from "../../../coding-agent/src/spec-driven/types";
import { Markdown } from "../components/transcript/Markdown";
import { PredictiveTextarea, TextPredictionContext } from "../components/shell/PredictiveTextarea";
import { WorkbenchClient } from "./client";
import type { OperationConfirmation } from "./client";
import { DevConversation } from "./Conversation";

export const STAGES: readonly { id: DevStage; label: string }[] = [
	{ id: "business", label: "业务需求" },
	{ id: "requirements", label: "开发需求" },
	{ id: "solution", label: "技术方案" },
	{ id: "planning", label: "开发计划" },
	{ id: "executing", label: "开发与 UT" },
	{ id: "st", label: "ST 测试" },
	{ id: "pr", label: "提交与 PR" },
	{ id: "testing", label: "测试人员测试" },
];
const MATERIAL_KINDS: Record<DevStage, readonly DevMaterialRef["kind"][]> = {
	business: ["business"],
	requirements: ["proposal", "delta"],
	solution: ["solution"],
	planning: ["plan"],
	executing: ["report"],
	st: ["report"],
	pr: [],
	testing: [],
};
const MATERIAL_LABELS: Record<DevMaterialRef["kind"], string> = {
	business: "业务需求文档",
	proposal: "需求提案",
	delta: "开发需求规格",
	solution: "方案候选",
	plan: "开发计划",
	report: "完成报告",
};
const TESTING_LABELS = {
	"not-started": "待测试",
	"in-progress": "测试中",
	failed: "测试未通过",
	"retest-pending": "待复测",
	tested: "已测试",
};
const EXECUTION_LABELS = {
	idle: "Agent 空闲",
	running: "Agent 执行中",
	waiting: "Agent 待确认",
	stopping: "Agent 停止中",
	interrupted: "Agent 已中断",
	failed: "Agent 执行失败",
};
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function stageLabel(stage: DevStage): string {
	return STAGES.find(item => item.id === stage)?.label ?? stage;
}
function requirementStatus(snapshot: DevRequirementSnapshot): string {
	const { record } = snapshot;
	if (record.lifecycle === "completed") return "已完成";
	if (record.lifecycle === "cancelled") return "已停止";
	if (record.lifecycle === "cancelling") return "撤销结清中";
	if (record.stage === "testing") return TESTING_LABELS[record.testing];
	if (record.stage === "pr" && record.marks["pr-submitted"]) return "已开发 · 待合入";
	if (snapshot.runtime?.execution === "failed" || snapshot.runtime?.execution === "interrupted") return "工作已停止";
	if (snapshot.runtime?.execution === "running") return "处理中";
	if (snapshot.runtime?.execution === "stopping") return "停止结清中";
	if (snapshot.runtime?.execution === "waiting") return "待确认";
	if (record.stage === "pr") return "待提交";
	if (record.stage === "st") return "待开发人员确认";
	return record.materials.some(material => MATERIAL_KINDS[record.stage].includes(material.kind)) ? "待确认" : "未开始";
}
function requirementGroup(snapshot: DevRequirementSnapshot): "active" | "testing" | "completed" | "stopped" {
	if (snapshot.record.lifecycle === "completed") return "completed";
	if (snapshot.record.lifecycle !== "active") return "stopped";
	return snapshot.record.stage === "testing" ? "testing" : "active";
}

const STAGE_CONTEXT: Record<DevStage, string> = {
	business: "确认业务目标、输入范围与验收预期，检查文档模板后进入开发需求。",
	requirements: "确认需求范围与验收场景，再进入技术方案。",
	solution: "确认所选方案。选择与查看本身不会推进阶段。",
	planning: "确认计划后开始开发与 UT，不会自动提交 Git。",
	executing: "确认实际开发记录与 UT 结果，进入开发人员 ST 测试。",
	st: "如实保留失败与未执行项；由开发人员确认 ST 完成，并确认提交与推送。",
	pr: "提交与合入分别确认；PR 合入后进入独立测试。",
	testing: "测试结论由人员标记；发现代码问题时关联新的修复需求。",
};

interface LoadedMaterial {
	requirementId: string;
	materialId: string;
	sourceVersion: string;
	content: string;
}

function useModalFocus<T extends HTMLElement>(
	open = true,
	returnFocus?: HTMLElement | null,
	initialFocus: "first" | "dialog" = "first",
) {
	const modal = useRef<T>(null);
	useEffect(() => {
		const dialog = modal.current;
		if (!open || !dialog) return;
		const previousFocus =
			returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		const focusable = (): HTMLElement[] =>
			Array.from(
				dialog.querySelectorAll<HTMLElement>(
					'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
				),
			).filter(
				element =>
					element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.getClientRects().length > 0,
			);
		const focusFirst = (): void => {
			(focusable()[0] ?? dialog).focus();
		};
		const keepFocus = (event: FocusEvent): void => {
			if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
		};
		const trapTab = (event: KeyboardEvent): void => {
			if (event.key !== "Tab" && event.keyCode !== 9) return;
			const controls = focusable();
			const first = controls[0];
			const last = controls[controls.length - 1];
			const focused = document.activeElement;
			if (!first || !last) {
				event.preventDefault();
				dialog.focus();
			} else if (
				!dialog.contains(focused) ||
				focused === dialog ||
				(event.shiftKey ? focused === first : focused === last)
			) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			}
		};
		document.addEventListener("keydown", trapTab, true);
		document.addEventListener("focus", keepFocus, true);
		if (initialFocus === "dialog") dialog.focus();
		else focusFirst();
		return () => {
			document.removeEventListener("keydown", trapTab, true);
			document.removeEventListener("focus", keepFocus, true);
			if (
				previousFocus &&
				previousFocus !== document.body &&
				previousFocus !== document.documentElement &&
				document.body.contains(previousFocus) &&
				!previousFocus.hasAttribute("disabled") &&
				previousFocus.getClientRects().length > 0
			) {
				previousFocus.focus();
			} else {
				document.querySelector<HTMLElement>('.dw-workbench [data-action="new"]:not([disabled])')?.focus();
			}
		};
	}, [open, returnFocus, initialFocus]);
	return modal;
}

function DocumentTools({
	text,
	downloadUrl,
	notice = "只读",
}: {
	text: string | null;
	downloadUrl?: string;
	notice?: string;
}): ReactNode {
	const [copied, setCopied] = useState(false);
	const [manualCopy, setManualCopy] = useState(false);
	const manualCopyModal = useModalFocus<HTMLElement>(manualCopy && text !== null);
	const copyButton = useRef<HTMLButtonElement>(null);
	const copyRequest = useRef(0);
	useEffect(() => {
		setCopied(false);
		setManualCopy(false);
		return () => {
			copyRequest.current += 1;
		};
	}, [text]);
	const copy = async (): Promise<void> => {
		if (text === null) return;
		const request = ++copyRequest.current;
		try {
			await navigator.clipboard.writeText(text);
			if (request === copyRequest.current) setCopied(true);
			return;
		} catch {
			if (request !== copyRequest.current) return;
			setManualCopy(true);
		}
	};
	const closeManualCopy = (): void => {
		setManualCopy(false);
		copyButton.current?.focus();
	};
	return (
		<div className="dw-document-tools">
			<span className="dw-read-only">
				<Lock className="dw-icon" size={14} aria-hidden="true" />
				{notice}
			</span>
			<button
				ref={copyButton}
				type="button"
				className="dw-icon-button"
				aria-label={copied ? "文档已复制" : "复制文档"}
				title={text === null ? "当前没有可复制的材料" : copied ? "文档已复制" : "复制文档"}
				disabled={text === null}
				onClick={() => void copy()}
			>
				{copied ? (
					<Check className="dw-icon" size={17} aria-hidden="true" />
				) : (
					<Copy className="dw-icon" size={17} aria-hidden="true" />
				)}
			</button>
			{downloadUrl ? (
				<a className="dw-icon-button" href={downloadUrl} download aria-label="下载原件" title="下载原件">
					<Download className="dw-icon" size={17} aria-hidden="true" />
				</a>
			) : (
				<button
					type="button"
					className="dw-icon-button"
					disabled
					aria-label="下载原件"
					title="当前没有可下载的材料"
				>
					<Download className="dw-icon" size={17} aria-hidden="true" />
				</button>
			)}
			<span className="dw-sr-only" role="status">
				{copied ? "文档已复制" : ""}
			</span>
			{manualCopy && text !== null && (
				<div className="dw-modal-backdrop">
					<section
						ref={manualCopyModal}
						tabIndex={-1}
						className="dw-modal"
						role="dialog"
						aria-modal="true"
						aria-label="手动复制文档"
						onKeyDown={event => {
							if (event.key === "Escape") {
								event.stopPropagation();
								closeManualCopy();
							}
						}}
					>
						<h2>复制文档</h2>
						<p>浏览器未允许自动复制，请选中以下原文并复制。</p>
						<textarea
							aria-label="当前材料原文"
							readOnly
							value={text}
							rows={12}
							onFocus={event => event.currentTarget.select()}
						/>
						<button type="button" onClick={closeManualCopy}>
							关闭
						</button>
					</section>
				</div>
			)}
		</div>
	);
}

function titleFromText(text: string): string {
	const heading = /^#\s+(?:业务需求[：:]\s*)?(.+)$/m.exec(text)?.[1];
	return (heading ?? text.trim().split(/\r?\n/, 1)[0] ?? "").trim().slice(0, 80);
}
function savedConfirmation(): OperationConfirmation | null {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem("omp.dev.confirmation") ?? "null");
		if (
			value &&
			typeof value === "object" &&
			"operationId" in value &&
			typeof value.operationId === "string" &&
			"confirmationToken" in value &&
			typeof value.confirmationToken === "string" &&
			"userReply" in value &&
			typeof value.userReply === "string"
		)
			return {
				operationId: value.operationId,
				confirmationToken: value.confirmationToken,
				userReply: value.userReply,
			};
	} catch {}
	return null;
}
function incompleteResult(result: DevActionResult | null): boolean {
	if (!result) return true;
	const persistence = result.persistence;
	return (
		Boolean(persistence.error) ||
		persistence.save === "failed" ||
		persistence.save === "unknown" ||
		persistence.commit.status === "failed" ||
		persistence.commit.status === "unknown" ||
		(persistence.commit.status === "succeeded" && !persistence.commit.indexReconciled) ||
		persistence.push.status === "failed" ||
		persistence.push.status === "unknown"
	);
}

export function StageNavigation({
	snapshot,
	viewed,
	onView,
}: {
	snapshot: DevRequirementSnapshot;
	viewed: DevStage;
	onView(stage: DevStage): void;
}): ReactNode {
	const commitDecisions = new Set(
		snapshot.record.gitOperations
			.filter(operation => operation.kind === "commit")
			.map(operation => operation.operationId),
	);
	const approved = new Set(
		snapshot.record.decisions
			.filter(decision => !commitDecisions.has(decision.operationId))
			.map(decision => decision.stage),
	);
	const markForStage = { st: "st-complete", pr: "pr-merged", testing: "tested" } as const;
	return (
		<nav className="dw-stages" data-testid="stages" aria-label="查看阶段">
			{STAGES.map((stage, index) => {
				const mark =
					stage.id in markForStage
						? snapshot.record.marks[markForStage[stage.id as keyof typeof markForStage]]
						: undefined;
				const confirmed = index < 5 ? approved.has(stage.id) : Boolean(mark);
				const current = snapshot.record.stage === stage.id;
				const status = current
					? snapshot.record.lifecycle === "active"
						? "当前执行"
						: requirementStatus(snapshot)
					: confirmed
						? "已确认"
						: snapshot.record.materials.some(material => MATERIAL_KINDS[stage.id].includes(material.kind))
							? "材料可查看"
							: "未开始";
				return (
					<button
						type="button"
						className="dw-stage"
						key={stage.id}
						data-stage={stage.id}
						data-confirmed={confirmed}
						aria-pressed={viewed === stage.id}
						aria-current={current ? "step" : undefined}
						onClick={() => onView(stage.id)}
					>
						<span className="dw-stage-mark">{confirmed ? "✓" : String(index + 1).padStart(2, "0")}</span>
						<span className="dw-stage-name">{stage.label}</span>
						<small>{status}</small>
					</button>
				);
			})}
		</nav>
	);
}

export function SolutionMaterial({
	text,
	selected,
	onSelect,
}: {
	text: string;
	selected?: string;
	onSelect?(id: string): void;
}): ReactNode {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return <div role="alert">方案材料无法读取，请通过会话修正原文件后重新查看。</div>;
	}
	if (!value || typeof value !== "object" || !("candidates" in value) || !Array.isArray(value.candidates))
		return <div role="alert">方案材料缺少候选列表，请通过会话补齐。</div>;
	const candidates: SpecCandidate[] = [];
	for (const item of value.candidates) {
		if (
			item &&
			typeof item === "object" &&
			"id" in item &&
			typeof item.id === "string" &&
			"title" in item &&
			typeof item.title === "string" &&
			"content" in item &&
			typeof item.content === "string"
		)
			candidates.push({ id: item.id, title: item.title, content: item.content });
	}
	const recommended =
		"recommendedCandidateId" in value ? candidates.find(item => item.id === value.recommendedCandidateId) : undefined;
	return (
		<section>
			{recommended && (
				<p>
					推荐方案：<strong>{recommended.title}</strong> · 推荐不代表已选择或批准
				</p>
			)}
			{Object.entries(value)
				.filter(
					([key, field]) => key !== "recommendedCandidateId" && key !== "candidates" && typeof field === "string",
				)
				.map(([key, field]) => (
					<section key={key}>
						<Markdown text={String(field)} />
					</section>
				))}
			{candidates.map(candidate => (
				<article className="dw-candidate" key={candidate.id} data-candidate-id={candidate.id}>
					<h3>
						{candidate.title}
						{selected === candidate.id ? "（已选）" : ""}
					</h3>
					<Markdown text={candidate.content} />
					{onSelect && (
						<button type="button" onClick={() => onSelect(candidate.id)}>
							选择此方案 · {candidate.title}
						</button>
					)}
				</article>
			))}
			{candidates.length !== value.candidates.length && (
				<div role="alert">部分候选材料不完整，请通过会话修正原件。</div>
			)}
		</section>
	);
}

function Material({
	client,
	snapshot,
	material,
	candidate,
	onCandidate,
	onRead,
}: {
	client: WorkbenchClient;
	snapshot: DevRequirementSnapshot;
	material: DevMaterialRef;
	candidate?: string;
	onCandidate?(id: string, version: string): void;
	onRead(value: LoadedMaterial | null): void;
}): ReactNode {
	const [document, setDocument] = useState<{ content: string; version: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		setDocument(null);
		setError(null);
		onRead(null);
		void client.material(snapshot.record.requirementId, material.id).then(
			value => {
				if (active) {
					setDocument(value);
					onRead({
						requirementId: snapshot.record.requirementId,
						materialId: material.id,
						sourceVersion: material.version,
						content: value.content,
					});
				}
			},
			failure => {
				if (active) setError(reason(failure));
			},
		);
		return () => {
			active = false;
		};
	}, [client, snapshot.record.requirementId, material.id, material.version, onRead]);
	return (
		<article className="dw-material">
			{error ? (
				<div role="alert">材料不可读取：{error}</div>
			) : !document ? (
				<p role="status">正在读取实际材料…</p>
			) : material.kind === "solution" ? (
				<SolutionMaterial
					text={document.content}
					selected={candidate}
					onSelect={onCandidate ? id => onCandidate(id, document.version) : undefined}
				/>
			) : (
				<Markdown text={document.content} />
			)}
		</article>
	);
}

function actionLabel(intent: DevActionIntent): string {
	switch (intent.kind) {
		case "next":
			return "Next · 确认材料并继续";
		case "back":
			return "Back · 返回上一阶段";
		case "sync-archive":
			return "同步主规格并归档";
		case "commit":
			return "提交本需求代码与文档";
		case "cancel":
			return "删除需求并撤销所属变更";
		case "link-fix":
			return "关联修复需求";
		case "set-test-state":
			return TESTING_LABELS[intent.state];
		case "mark":
			return {
				"st-complete": "标记 ST 完成",
				"pr-submitted": "标记 PR 已提交",
				"pr-merged": "标记 PR 已合入",
				tested: "标记已测试",
			}[intent.mark];
	}
}

export function ActionConfirmation({
	snapshot,
	title,
	preview,
	pending,
	error,
	returnFocus,
	onCancel,
	onConfirm,
}: {
	snapshot: DevRequirementSnapshot;
	title?: string;
	preview: DevActionPreview;
	pending: boolean;
	error: string | null;
	returnFocus?: HTMLElement | null;
	onCancel(): void;
	onConfirm(reply: string): void;
}): ReactNode {
	const [reply, setReply] = useState("");
	const modal = useModalFocus<HTMLElement>(true, returnFocus, "dialog");
	const git = preview.git;
	const cancellation = git?.cancellation;
	const conflicts = cancellation?.conflicts ?? preview.cancelPlan?.conflicts ?? [];
	const needsGit = ["commit", "mark", "cancel", "set-test-state", "link-fix"].includes(preview.action.kind);
	const missingScope =
		(needsGit && !git) || (preview.action.kind === "cancel" && (!cancellation || !preview.cancelPlan));
	const index = STAGES.findIndex(stage => stage.id === snapshot.record.stage);
	const destination =
		preview.action.kind === "next"
			? STAGES[index + 1]?.label
			: preview.action.kind === "back"
				? STAGES[index - 1]?.label
				: preview.action.kind === "mark"
					? {
							"st-complete": "提交与 PR",
							"pr-submitted": "已开发 · 等待 PR 合入",
							"pr-merged": "测试人员测试",
							tested: "已完成 · 只读",
						}[preview.action.mark]
					: preview.action.kind === "set-test-state"
						? TESTING_LABELS[preview.action.state]
						: preview.action.kind === "cancel"
							? "撤销结清后停止"
							: "保留当前阶段";
	const label = actionLabel(preview.action);
	const paths = [
		...new Set([
			...(git?.paths ?? git?.files.map(file => file.path) ?? []),
			...preview.action.binding.files.map(file => file.path),
		]),
	];
	return (
		<div className="dw-modal-backdrop">
			<section
				ref={modal}
				tabIndex={-1}
				className="dw-modal"
				role="dialog"
				aria-modal="true"
				aria-label="确认需求操作"
			>
				<h2>{label}</h2>
				<p>需求：{title ?? snapshot.record.changeId}</p>
				<p>
					{requirementStatus(snapshot)} → {destination}
				</p>
				{preview.action.kind === "back" && <p>只相邻回退；保留已有文件和 Git 历史，相关确认需重新核对。</p>}
				{paths.length > 0 && (
					<>
						<h3>本次涉及文件</h3>
						<ul>
							{paths.map(path => (
								<li key={path}>{path}</li>
							))}
						</ul>
					</>
				)}
				{git ? (
					<>
						<h3>提交与推送目标</h3>
						<dl className="dw-facts">
							<dt>当前分支</dt>
							<dd>
								{git.target.sourceRepository} · {git.target.sourceRef}
							</dd>
							<dt>推送至</dt>
							<dd>
								{git.target.remote} · {git.target.remoteUrl} · {git.target.targetRef}
							</dd>
							<dt>PR 合入目标</dt>
							<dd>
								{git.target.baseRepository} · {git.target.baseRef}
							</dd>
							<dt>已有待发布提交</dt>
							<dd>{git.commitsToPublish.length} 个（包含祖先提交）</dd>
						</dl>
						<p className="dw-warning">
							本次只授权所列文件和目标，不强推、不直接推送主分支、不夹带其他需求。保存、提交和推送可能分别失败；重试只续办未完成部分。推送不代表
							PR 已合入。
						</p>
					</>
				) : (
					<p>本次不提交或推送 Git。</p>
				)}
				{preview.action.kind === "cancel" && (
					<section data-testid="cancellation-scope">
						<p className="dw-warning">
							将停止并结清本需求任务、关闭未合入 PR，并撤销本需求已提交、暂存和未暂存的代码与文档。保留无关修改及
							Git 历史；未全部结清不会释放开发名额。
						</p>
						<h3>撤销范围</h3>
						<ul>
							{[
								...new Set([
									...(cancellation?.materials ?? []),
									...(cancellation?.mainSpecs ?? []),
									...(cancellation?.archivePaths ?? []),
									...(preview.cancelPlan?.paths ?? []),
								]),
							].map(path => (
								<li key={path}>{path}</li>
							))}
						</ul>
						{preview.cancelPlan?.pr && <p>关联 PR 将按原生撤销流程关闭。</p>}
						{cancellation?.changes.map(change => (
							<p key={change.id}>
								{(change.paths ?? [change.path]).join(" → ")} ·{" "}
								{
									{
										committed: "已提交变更",
										staged: "暂存变更",
										unstaged: "未暂存变更",
										untracked: "新增文件",
									}[change.layer]
								}
							</p>
						))}
						{conflicts.length > 0 && (
							<div role="alert">
								<h3>请先处理以下冲突</h3>
								<ul>
									{conflicts.map((conflict, index) => (
										<li key={index}>
											{conflict.path}：{conflict.reason}
										</li>
									))}
								</ul>
							</div>
						)}
					</section>
				)}
				<label>
					补充决定说明（可选）
					<PredictiveTextarea
						data-testid="confirmation-reply"
						value={reply}
						disabled={pending}
						onChange={event => setReply(event.target.value)}
					/>
				</label>
				{error && <div role="alert">{error}</div>}
				{missingScope && <div role="alert">实际操作范围不完整，不能确认；请重新准备。</div>}
				<footer>
					<button type="button" disabled={pending} onClick={onCancel}>
						取消，不执行
					</button>
					<button
						type="button"
						data-testid="confirmation-submit"
						disabled={pending || conflicts.length > 0 || missingScope}
						onClick={() => onConfirm(reply.trim() ? reply : label)}
					>
						{label}
					</button>
				</footer>
			</section>
		</div>
	);
}

export function PersistenceResult({ result, onInspect }: { result: DevActionResult; onInspect(): void }): ReactNode {
	const labels: Record<string, string> = {
		succeeded: "已完成",
		failed: "失败",
		unknown: "结果待确认",
		"not-started": "未执行",
	};
	const status = (value: string): string => labels[value] ?? value;
	return (
		<section className="dw-result" role="status">
			<h3>操作结果</h3>
			<dl className="dw-facts">
				<dt>保存</dt>
				<dd data-result="save">{status(result.persistence.save)}</dd>
				<dt>提交</dt>
				<dd data-result="commit">
					{status(result.persistence.commit.status)}
					{result.persistence.commit.status === "succeeded" && !result.persistence.commit.indexReconciled
						? " · 暂存区待协调"
						: ""}
				</dd>
				<dt>推送</dt>
				<dd data-result="push">{status(result.persistence.push.status)}</dd>
			</dl>
			{result.persistence.error && <div role="alert">{result.persistence.error}</div>}
			{incompleteResult(result) && <p>已成功步骤保留；查询不重放操作，续办不会重复提交或推进。</p>}
			<button type="button" onClick={onInspect}>
				查询最新结果
			</button>
		</section>
	);
}

export function ScopeCommitRequest({
	snapshot,
	connected,
	pending,
	onRequest,
}: {
	snapshot: DevRequirementSnapshot | null;
	connected: boolean;
	pending: boolean;
	onRequest(): void;
}): ReactNode {
	if (!snapshot) return null;
	const action = snapshot.actions.find(item => item.id === "commit");
	return (
		<button
			type="button"
			data-action="commit"
			disabled={!action?.available || pending || !connected}
			title={action?.blockedReason}
			onClick={onRequest}
		>
			提交本需求代码与文档
		</button>
	);
}

function DeliveryFacts({ snapshot, testing }: { snapshot: DevRequirementSnapshot; testing: boolean }): ReactNode {
	const { record } = snapshot;
	const pr = record.pr;
	return (
		<article className="dw-material">
			<h2>{testing ? "测试人员测试" : "提交与 PR"}</h2>
			{testing ? (
				<>
					<p>PR 合入后由测试人员独立测试；修复合入不会自动标记已测试。</p>
					<h3>测试状态</h3>
					<p>{TESTING_LABELS[record.testing]}</p>
					{record.marks.tested && (
						<p>
							由 {record.marks.tested.actor.name} 于 {record.marks.tested.at} 标记已测试。
						</p>
					)}
				</>
			) : (
				<>
					<dl className="dw-facts">
						<dt>ST</dt>
						<dd>
							{record.marks["st-complete"]
								? `已由 ${record.marks["st-complete"].actor.name} 标记完成`
								: "尚未人工标记完成"}
						</dd>
						<dt>提交记录</dt>
						<dd>
							{record.gitOperations.length
								? `已记录 ${record.gitOperations.length} 次需求 Git 操作`
								: "尚无需求提交记录"}
						</dd>
						<dt>规格同步与归档</dt>
						<dd>
							{record.syncRevisions.some(item => item.progress.synced && item.archivedChangePath)
								? "已同步归档"
								: "尚待处理"}
						</dd>
						<dt>PR 人员标记</dt>
						<dd>
							{record.marks["pr-merged"]
								? "已合入"
								: record.marks["pr-submitted"]
									? "已提交 · 待合入"
									: "尚未标记提交"}
						</dd>
					</dl>
				</>
			)}
			<h3>PR 状态</h3>
			{pr ? (
				<>
					<p>
						<a href={pr.pr.url} target="_blank" rel="noreferrer">
							{pr.pr.repository} #{pr.pr.number}
						</a>{" "}
						· {{ open: "评审中", closed: "已关闭", merged: "已合入" }[pr.state]}
					</p>
					<p>
						{pr.pr.sourceRef} → {pr.pr.baseRef}
					</p>
					<small>最近查询：{pr.observedAt}；查询结果不代替人员标记。</small>
				</>
			) : (
				<p>尚无 PR 记录。</p>
			)}
			{record.relatedRequirementIds.length > 0 && (
				<>
					<h3>关联需求</h3>
					<ul>
						{record.relatedRequirementIds.map(id => (
							<li key={id}>{id}</li>
						))}
					</ul>
				</>
			)}
		</article>
	);
}

export function selectedSolutionCandidate(
	selection: { id: string; version: string } | undefined,
	solutionVersion: string | undefined,
): string | undefined {
	return selection?.version === solutionVersion ? selection?.id : undefined;
}

export function Workbench({ client: supplied }: { client?: WorkbenchClient }): ReactNode {
	const [client] = useState(() => supplied ?? new WorkbenchClient());
	const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [viewed, setViewed] = useState<DevStage>("business");
	const [mobilePane, setMobilePane] = useState<"materials" | "chat">("materials");
	const [navOpen, setNavOpen] = useState(false);
	const [secondaryOperationsFor, setSecondaryOperationsFor] = useState<string | null>(null);
	const conversationPanel = useRef<HTMLElement>(null);
	const [conversationFocus, setConversationFocus] = useState(0);
	const [visited, setVisited] = useState<readonly string[]>(["local"]);
	const [localMode, setLocalMode] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const operationFocus = useRef<HTMLElement | null>(null);
	const [newOpen, setNewOpen] = useState(false);
	const [source, setSource] = useState<"conversation" | "import" | "local">("conversation");
	const [request, setRequest] = useState("");
	const [relatedId, setRelatedId] = useState("");
	const [hostPath, setHostPath] = useState("");
	const [importOpen, setImportOpen] = useState(false);
	const [preview, setPreview] = useState<DevActionPreview | null>(null);
	const [previewSnapshot, setPreviewSnapshot] = useState<DevRequirementSnapshot | null>(null);
	const [result, setResult] = useState<DevActionResult | null>(null);
	const [operationId, setOperationId] = useState<string | null>(() => {
		try {
			return sessionStorage.getItem("omp.dev.operation");
		} catch {
			return null;
		}
	});
	const [confirmed, setConfirmed] = useState<OperationConfirmation | null>(savedConfirmation);
	const [candidate, setCandidate] = useState<Record<string, { id: string; version: string }>>({});
	const [targetChoice, setTargetChoice] = useState<{
		snapshot: DevRequirementSnapshot;
		intent: DevActionIntent;
		targets: DevGitTarget[];
	} | null>(null);
	const [localContent, setLocalContent] = useState<string | null>(null);
	const [titles, setTitles] = useState<Record<string, string>>({});
	const titleCache = useRef(new Map<string, { version: string; title: string }>());
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState("all");
	const [materialId, setMaterialId] = useState<string | null>(null);
	const [loadedMaterial, setLoadedMaterial] = useState<LoadedMaterial | null>(null);
	const [materialRead, setMaterialRead] = useState<{
		requirementId: string;
		stage: DevStage;
		materials: DevMaterialRef[];
		error: string | null;
	} | null>(null);
	const selected = state.requirements.find(item => item.record.requirementId === selectedId) ?? null;
	const newModal = useModalFocus<HTMLFormElement>(newOpen);
	const importModal = useModalFocus<HTMLElement>(Boolean(importOpen && selected));
	const targetModal = useModalFocus<HTMLElement>(Boolean(targetChoice), operationFocus.current);
	const secondaryOperationsKey = selected ? `${selected.record.requirementId}:${selected.record.stage}` : null;
	const secondaryOperationsOpen = secondaryOperationsFor !== null && secondaryOperationsFor === secondaryOperationsKey;
	const materialLifecycleNotice =
		selected?.record.lifecycle === "cancelling"
			? "材料撤销中"
			: selected?.record.lifecycle === "cancelled"
				? "材料已撤销"
				: null;
	const conversationKey = state.joined ? `guest:${state.joined.roomId}` : (selectedId ?? "local");
	const listing =
		!materialLifecycleNotice && materialRead?.requirementId === selectedId && materialRead.stage === viewed
			? materialRead
			: null;
	const currentMaterials = listing?.materials.filter(material => MATERIAL_KINDS[viewed].includes(material.kind)) ?? [];
	const material = currentMaterials.find(item => item.id === materialId) ?? currentMaterials[0];
	const materialText =
		!materialLifecycleNotice &&
		material &&
		loadedMaterial?.requirementId === selectedId &&
		loadedMaterial.materialId === material.id &&
		loadedMaterial.sourceVersion === material.version
			? loadedMaterial.content
			: null;
	const solutionMaterial = (
		materialRead?.requirementId === selectedId ? materialRead.materials : (selected?.record.materials ?? [])
	).find(item => item.kind === "solution");
	const selectedCandidate = selectedSolutionCandidate(
		selected ? candidate[selected.record.requirementId] : undefined,
		solutionMaterial?.version,
	);
	const title = (item: DevRequirementSnapshot): string =>
		titles[item.record.requirementId] ??
		`新建需求 · ${item.record.requirementId.replace(/^requirement[-_]/i, "").slice(0, 8)}`;
	const run = async (operation: () => Promise<void>): Promise<void> => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		try {
			await client.ready();
			await operation();
		} catch (failure) {
			setError(reason(failure));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	useEffect(() => {
		void client.connect();
		return () => client.close();
	}, [client]);
	useEffect(() => {
		setVisited(items => (items.includes(conversationKey) ? items : [...items, conversationKey]));
	}, [conversationKey]);
	useEffect(() => {
		if (!conversationFocus) return;
		const panel = conversationPanel.current;
		if (!panel) return;
		const editor = panel.querySelector<HTMLTextAreaElement>(
			".dw-session:not([hidden]) .dw-composer-wrap textarea:not([disabled]):not([readonly])",
		);
		(editor ?? panel).focus();
	}, [conversationFocus]);
	useEffect(() => {
		let active = true;
		void Promise.all(
			state.requirements.map(async item => {
				if (!active || item.record.lifecycle === "cancelling" || item.record.lifecycle === "cancelled") return;
				try {
					const materials = await client.materials(item.record.requirementId);
					if (!active) return;
					const business = materials.find(document => document.kind === "business");
					if (!business) return;
					const cached = titleCache.current.get(item.record.requirementId);
					if (cached?.version === business.version) {
						if (active && cached.title)
							setTitles(current =>
								current[item.record.requirementId] === cached.title
									? current
									: { ...current, [item.record.requirementId]: cached.title },
							);
						return;
					}
					const document = await client.material(item.record.requirementId, business.id);
					const name = titleFromText(document.content);
					if (active) {
						titleCache.current.set(item.record.requirementId, { version: document.version, title: name });
						if (name)
							setTitles(current =>
								current[item.record.requirementId] === name
									? current
									: { ...current, [item.record.requirementId]: name },
							);
					}
				} catch {
					/* Material errors are shown when the requirement is opened. */
				}
			}),
		);
		return () => {
			active = false;
		};
	}, [client, state.requirements, state.materialRefresh]);
	useEffect(() => {
		setMaterialId(null);
	}, [selectedId, viewed]);
	useEffect(() => {
		let active = true;
		// A native conversation refresh does not invalidate already read material bytes.
		if (!selectedId || !selected || materialLifecycleNotice) return;
		void client.materials(selectedId).then(
			materials => {
				if (!active) return;
				setMaterialRead({ requirementId: selectedId, stage: viewed, materials, error: null });
				setMaterialId(current =>
					current && materials.some(item => item.id === current && MATERIAL_KINDS[viewed].includes(item.kind))
						? current
						: null,
				);
				setCandidate(current => {
					const choice = current[selectedId];
					if (
						!choice ||
						selectedSolutionCandidate(choice, materials.find(item => item.kind === "solution")?.version)
					)
						return current;
					const next = { ...current };
					delete next[selectedId];
					return next;
				});
			},
			failure => {
				if (active)
					setMaterialRead({ requirementId: selectedId, stage: viewed, materials: [], error: reason(failure) });
			},
		);
		return () => {
			active = false;
		};
	}, [client, selectedId, selected, viewed, state.materialRefresh, materialLifecycleNotice]);
	const updateSelection = (snapshot: DevRequirementSnapshot | null): void => {
		const id = snapshot?.record.requirementId ?? null;
		setNavOpen(false);
		setSecondaryOperationsFor(null);
		setSelectedId(id);
		setViewed(snapshot?.record.stage ?? "business");
		setError(null);
		setImportOpen(false);
		setVisited(items => (items.includes(id ?? "local") ? items : [...items, id ?? "local"]));
	};
	const select = (snapshot: DevRequirementSnapshot | null): void => {
		updateSelection(snapshot);
		client.select(snapshot?.record.requirementId ?? null);
	};
	const showConversation = (): void => {
		setMobilePane("chat");
		setConversationFocus(current => current + 1);
	};
	const available = (id: string): { available: boolean; blockedReason?: string } =>
		selected?.actions.find(action => action.id === id) ?? {
			available: false,
			blockedReason: "当前阶段尚不能执行此操作",
		};
	const showPreview = async (
		snapshot: DevRequirementSnapshot,
		intent: DevActionIntent,
		target: DevGitTarget | null,
	): Promise<void> => {
		const prepared = await client.preview(snapshot, intent, target);
		if (snapshot.record.stage === "solution" && intent.kind === "next" && intent.candidateId) {
			const boundVersion = prepared.action.binding.files.find(file => file.path === solutionMaterial?.path)?.version;
			if (selectedSolutionCandidate(candidate[snapshot.record.requirementId], boundVersion) !== intent.candidateId) {
				setCandidate(current => {
					const next = { ...current };
					delete next[snapshot.record.requirementId];
					return next;
				});
				throw new Error("方案材料已变更，请重新查看并选择当前方案。");
			}
		}
		setPreviewSnapshot(snapshot);
		setPreview(prepared);
		setTargetChoice(null);
	};
	const prepare = (intent: DevActionIntent, snapshot = selected): void => {
		if (!snapshot) return;
		if (busyRef.current) return;
		operationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void run(async () => {
			const needsGit = ["commit", "mark", "cancel", "set-test-state", "link-fix"].includes(intent.kind);
			if (!needsGit) {
				await showPreview(snapshot, intent, null);
				return;
			}
			const targets = await client.targets(snapshot.record.requirementId);
			if (!targets.length)
				throw new Error("当前没有可用的仓库推送目标，请先按项目原有方式配置 Git；不会创建分支或猜测目标。");
			if (targets.length > 1) {
				setTargetChoice({ snapshot, intent, targets });
				return;
			}
			await showPreview(snapshot, intent, targets[0]);
		});
	};
	const control = (id: string, label: string, intent: DevActionIntent): ReactNode => {
		const action = available(id);
		return (
			<button
				type="button"
				className={id === currentActionId ? "dw-stage-primary" : "dw-stage-secondary"}
				data-action={intent.kind === "sync-archive" ? "sync" : intent.kind}
				data-mark={intent.kind === "mark" ? intent.mark : undefined}
				data-test-state={intent.kind === "set-test-state" ? intent.state : undefined}
				disabled={!action.available || busy || !state.connected}
				title={action.blockedReason}
				onClick={() => prepare(intent)}
			>
				{label}
				{id === currentActionId && <ArrowRight className="dw-icon" size={17} aria-hidden="true" />}
			</button>
		);
	};
	const inspect = (): void => {
		if (!operationId) return;
		void run(async () => {
			setResult(await client.operation(operationId));
			await client.refresh();
		});
	};
	const openNew = (related = ""): void => {
		setNavOpen(false);
		setRelatedId(related);
		setRequest("");
		setSource("conversation");
		setNewOpen(true);
	};
	const active = selected?.record.lifecycle === "active";
	const currentActionId =
		selected?.record.stage === "st"
			? "st-complete"
			: selected?.record.stage === "pr"
				? selected.record.marks["pr-submitted"]
					? "pr-merged"
					: "pr-submitted"
				: selected?.record.stage === "testing"
					? "tested"
					: "next";
	const operations = (
		<>
			{error || state.error ? (
				<div className="dw-secondary-operations dw-error" role="alert">
					{error ?? state.error}
				</div>
			) : null}
			{selected && (
				<>
					<div className="dw-workflow-controls" aria-label="当前需求操作">
						<div className="dw-action-heading">
							{active ? (
								<ArrowRight className="dw-icon" size={16} aria-hidden="true" />
							) : (
								<Lock className="dw-icon" size={16} aria-hidden="true" />
							)}
							<strong>
								{active
									? `当前执行：${stageLabel(selected.record.stage)}`
									: selected.record.lifecycle === "completed"
										? "本轮需求已完成"
										: requirementStatus(selected)}
							</strong>
							<span className="dw-action-status">{requirementStatus(selected)}</span>
						</div>
						<p className="dw-action-context">
							{active
								? STAGE_CONTEXT[selected.record.stage]
								: selected.record.lifecycle === "completed"
									? "材料只读。新的修改请新建关联需求，不覆盖本次结论。"
									: "当前需求已停止或正在结清；仅查看保留的状态与审计事实。"}
						</p>
						{active && (
							<div className="dw-stage-actions">
								{STAGES.findIndex(stage => stage.id === selected.record.stage) < 5 &&
									control("next", `确认${stageLabel(selected.record.stage)} · Next`, {
										kind: "next",
										...(selected.record.stage === "solution" && selectedCandidate
											? { candidateId: selectedCandidate }
											: {}),
									})}
								{selected.record.stage === "st" &&
									control("st-complete", "标记 ST 完成", { kind: "mark", mark: "st-complete" })}
								{selected.record.stage === "pr" &&
									(selected.record.marks["pr-submitted"]
										? control("pr-merged", "标记 PR 已合入", { kind: "mark", mark: "pr-merged" })
										: control("pr-submitted", "标记 PR 已提交", { kind: "mark", mark: "pr-submitted" }))}
								{selected.record.stage === "testing" &&
									control("tested", "标记已测试", { kind: "mark", mark: "tested" })}
							</div>
						)}
					</div>
					{(state.joined ||
						selected.runtime?.blockedReason ||
						(active && !available(currentActionId).available) ||
						selected.record.lifecycle === "completed") && (
						<section className="dw-secondary-operations" aria-label="需求状态">
							{state.joined && (
								<p className="dw-warning">
									材料与操作属于当前本地需求；右侧是已加入的共享会话，聊天不会批准或修改本地材料。
								</p>
							)}
							{selected.runtime?.blockedReason && <p>{selected.runtime.blockedReason}</p>}
							{active &&
								!available(currentActionId).available &&
								available(currentActionId).blockedReason !== selected.runtime?.blockedReason && (
									<p>{available(currentActionId).blockedReason}</p>
								)}
							{selected.record.lifecycle === "completed" && <p>已完成，只能查看；后续调整请新建关联需求。</p>}
						</section>
					)}
					{(active || selected.record.stage === "testing" || selected.record.lifecycle === "completed") && (
						<section className="dw-secondary-operations" aria-label="更多需求操作">
							<button
								type="button"
								data-action="toggle-secondary-operations"
								aria-expanded={secondaryOperationsOpen}
								aria-controls="dw-secondary-operation-controls"
								onClick={() =>
									setSecondaryOperationsFor(secondaryOperationsOpen ? null : secondaryOperationsKey)
								}
							>
								更多操作
							</button>
							<div id="dw-secondary-operation-controls" hidden={!secondaryOperationsOpen}>
								{active && (
									<>
										{selected.record.stage !== "business" && (
											<div className="dw-stage-actions">
												{selected.record.stage !== "testing" && control("back", "Back", { kind: "back" })}
												{selected.record.stage === "testing" && (
													<>
														{selected.record.testing === "not-started" &&
															control("set-test-state", "开始测试", {
																kind: "set-test-state",
																state: "in-progress",
															})}
														{selected.record.testing !== "failed" &&
															control("set-test-state", "测试未通过", {
																kind: "set-test-state",
																state: "failed",
															})}
														{selected.record.testing === "failed" &&
															control("set-test-state", "待复测", {
																kind: "set-test-state",
																state: "retest-pending",
															})}
													</>
												)}
											</div>
										)}
										{selected.record.stage === "business" && (
											<button type="button" data-action="show-import" onClick={() => setImportOpen(true)}>
												导入已有 Markdown
											</button>
										)}
										{selected.record.stage === "pr" &&
											control("sync-archive", "同步主规格并归档", { kind: "sync-archive" })}
										{selected.record.stage !== "testing" && (
											<details>
												<summary>本需求提交</summary>
												<p>文档可提前提交，代码可分批提交，不推进阶段。</p>
												<ScopeCommitRequest
													snapshot={selected}
													connected={state.connected}
													pending={busy}
													onRequest={() => prepare({ kind: "commit" })}
												/>
											</details>
										)}
									</>
								)}
								{(selected.record.stage === "testing" || selected.record.lifecycle === "completed") && (
									<details>
										<summary>关联修复需求</summary>
										<button
											type="button"
											disabled={busy}
											onClick={() => openNew(selected.record.requirementId)}
										>
											新建关联修复需求
										</button>
										{active && (
											<>
												<label>
													选择已有修复需求
													<select value={relatedId} onChange={event => setRelatedId(event.target.value)}>
														<option value="">请选择需求</option>
														{state.requirements
															.filter(
																item =>
																	item.record.requirementId !== selectedId &&
																	item.record.lifecycle !== "cancelled",
															)
															.map(item => (
																<option
																	key={item.record.requirementId}
																	value={item.record.requirementId}
																>
																	{title(item)}
																</option>
															))}
													</select>
												</label>
												<button
													type="button"
													disabled={
														!available("link-fix").available || !relatedId || busy || !state.connected
													}
													onClick={() => prepare({ kind: "link-fix", fixRequirementId: relatedId })}
												>
													确认关联修复
												</button>
											</>
										)}
									</details>
								)}
							</div>
						</section>
					)}
				</>
			)}
			{localMode && !selected && (
				<div className="dw-workflow-controls" aria-label="本地业务文档操作">
					<p>本地业务写作不提交仓库。完成后下载文档，交给开发人员另建需求导入。</p>
					<div className="dw-action-heading">
						<FileText className="dw-icon" size={16} aria-hidden="true" />
						<strong>只整理业务，不开始开发</strong>
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								setLocalContent(await client.localBusinessMaterial());
							})
						}
					>
						读取最新业务文档
					</button>
				</div>
			)}
			{(state.unknownInput || result || operationId || confirmed) && (
				<section className="dw-secondary-operations" aria-label="操作回执与恢复">
					{state.unknownInput && (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const receipt = await client.inspectInput();
									setError(
										receipt.kind === "accepted"
											? "宿主已接收该输入，请勿重复发送；保留草稿可手动清除。"
											: receipt.message,
									);
								})
							}
						>
							查询未确认输入回执
						</button>
					)}
					{result && (
						<>
							<p>{title(result.snapshot)}</p>
							<PersistenceResult result={result} onInspect={inspect} />
						</>
					)}
					{operationId && !result && (
						<button type="button" disabled={busy} onClick={inspect}>
							查询上次操作结果
						</button>
					)}
					{confirmed && incompleteResult(result) && (
						<button
							type="button"
							data-action="resume"
							disabled={busy || !state.connected}
							onClick={() =>
								void run(async () => {
									setOperationId(confirmed.operationId);
									setResult(await client.resume(confirmed));
									setPreview(null);
									setPreviewSnapshot(null);
								})
							}
						>
							续办未完成操作
						</button>
					)}
				</section>
			)}
		</>
	);
	const filtered = state.requirements.filter(item => {
		const group = requirementGroup(item);
		return (
			(filter === "all" || filter === group) &&
			`${title(item)} ${item.record.changeId} ${item.record.requirementId}`
				.toLowerCase()
				.includes(search.toLowerCase())
		);
	});
	const groups = [
		{ id: "active", label: "开发中" },
		{ id: "testing", label: "待验收" },
		{ id: "completed", label: "已完成" },
		{ id: "stopped", label: "已停止" },
	].map(group => ({ ...group, items: filtered.filter(item => requirementGroup(item) === group.id) }));
	return (
		<TextPredictionContext.Provider value={state.connected ? client.textPrediction : null}>
			<div
				className={`dw-workbench${navOpen ? " dw-nav-open" : ""}`}
				data-testid="workbench"
				data-pane={mobilePane}
				aria-busy={!client.initialized || busy}
				onKeyDown={event => {
					if (navOpen && event.key === "Escape") {
						event.preventDefault();
						setNavOpen(false);
					}
				}}
			>
				<header className="dw-topbar">
					<div className="dw-brand">
						<button
							type="button"
							className="dw-icon-button dw-mobile-menu"
							aria-label={navOpen ? "关闭需求列表" : "打开需求列表"}
							aria-expanded={navOpen}
							aria-controls="dw-requirement-navigation"
							onClick={() => setNavOpen(open => !open)}
						>
							<Menu className="dw-icon" size={20} aria-hidden="true" />
						</button>
						<span className="dw-brand-mark" aria-hidden="true">
							<Boxes className="dw-icon" size={20} />
						</span>
						<strong>DFX研发工作台</strong>
					</div>
					<nav className="dw-mobile-switch" aria-label="工作区面板">
						<button
							type="button"
							aria-pressed={mobilePane === "materials"}
							onClick={() => setMobilePane("materials")}
						>
							材料
						</button>
						<button type="button" aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>
							会话
						</button>
					</nav>
					<span role="status">{state.connected ? "已连接" : client.initialized ? "连接已断开" : "正在连接…"}</span>
					<button
						type="button"
						className="dw-icon-button"
						aria-label="刷新需求"
						disabled={busy}
						onClick={() => void run(() => client.refresh())}
					>
						<RefreshCw className="dw-icon" size={17} aria-hidden="true" />
					</button>
				</header>
				<button
					type="button"
					className="dw-nav-shade"
					aria-label="关闭需求列表"
					tabIndex={navOpen ? 0 : -1}
					onClick={() => setNavOpen(false)}
				/>
				<aside className="dw-sidebar" id="dw-requirement-navigation" aria-label="需求导航">
					<h2 className="dw-sidebar-label">需求导航</h2>
					<button
						type="button"
						className="dw-new-request"
						data-action="new"
						disabled={busy || !client.initialized}
						onClick={() => openNew()}
					>
						<Plus className="dw-icon" size={17} aria-hidden="true" />
						新建需求
					</button>
					<label className="dw-search">
						<Search className="dw-icon" size={16} aria-hidden="true" />
						<input
							aria-label="搜索需求"
							placeholder="搜索需求名称或编号…"
							value={search}
							onChange={event => setSearch(event.target.value)}
						/>
					</label>
					<nav className="dw-filters" aria-label="需求筛选">
						{[
							["all", "全部"],
							["active", "开发中"],
							["testing", "待验收"],
							["completed", "已完成"],
						].map(([id, label]) => (
							<button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
								{label}
							</button>
						))}
					</nav>
					<nav className="dw-requirement-list" data-testid="requirement-list" aria-label="选择需求">
						{groups.map(
							group =>
								group.items.length > 0 && (
									<section className="dw-requirement-group" key={group.id} aria-label={group.label}>
										<h3 className="dw-requirement-group-heading">
											<span>{group.label}</span>
											<span>{group.items.length}</span>
										</h3>
										{group.items.map(item => (
											<div className="dw-requirement-row" key={item.record.requirementId}>
												<button
													type="button"
													data-requirement-id={item.record.requirementId}
													aria-pressed={selectedId === item.record.requirementId}
													aria-current={selectedId === item.record.requirementId ? "true" : undefined}
													onClick={() => {
														setLocalMode(false);
														select(item);
													}}
												>
													<span className="dw-requirement-summary">
														<span className="dw-requirement-id" title={item.record.requirementId}>
															{item.record.requirementId}
														</span>
													</span>
													<strong>{title(item)}</strong>
													<span className="dw-requirement-status">{requirementStatus(item)}</span>
													<span className="dw-requirement-meta" title={item.record.branch}>
														{stageLabel(item.record.stage)} ·{" "}
														{item.runtime ? EXECUTION_LABELS[item.runtime.execution] : "尚无会话"}
													</span>
												</button>
												{!item.record.marks["pr-merged"] &&
													item.record.pr?.state !== "merged" &&
													item.record.lifecycle !== "completed" &&
													item.record.lifecycle !== "cancelled" && (
														<button
															className="dw-request-delete"
															type="button"
															data-action="cancel"
															aria-label={`删除需求 ${title(item)}`}
															title="删除需求并撤销所属变更"
															disabled={
																busy ||
																!state.connected ||
																!item.actions.some(action => action.id === "cancel" && action.available)
															}
															onClick={() => prepare({ kind: "cancel" }, item)}
														>
															<svg
																viewBox="0 0 24 24"
																fill="none"
																stroke="currentColor"
																strokeWidth="1.6"
																aria-hidden="true"
															>
																<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6" />
															</svg>
														</button>
													)}
											</div>
										))}
									</section>
								),
						)}
						{filtered.length === 0 && (
							<p className="dw-empty">
								{search || filter !== "all" ? "没有匹配的需求。" : "还没有需求，从新建需求开始。"}
							</p>
						)}
					</nav>
					<footer className="dw-sidebar-footer">查看材料不推进阶段 · 操作需人员确认</footer>
				</aside>
				<div className="dw-main-shell">
					<div className="dw-body">
						<main className="dw-main">
							{selected ? (
								<>
									<h1 className="dw-sr-only">{title(selected)}</h1>
									<section className="dw-journey" aria-label="需求流程">
										<header className="dw-journey-caption">
											<strong>
												需求进度{" "}
												<span className="dw-journey-count">
													{STAGES.findIndex(stage => stage.id === selected.record.stage) + 1} / 8
												</span>
											</strong>
											<small>点击阶段只查看材料</small>
										</header>
										<StageNavigation
											snapshot={selected}
											viewed={viewed}
											onView={stage => {
												setViewed(stage);
												setMobilePane("materials");
											}}
										/>
									</section>
									<section className="dw-document-panel" data-testid="material-view" aria-label="步骤文档">
										<header className="dw-document-toolbar">
											<strong className="dw-document-label">
												<FileText className="dw-icon" size={17} aria-hidden="true" />
												{material
													? MATERIAL_LABELS[material.kind]
													: MATERIAL_KINDS[viewed][0]
														? MATERIAL_LABELS[MATERIAL_KINDS[viewed][0]]
														: stageLabel(viewed)}
											</strong>
											<DocumentTools
												key={`${selectedId}:${material?.id ?? viewed}:${material?.version ?? ""}`}
												text={materialText}
												notice={materialLifecycleNotice ?? "只读"}
												downloadUrl={
													material && !materialLifecycleNotice
														? client.url(
																`api/materials/${encodeURIComponent(selectedId!)}/${encodeURIComponent(material.id)}`,
															).href
														: undefined
												}
											/>
										</header>
										{currentMaterials.length > 1 && (
											<nav className="dw-document-tabs" aria-label="阶段材料">
												{currentMaterials.map(item => (
													<button
														type="button"
														key={item.id}
														aria-pressed={item.id === material?.id}
														onClick={() => setMaterialId(item.id)}
													>
														{MATERIAL_LABELS[item.kind]}
														{currentMaterials.filter(other => other.kind === item.kind).length > 1
															? ` · ${item.path.split("/").pop()}`
															: ""}
													</button>
												))}
											</nav>
										)}
										{viewed !== selected.record.stage && (
											<div className="dw-view-notice">
												<span>正在查看{stageLabel(viewed)} · 不会改变当前进度</span>
												<button type="button" onClick={() => setViewed(selected.record.stage)}>
													回到当前阶段
												</button>
											</div>
										)}
										<div className="dw-document-scroll">
											{materialLifecycleNotice ? (
												<div className="dw-empty" role="status">
													<h2>{materialLifecycleNotice}</h2>
													<p>不再读取或下载历史材料；业务与 Git 审计事实保留。</p>
												</div>
											) : viewed === "pr" || viewed === "testing" ? (
												<DeliveryFacts snapshot={selected} testing={viewed === "testing"} />
											) : (
												<>
													{!listing && <p role="status">正在读取实际材料…</p>}
													{listing?.error && <div role="alert">材料不可读取：{listing.error}</div>}
													{material && (
														<Material
															key={material.id}
															client={client}
															snapshot={selected}
															material={material}
															onRead={setLoadedMaterial}
															candidate={selectedCandidate}
															onCandidate={
																!state.joined &&
																viewed === "solution" &&
																selected.record.stage === "solution" &&
																active
																	? (id, version) =>
																			void run(async () => {
																				const receipt = await client.submitInputForSelection(id);
																				if (receipt.kind !== "accepted")
																					throw new Error(receipt.message);
																				setCandidate(current => ({
																					...current,
																					[selected.record.requirementId]: { id, version },
																				}));
																			})
																	: undefined
															}
														/>
													)}
													{listing && !listing.error && !material && (
														<div className="dw-empty dw-empty-material">
															<FileText className="dw-empty-icon" size={32} aria-hidden="true" />
															<h2>尚无{stageLabel(viewed)}材料</h2>
															<p>
																{viewed === selected.record.stage
																	? "通过右侧会话准备材料，材料就绪后再由人员确认下一步。"
																	: `当前进行到「${stageLabel(selected.record.stage)}」。阶段导航只用于查看，不会跳过确认。`}
															</p>
															{viewed !== selected.record.stage ? (
																<button type="button" onClick={() => setViewed(selected.record.stage)}>
																	回到当前阶段
																</button>
															) : active ? (
																<button type="button" onClick={showConversation}>
																	前往会话完善材料
																</button>
															) : null}
														</div>
													)}
												</>
											)}
										</div>
										<footer className="dw-document-footer">
											<span title={material?.path}>
												{materialLifecycleNotice ??
													material?.path ??
													(viewed === "pr" || viewed === "testing"
														? `docs/dev-requirements/${selected.record.requirementId}.json · 状态记录`
														: "材料尚未生成")}
											</span>
											<span className="dw-document-note">
												<Lock className="dw-icon" size={12} aria-hidden="true" />
												{!active
													? "材料只读 · 后续修改请新建关联需求"
													: viewed === "testing"
														? "独立测试 · 记录结论，代码修复通过关联需求进行"
														: "材料只读 · 通过会话修改，人员确认后推进"}
											</span>
										</footer>
									</section>
								</>
							) : localMode ? (
								<>
									<div className="dw-request-heading">
										<h1>本地业务需求文档</h1>
										<span>仅本地 · 不提交仓库</span>
									</div>
									<section className="dw-document-panel" data-testid="material-view">
										<header className="dw-document-toolbar">
											<strong className="dw-document-label">
												<FileText className="dw-icon" size={17} aria-hidden="true" />
												业务需求文档
											</strong>
											<DocumentTools
												text={localContent}
												downloadUrl={
													localContent !== null
														? client.url("api/local-business/material").href
														: undefined
												}
											/>
										</header>
										<div className="dw-document-scroll">
											{localContent === null ? (
												<div className="dw-empty dw-empty-material">
													<FileText className="dw-empty-icon" size={32} aria-hidden="true" />
													<h2>通过会话完善业务需求</h2>
													<p>文档生成后，点击右侧“读取最新业务文档”查看与下载。</p>
													<button type="button" onClick={showConversation}>
														前往会话完善材料
													</button>
												</div>
											) : (
												<Markdown text={localContent} />
											)}
										</div>
										<footer className="dw-document-footer">本地写作；通过下载交给开发人员。</footer>
									</section>
								</>
							) : (
								<section className="dw-empty" data-testid="material-view">
									<h1>从一个新需求开始</h1>
									<p>描述业务目标，或导入已有 Markdown，再逐步完成开发与测试。</p>
									<button
										type="button"
										data-action="new-empty"
										disabled={busy || !client.initialized}
										onClick={() => openNew()}
									>
										新建需求
									</button>
									{!client.initialized && <p role="status">正在初始化浏览器连接…</p>}
								</section>
							)}
						</main>
						<aside ref={conversationPanel} className="dw-conversation" tabIndex={-1} aria-label="共享 AI 会话">
							{visited.map(id => (
								<DevConversation
									key={id}
									client={client}
									target={id === conversationKey ? client.target() : null}
									active={id === conversationKey}
									stage={selected?.record.stage ?? (localMode ? "business" : undefined)}
									enabled={Boolean(state.joined || selected || localMode)}
									inputReady={Boolean(state.joined || selected || client.target())}
									readOnly={!state.joined && selected !== null && selected.record.lifecycle !== "active"}
									operations={id === conversationKey ? operations : null}
									onError={setError}
									onLeave={() => {
										if (state.joined) void run(() => client.leave());
										else setError("关闭页面不会停止后台任务；需要停止时请使用会话中的 Stop。");
									}}
								/>
							))}
						</aside>
					</div>
				</div>
				{newOpen && (
					<div className="dw-modal-backdrop">
						<form
							ref={newModal}
							tabIndex={-1}
							className="dw-modal"
							role="dialog"
							aria-modal="true"
							aria-label="新建需求"
							onSubmit={event => {
								event.preventDefault();
								void run(async () => {
									if (source === "local") {
										if (state.joined) throw new Error("请先离开共享会话，再开始本地业务写作。");
										const document = await client.localBusiness(request);
										updateSelection(null);
										setLocalMode(true);
										setLocalContent(document?.content ?? null);
									} else {
										const snapshot = await client.create({
											source,
											request: source === "conversation" ? request : undefined,
											relatedRequirementIds: relatedId ? [relatedId] : undefined,
										});
										setSearch("");
										setFilter("all");
										if (source === "conversation")
											setTitles(current => ({
												...current,
												[snapshot.record.requirementId]: titleFromText(request),
											}));
										setLocalMode(false);
										select(snapshot);
										setImportOpen(source === "import");
									}
									setNewOpen(false);
								});
							}}
						>
							<h2>从新需求开始</h2>
							<label>
								开始方式
								<select
									data-testid="new-source"
									value={source}
									onChange={event => setSource(event.target.value as typeof source)}
								>
									<option value="conversation">描述需求，与 OMP 一起整理</option>
									<option value="import">导入已有业务 Markdown</option>
									<option value="local">只在本地生成业务文档，不开发</option>
								</select>
							</label>
							{source !== "import" && (
								<label>
									描述需求
									<PredictiveTextarea
										data-testid="new-request"
										placeholder="现在遇到什么问题，希望得到什么结果？"
										value={request}
										onChange={event => setRequest(event.target.value)}
									/>
								</label>
							)}
							{source === "import" && (
								<p>创建后上传 Markdown 或提供 OMP 所在机器的本地路径；可直接 Next 检查，无需先对话。</p>
							)}
							{relatedId && source !== "local" && (
								<p>
									将关联原需求：
									{titles[relatedId] ??
										state.requirements.find(item => item.record.requirementId === relatedId)?.record
											.changeId ??
										relatedId}
								</p>
							)}
							<p>
								{source === "local"
									? "不创建开发需求记录，不提交或推送；下载后交给开发人员。"
									: "在当前项目继续，开发名额由实际需求状态决定。"}
							</p>
							{error && <div role="alert">{error}</div>}
							<footer>
								<button type="button" disabled={busy} onClick={() => setNewOpen(false)}>
									取消
								</button>
								<button
									type="submit"
									data-testid="new-submit"
									disabled={busy || !state.connected || (source !== "import" && !request.trim())}
								>
									{source === "local" ? "开始本地写作" : "创建需求"}
								</button>
							</footer>
						</form>
					</div>
				)}
				{importOpen && selected && (
					<div className="dw-modal-backdrop">
						<section
							ref={importModal}
							tabIndex={-1}
							className="dw-modal"
							role="dialog"
							aria-modal="true"
							aria-label="导入业务文档"
						>
							<h2>导入业务 Markdown</h2>
							<p>只导入本需求副本，不改写或删除外部源文件。</p>
							<label>
								上传本机 Markdown
								<input
									data-action="import"
									type="file"
									accept=".md,.markdown,text/markdown"
									disabled={busy}
									onChange={event => {
										const file = event.currentTarget.files?.[0];
										if (file)
											void run(async () => {
												await client.importBusiness(selected.record.requirementId, file);
												setImportOpen(false);
											});
										event.currentTarget.value = "";
									}}
								/>
							</label>
							<label>
								OMP 所在机器的本地路径
								<input
									value={hostPath}
									onChange={event => setHostPath(event.target.value)}
									placeholder="本地 Markdown 路径，不接受网址"
								/>
							</label>
							{error && <div role="alert">{error}</div>}
							<footer>
								<button type="button" disabled={busy} onClick={() => setImportOpen(false)}>
									关闭
								</button>
								<button
									type="button"
									data-action="import-path"
									disabled={busy || !hostPath.trim()}
									onClick={() =>
										void run(async () => {
											await client.importBusiness(selected.record.requirementId, hostPath);
											setImportOpen(false);
										})
									}
								>
									导入文档
								</button>
							</footer>
						</section>
					</div>
				)}
				{targetChoice && (
					<div className="dw-modal-backdrop">
						<section
							ref={targetModal}
							tabIndex={-1}
							className="dw-modal"
							role="dialog"
							aria-modal="true"
							aria-label="选择提交推送目标"
						>
							<h2>选择本次操作的仓库目标</h2>
							<p>发现多个既有目标，请确认要使用哪一个；下一步会展示实际文件与风险。</p>
							{targetChoice.targets.map((target, index) => (
								<button
									key={index}
									type="button"
									disabled={busy}
									onClick={() =>
										void run(async () => {
											const fresh = await client.targets(targetChoice.snapshot.record.requirementId);
											const current = fresh.find(
												item =>
													item.localSourceRef === target.localSourceRef &&
													item.sourceRepository === target.sourceRepository &&
													item.sourceRef === target.sourceRef &&
													item.baseRepository === target.baseRepository &&
													item.baseRef === target.baseRef &&
													item.remote === target.remote &&
													item.remoteUrl === target.remoteUrl &&
													item.targetRef === target.targetRef,
											);
											if (!current) throw new Error("仓库目标已变化，请关闭后重新发起操作。");
											await showPreview(targetChoice.snapshot, targetChoice.intent, current);
										})
									}
								>
									{target.sourceRepository} · {target.sourceRef} → {target.baseRepository} · {target.baseRef}
									（推送到 {target.remote}）
								</button>
							))}
							{error && <div role="alert">{error}</div>}
							<footer>
								<button type="button" disabled={busy} onClick={() => setTargetChoice(null)}>
									取消
								</button>
							</footer>
						</section>
					</div>
				)}
				{preview && previewSnapshot && (
					<ActionConfirmation
						key={preview.action.binding.operationId}
						snapshot={previewSnapshot}
						title={title(previewSnapshot)}
						preview={preview}
						pending={busy}
						error={error}
						returnFocus={operationFocus.current}
						onCancel={() => {
							setPreview(null);
							setPreviewSnapshot(null);
						}}
						onConfirm={reply =>
							void run(async () => {
								const id = preview.action.binding.operationId;
								setOperationId(id);
								setConfirmed({
									operationId: id,
									confirmationToken: preview.confirmationToken,
									userReply: reply,
								});
								setResult(null);
								const completed = await client.confirm(preview, reply);
								setResult(completed);
								setPreview(null);
								setPreviewSnapshot(null);
								if (completed.snapshot.record.requirementId === selectedId)
									setViewed(completed.snapshot.record.stage);
							})
						}
					/>
				)}
			</div>
		</TextPredictionContext.Provider>
	);
}
