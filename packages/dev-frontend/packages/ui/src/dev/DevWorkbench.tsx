import { useEffect, useState } from "react";
import { ChevronDown, Download, Copy, Settings, FileText } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import {
	useDev,
	DEV_STAGES,
	DEV_STAGE_LABELS,
} from "./DevContext.js";
import { DevPublishControls } from "./DevPublishControls.js";
import { DevCollabProjection } from "./DevCollabProjection.js";
import { DevDeleteRequirement } from "./DevDeleteRequirement.js";
import { prototypeRequirementDownload } from "./mock/workflow.js";
import { MATERIAL_KIND_LABELS } from "./mock/materials.js";
export const DEV_MATERIAL_DISCUSS = "omp-dev:material-discuss";
function download(bytes: Blob, name: string) {
	const url = URL.createObjectURL(bytes);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function copyMaterial(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	const active = document.activeElement;
	const node = document.createElement("textarea");
	node.value = text;
	node.style.position = "fixed";
	node.style.left = "-10000px";
	const selection = window.getSelection();
	if (!selection) return Promise.reject(new Error("浏览器无法选择材料文本。"));
	const previous = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
	document.body.append(node);
	try {
		node.focus();
		node.select();
		if (!document.execCommand("copy")) throw new Error("浏览器拒绝复制，请手动选择材料文本。");
		return Promise.resolve();
	} catch (error) {
		return Promise.reject(error);
	} finally {
		node.remove();
		if (active instanceof HTMLElement) active.focus({ preventScroll: true });
		selection.removeAllRanges();
		for (const range of previous) selection.addRange(range);
	}
}
export { DevSidebar } from "./DevSidebar.js";
export { DevProjectSettings } from "./DevProjectSettings.js";
export function DevStageHeader() {
	const dev = useDev();
	const openSettings = useTabStore(state => state.openSettingsTab);
	const [prUrl, setPrUrl] = useState("");
	useEffect(() => {
		setPrUrl("");
	}, [dev?.selection.projectId, dev?.selection.irId, dev?.selection.srId]);
	if (!dev) return null;
	const { view, selection, command, pending } = dev;
	const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId);
	const sr = view?.srs.find(item => item.id === selection.srId && item.irId === group?.id);
	const project = view?.projects.find(item => item.id === selection.projectId);
	const release = view?.releases.find(item => item.id === dev.releaseId && item.projectId === project?.id);
	if (!group)
		return (
			<header className="space-y-2 border-b border-border bg-background px-4 py-3">
				<strong className="text-ui-base">需求讨论</strong>
				<p className="text-ui-sm text-foreground-subtle">
					{selection.irId
						? view
							? "所选需求当前不可用，请从导航选择已有需求。不会自动新建或替换历史会话。"
							: "正在读取所选需求…"
						: !view
							? "正在读取项目与 Release…"
							: !project
								? "请在导航中选择样例项目，或前往设置添加演示项目。"
								: !release
									? "请在导航中选择 Release；尚无 Release 时可前往设置添加。"
									: "在下方发送需求即可新建本地需求讨论，也可从导航继续已有需求。"}
				</p>
				<div key="dev-actions" className="flex flex-wrap gap-2">
					{!selection.irId && view && (!project || !release) && (
						<Button size="sm" variant="outline" onClick={openSettings}>
							<Settings size={14} />
							项目与 Release 设置
						</Button>
					)}
					<DevDeleteRequirement key="dev-delete-requirement" />
				</div>
				{(dev.error || view?.error) && (
					<p role="alert" className="text-ui-base text-destructive">{dev.error || view?.error}</p>
				)}
			</header>
		);
	const prFact = sr ? sr.codePr : group.requirementsPr;
	const confirmed =
		!!group.snapshot &&
		group.confirmation?.snapshotDigest === group.snapshot.digest &&
		group.review?.passed &&
		group.review.snapshotDigest === group.snapshot.digest &&
		["confirmed", "requirements-pr", "frozen"].includes(group.status);
	const canRegisterPr = sr
		? sr.status === "developing" && sr.stage === "pr"
		: confirmed && group.status !== "frozen";
	return (
		<header
			className="space-y-2 border-b border-border bg-background px-4 py-3"
			data-ir-id={group.id}
			data-sr-id={sr?.id}
			data-stage={sr?.stage}
			data-round={sr?.round}
		>
			<div className="flex flex-wrap items-center gap-2">
				<strong>{sr?.title || group.title || "需求讨论"}</strong>
				<span className="text-ui-sm text-foreground-subtle">
					{sr?.stage
						? `演示阶段：${DEV_STAGE_LABELS[sr.stage]}`
						: group.status === "frozen"
							? "整组业务需求与拆分已冻结"
							: group.status === "draft"
								? "需求讨论中"
								: group.status === "reviewing"
									? "独立审核中"
									: group.status === "confirmed"
										? "需求已确认并通过审核"
										: group.status === "requirements-pr"
											? "需求 PR 已登记，待核对合入"
											: group.status}
				</span>
				<span className="text-ui-sm text-foreground-subtle">阶段性前端原型 · 样例数据，非真实执行或验收</span>
				<DevCollabProjection />
			</div>
			{sr?.stage && (
				<nav aria-label="开发阶段" className="flex flex-wrap gap-1">
					{DEV_STAGES.map((stage, index) => (
						<Button
							key={stage}
							size="sm"
							variant={sr.stage === stage ? "secondary" : "ghost"}
							data-testid={`stage-${stage}`}
							data-stage={stage}
							data-stage-state={
								index < DEV_STAGES.indexOf(sr.stage!) ? "completed" : sr.stage === stage ? "current" : "pending"
							}
							aria-pressed={selection.stage === stage}
							onClick={() => dev.select({ ...selection, stage })}
						>
							{DEV_STAGE_LABELS[stage]}
						</Button>
					))}
				</nav>
			)}
			<div key="dev-actions" className="flex flex-wrap gap-2">
				{!sr && group.status !== "frozen" && (
					<Button
						size="sm"
						data-testid="requirement-confirm"
						disabled={pending || !group.snapshot || group.status === "reviewing" || confirmed}
						onClick={() => void command({ type: "confirmRequirements", snapshotDigest: group.snapshot!.digest })}
					>
						确认需求与全部拆分并审核
					</Button>
				)}
				{!sr && (
					<Button
						size="sm"
						variant="outline"
						data-testid="requirement-download"
						disabled={!confirmed}
						onClick={() => {
							download(prototypeRequirementDownload(selection), `${group.title}-样例材料.md`);
						}}
					>
						下载需求样例
					</Button>
				)}
				{sr?.status === "pending" && (
					<Button
						size="sm"
						data-testid="start-sr"
						disabled={pending || group.status !== "frozen" || !!view?.activeSrId}
						onClick={() => void command({ type: "startSr" })}
					>
						开始开发
					</Button>
				)}
				{sr?.status === "developing" && sr.stage !== "pr" && (
					<Button
						size="sm"
						data-testid="stage-approve"
						disabled={
							pending ||
							!sr.materialDigest ||
							!sr.materials.some(item => item.valid && item.stage === sr.stage && item.round === sr.round)
						}
						onClick={() =>
							void command({
								type: "approveStage",
								stage: sr.stage!,
								round: sr.round,
								materialDigest: sr.materialDigest!,
							})
						}
					>
						{sr.stage === "solution"
							? "确认方案进入计划"
							: sr.stage === "planning"
								? "确认计划进入开发与验证"
								: "确认开发与验证进入交付 PR"}
					</Button>
				)}
				{sr?.status === "developing" && sr.stage !== "solution" && (
					<Button
						size="sm"
						variant="outline"
						data-testid="back-solution"
						disabled={pending}
						onClick={() => void command({ type: "backStage", stage: "solution" })}
					>
						返回技术方案（保留代码）
					</Button>
				)}
				{sr?.status === "developing" && sr.stage !== "solution" && sr.stage !== "planning" && (
					<Button
						size="sm"
						variant="outline"
						data-testid="back-planning"
						disabled={pending}
						onClick={() => void command({ type: "backStage", stage: "planning" })}
					>
						返回开发计划（保留代码）
					</Button>
				)}
				{sr?.status === "developing" && sr.stage === "pr" && (
					<Button
						size="sm"
						variant="outline"
						data-testid="back-executing"
						disabled={pending}
						onClick={() => void command({ type: "backStage", stage: "executing" })}
					>
						返回开发与验证／继续修正（保留代码）
					</Button>
				)}
				{(sr?.status === "developing" || (!sr && group.status !== "frozen")) && (
					<Button
						size="sm"
						variant="outline"
						data-testid="stop"
						disabled={pending}
						onClick={() => void command({ type: "stop" })}
					>
						停止并结清
					</Button>
				)}
				<DevDeleteRequirement key="dev-delete-requirement" />
				<DevPublishControls
					key={`${group.id}:${sr?.id ?? "requirements"}:${sr?.round ?? 0}`}
					group={group}
					sr={sr}
				/>
			</div>
			{(sr?.worktree || group.worktree) && (
				<p className="text-ui-sm text-foreground-subtle">
					演示分支：{sr?.worktree?.branch ?? group.worktree?.branch} → {project?.defaultBranch}（不操作 Git）。
					{prFact && <>示例 PR：{prFact.url}（未查询平台，不代表真实 PR）</>}
				</p>
			)}
			{canRegisterPr && (
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={event => {
						event.preventDefault();
						void command({ type: sr ? "markCodePrSubmitted" : "markRequirementsPrSubmitted", url: prUrl });
					}}
				>
					<Input
						className="min-w-40 flex-1"
						data-testid={sr ? "code-pr-url" : "requirements-pr-url"}
						aria-label="人工创建的 PR 地址"
						type="url"
						required
						value={prUrl}
						onChange={event => setPrUrl(event.target.value)}
					/>
					<Button size="sm" data-testid={sr ? "code-pr-submit" : "requirements-pr-submit"} disabled={pending || !prUrl.trim()}>
						演示登记 PR
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						data-testid={sr ? "code-pr-merged" : "requirements-pr-merged"}
						disabled={pending || !(sr ? sr.codePr : group.requirementsPr)}
						onClick={() => void command({ type: sr ? "markCodeMerged" : "markRequirementsMerged" })}
					>
						演示确认合入状态
					</Button>
					<small className="text-foreground-subtle">仅切换本地展示状态，不查询平台、不核对 Git、不是实际合入。</small>
				</form>
			)}
			{sr?.status === "completed" && (
				<p className="text-ui-base">已完成状态样例；不代表代码、测试或交付已经验收。可在材料面板查看交付资料。</p>
			)}
			{(dev.error || view?.error) && (
				<p role="alert" className="text-ui-base text-destructive">
					{dev.error || view?.error}
				</p>
			)}
			<Collapsible data-testid="history">
				<CollapsibleTrigger asChild>
					<Button type="button" size="sm" variant="ghost">
						<ChevronDown className="size-3" />
						操作记录
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent>
				{view?.operations
					.filter(item => item.irId === group.id && (!sr || item.srId === sr.id))
					.map(item => (
						<div key={item.operationId} className="text-ui-sm">
							<span>
								{item.type} · {item.status}
							</span>
							{item.steps.map((step, index) => (
								<p key={index}>{step.detail}</p>
							))}
							{item.error && <p role="alert">{item.error}</p>}
						</div>
					))}
				</CollapsibleContent>
			</Collapsible>
		</header>
	);
}
export function DevReadonlyOverview() {
	const dev = useDev()!;
	const sr = dev.view?.srs.find(item => item.id === dev.selection.srId && item.irId === dev.selection.irId);
	return (
		<div className="h-full overflow-y-auto p-6 text-ui-base">
			<FileText className="mb-3 size-6 text-foreground-subtle" />
			<p>
				{sr
					? sr.status === "completed"
						? "该 SR 已完成，开发讨论只读。可在材料面板查看交付与历史记录。"
						: "该 SR 尚未开始开发，当前仅可查看需求。整组需求冻结后，点击“开始开发”进入技术方案。"
					: dev.view
						? "所选 SR 当前不可用，请从导航选择已有需求。不会自动新建或替换历史会话。"
						: "正在读取所选 SR…"}
			</p>
			<DevSrList />
		</div>
	);
}
export function DevSrList() {
	const dev = useDev()!;
	return (
		<ul className="mt-4 space-y-1">
			{dev.view?.srs
				.filter(sr => sr.irId === dev.selection.irId)
				.map(sr => (
					<li key={sr.id}>
						<Button
							variant="ghost"
							className="w-full justify-start"
							data-sr-id={sr.id}
							onClick={() => dev.select({ projectId: sr.projectId, irId: sr.irId, srId: sr.id })}
						>
							<span className="min-w-0 flex-1 truncate">{sr.title}</span>
							<small className="ml-auto text-ui-sm text-foreground-subtle">{sr.status === "completed" ? "已完成（样例）" : sr.stage ? DEV_STAGE_LABELS[sr.stage] : "待开始"}</small>
						</Button>
					</li>
				))}
		</ul>
	);
}
export function DevMaterialsPane() {
	const dev = useDev()!;
	const { selection, view } = dev;
	const [path, setPath] = useState("");
	const materials =
		view?.materials.filter(
			item =>
				item.projectId === selection.projectId &&
				item.irId === selection.irId &&
				(!item.srId || item.srId === selection.srId),
		) ?? [];
	const sr = view?.srs.find(
		item => item.id === selection.srId && item.irId === selection.irId && item.projectId === selection.projectId,
	);
	const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(
		item => item.id === selection.irId && item.projectId === selection.projectId,
	);
	const stage = selection.stage ?? sr?.stage;
	const preferred = materials.find(
		item =>
			item.valid &&
			(selection.srId
				? stage
					? !!sr &&
						item.srId === sr.id &&
						item.stage === stage &&
						sr.materials.some(
							current =>
								current.valid &&
								current.stage === stage &&
								(stage !== sr.stage || current.round === sr.round) &&
								current.path === item.path &&
								current.sha256 === item.sha256 &&
								current.size === item.size,
						)
					: item.kind === "sr" && item.path === sr?.documentPath
				: item.kind === "ir" && item.path === group?.documentPath),
	);
	useEffect(() => {
		setPath(preferred?.path ?? "");
	}, [
		selection.projectId,
		selection.irId,
		selection.srId,
		stage,
		sr?.round,
		sr?.materialDigest,
		preferred?.path,
		preferred?.sha256,
	]);
	const listed = materials.find(item => item.path === path);
	const material = listed;
	const error = listed?.error;
	const current = material ?? listed;
	const awaitingRequirements = !path && !selection.srId && group?.status === "draft" &&
		!group.snapshot && !group.files.length && !materials.length;
	return (
		<aside
			className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
			data-testid="materials-pane"
		>
			<div className="space-y-2 p-3">
				<Select value={path || "none"} onValueChange={value => setPath(value === "none" ? "" : value)}>
					<SelectTrigger className="w-full min-w-0" data-testid="material-menu" aria-label="材料">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						<SelectItem value="none">
							{selection.irId ? awaitingRequirements ? "等待生成需求材料" : "没有当前有效材料" : "发送需求后查看材料"}
						</SelectItem>
						{materials.map(item => (
							<SelectItem key={item.path} value={item.path}>
								{MATERIAL_KIND_LABELS[item.kind]} · {item.path.split("/").at(-1)}
								{!item.valid ? "（已失效）" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{stage && (
					<p className="text-ui-sm text-foreground-subtle">
						查看：{DEV_STAGE_LABELS[stage]} · 演示当前：{sr?.stage ? DEV_STAGE_LABELS[sr.stage] : "未开始"}
					</p>
				)}
				<div className="flex flex-wrap gap-1">
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-copy"
						disabled={material?.content === undefined}
						onClick={() => {
							void copyMaterial(material!.content!).catch(dev.report);
						}}
					>
						<Copy size={14} />
						复制
					</Button>
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-download"
						disabled={material?.content === undefined}
						onClick={() =>
							download(
								new Blob([material!.content!], { type: "text/markdown;charset=utf-8" }),
								path.split("/").at(-1)!,
							)
						}
					>
						<Download size={14} />
						下载
					</Button>
					<Button
						size="sm"
						variant="ghost"
						data-testid="material-discuss"
						disabled={
							material?.content === undefined || !dev.session
						}
						onClick={() =>
							window.dispatchEvent(
								new CustomEvent(DEV_MATERIAL_DISCUSS, {
									detail: {
										...selection,
										sessionId: dev.session?.sessionId,
										text: `请讨论以下只读材料（${path}）：\n\n${material!.content}`,
									},
								}),
							)
						}
					>
						带入讨论
					</Button>
				</div>
				{selection.irId && !selection.srId && (
					<>
						<Button size="sm" variant="ghost" disabled={!preferred} onClick={() => setPath(preferred!.path)}>
							完整 IR
						</Button>
						<DevSrList />
					</>
				)}
				{group?.review && (
					<Collapsible className="text-ui-sm" data-testid="requirement-review">
						<CollapsibleTrigger asChild>
							<Button type="button" size="sm" variant="ghost">
								<ChevronDown className="size-3" />
							独立审核：
							{group.review.snapshotDigest !== group.snapshot?.digest
								? "旧版本记录（已失效）"
								: group.review.passed
									? "通过"
									: "未通过"}
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent>
						<pre className="mt-2 whitespace-pre-wrap break-words">{group.review.report}</pre>
						</CollapsibleContent>
					</Collapsible>
				)}
			</div>
			<div
				className="min-h-0 flex-1 overflow-auto p-4"
				data-testid="material"
				data-material-path={path}
				data-material-valid={current?.valid}
			>
				{error || current?.error ? (
					<p role="alert" className="text-ui-base text-destructive">
						{error ?? current?.error}
					</p>
				) : !selection.irId ? (
					<p className="text-ui-base text-foreground-subtle">发送需求后在此查看只读材料，也可从导航选择已有需求。</p>
				) : awaitingRequirements ? (
					<p role="status" className="text-ui-base text-foreground-subtle">需求材料尚未生成。可先在对话中讨论需求，生成后将在此显示。</p>
				) : !current ? (
					<p role="alert" className="text-ui-base text-destructive">
						{path
							? "所选材料不在当前材料清单中。"
							: stage
								? `${DEV_STAGE_LABELS[stage]}没有当前有效材料；请生成材料，或从菜单选择历史版本只读查看。`
								: "当前需求材料尚未生成或已失效。"}
					</p>
				) : (
					<>
						{!current.valid && (
							<p role="status" className="mb-3 text-ui-base text-destructive">
								材料已失效，需要重新生成或验证。以下仅供历史查看。
							</p>
						)}
						<pre className="whitespace-pre-wrap break-words font-mono text-ui-base">
							{material?.content ?? "样例材料没有正文。"}
						</pre>
					</>
				)}
			</div>
		</aside>
	);
}
