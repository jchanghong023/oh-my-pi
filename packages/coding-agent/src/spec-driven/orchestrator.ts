import type { ImageContent } from "@oh-my-pi/pi-ai";
import { artifactVersion } from "./artifacts";
import { DEV_STAGES as STAGES, roleForDevStage } from "./stages";
import type {
	DevActionIntent,
	DevDecision,
	DevPrFact,
	DevRequirementRecord,
	DevSolutionBasis,
	DevStage,
	SpecAgentInput,
	SpecApproval,
	SpecArtifactPaths,
	SpecCloseProgress,
	SpecConversationRecipient,
	SpecDocument,
	SpecDrivenPorts,
	SpecDrivenStatus,
	SpecFileVersion,
	SpecRunContext,
	SpecSavedRun,
	SpecStageRole,
	SpecVersionCheck,
} from "./types";

export class StaleRun extends Error {}
export class SpecAdmissionError extends Error {
	readonly code = "invalid_params";
}
const version = ({ path, version }: SpecFileVersion): SpecFileVersion => ({ path, version });
function sameFiles(left: readonly SpecFileVersion[], right: readonly SpecFileVersion[]): boolean {
	return (
		left.length === right.length && left.every(a => right.some(b => a.path === b.path && a.version === b.version))
	);
}
function stageDecisions(record: DevRequirementRecord): DevDecision[] {
	const gitOperations = new Set(record.gitOperations.map(operation => operation.operationId));
	return record.decisions.filter(
		decision => STAGES.indexOf(decision.stage) < 5 && !gitOperations.has(decision.operationId),
	);
}
export function hasExplicitRepairIntent(text: string): boolean {
	const value = text.trim();
	const withoutPreservationConstraints = value.replace(
		/(^|[，,、；;\n])\s*(?:(?:不|不要)(?:改|修改|变更|改动)(?:(?:已批准|已验收)的?(?:材料|文件|内容)|公开\s*API)|without (?:changing|modifying) (?:the )?(?:(?:approved|accepted) (?:materials|files|content)|public API))\s*(?=$|[，,、；;。.!！\n])/giu,
		"$1",
	);
	if (
		/[?？]/u.test(value) ||
		/(?:需要(?:改|修改|变更|调整|修复)[^。！？?\n]*(?:哪些|什么)|会(?:影响|导致|改变)[^。！？?\n]*(?:哪些|什么|吗|么)|是否|能否|如何|怎么|为什么|为何)/u.test(
			value,
		) ||
		/(?:不要|别\s*(?:改|修改|变更|改动|修复|修正|修好|继续)|勿|禁止|无需|不(?:要|许|改|修改|修复|修正)|先解释|只(?:需|要)?(?:解释|分析|讨论)|do not|don't|never|without (?:changing|modifying|fixing)|explain (?:first|only))/iu.test(
			withoutPreservationConstraints,
		)
	)
		return false;
	return /^(?:(?:(?:could|would) you\s+)?(?:please\s+)?(?:fix|repair|correct)\b|(?:请(?:你)?(?:帮我)?\s*|帮我\s*)?(?:修复|修正|修好|改正|纠正|继续(?:实施|完成)已批准|把[^。！？?\n]{1,80}(?:修复|修正|修好)))/iu.test(
		value,
	);
}
export function hasPendingDevSync(record: DevRequirementRecord): boolean {
	return record.syncRevisions.some(
		({ progress }) =>
			!!(
				progress.sideEffects ||
				progress.retirementCleanup ||
				progress.archiveCleanup ||
				progress.ownership?.state === "pending"
			),
	);
}
export interface DevOrchestratorOptions {
	record: DevRequirementRecord;
	paths?: SpecArtifactPaths;
	generation?: number;
	getUseTeam(): boolean;
	persist(record: DevRequirementRecord): Promise<void>;
	getSessions?(): SpecSavedRun["sessions"];
	persistSessions?(sessions: SpecSavedRun["sessions"]): Promise<void>;
	assertTransitionAllowed?(): void;
	onStatusChange?(status: SpecDrivenStatus): void;
	getSolutionBasis?(): DevSolutionBasis | null;
	getPendingSync?(): SpecCloseProgress | undefined;
	getPendingGit?(): string | undefined;
	startModel?(work: () => Promise<void>): void;
	getObservedPr?(): DevPrFact | undefined;
}
/** The business record is authoritative; native session references remain local. */
export class SpecDrivenOrchestrator {
	readonly runId: string;
	readonly #ports: SpecDrivenPorts;
	readonly #options: DevOrchestratorOptions;
	#record: DevRequirementRecord;
	#sessions: SpecSavedRun["sessions"];
	readonly #hydrated = new Set<SpecStageRole>();
	readonly #ready = new Set<SpecStageRole>();
	#generation = 0;
	#abort = new AbortController();
	#transition = false;
	#blockedReason: string | undefined;
	#reportNeedsUpdate = false;
	constructor(ports: SpecDrivenPorts, options: DevOrchestratorOptions) {
		this.#ports = ports;
		this.#options = options;
		this.#record = structuredClone(options.record);
		this.runId = options.record.requirementId;
		this.#sessions = structuredClone(options.getSessions?.() ?? {});
		this.#generation = options.generation ?? 0;
	}
	record(): DevRequirementRecord {
		return structuredClone(this.#record);
	}
	replaceRecord(record: DevRequirementRecord): void {
		if (record.requirementId !== this.runId) throw new SpecAdmissionError("需求身份不匹配");
		if (record.stage !== this.#record.stage || record.lifecycle !== this.#record.lifecycle) this.#generation++;
		if (
			record.stage !== this.#record.stage ||
			stageDecisions(record)
				.map(d => d.operationId)
				.join() !==
				stageDecisions(this.#record)
					.map(d => d.operationId)
					.join()
		)
			this.#hydrated.clear();
		this.#record = structuredClone(record);
	}
	currentRole(): SpecStageRole {
		return roleForDevStage(this.#record.stage);
	}
	recipient(): SpecConversationRecipient | undefined {
		const role = this.currentRole();
		return this.#ready.has(role) ? this.#ports.agents.recipient(role) : undefined;
	}
	isTransitioning(): boolean {
		return this.#transition;
	}
	status(): SpecDrivenStatus {
		const selected = stageDecisions(this.#record).findLast(decision => decision.stage === "solution");
		const latestSync = this.#record.syncRevisions.at(-1);
		return {
			phase: this.#record.stage,
			generation: this.#generation,
			useTeam: this.#options.getUseTeam(),
			changeId: this.#record.changeId,
			entryPhase: "business",
			paths: this.#options.paths,
			blockedReason:
				this.#blockedReason ?? (this.#options.getPendingSync?.() ? "原生同步结果尚未结清或持久化" : undefined),
			selection: selected?.candidateId
				? { candidateId: selected.candidateId, userReply: selected.userReply }
				: undefined,
			accepted: this.#record.report.development ?? undefined,
			awaitingAcceptance: this.#record.stage === "st",
			observedPr: this.#options.getObservedPr?.(),
			pendingGitOperationId: this.#options.getPendingGit?.(),
			closing: this.#options.getPendingSync?.() ?? latestSync?.progress,
			archivedChangePath: latestSync?.archivedChangePath ?? undefined,
			record: this.record(),
		};
	}
	save(): SpecSavedRun {
		const approvals: Partial<Record<SpecStageRole, SpecApproval>> = {};
		for (const decision of stageDecisions(this.#record)) {
			const role = roleForDevStage(decision.stage);
			approvals[role] = {
				files: decision.files.map(version),
				userReply: decision.userReply,
				candidateId: decision.candidateId,
			};
		}
		const state = this.status();
		return {
			runId: this.runId,
			phase: state.phase,
			entryPhase: "business",
			changeId: this.#record.changeId,
			approvals,
			sessions: structuredClone(this.#sessions),
			paths: state.paths,
			reportNeedsUpdate: this.#reportNeedsUpdate,
			closing: state.closing,
			archivedChangePath: state.archivedChangePath,
		};
	}
	#context(): SpecRunContext {
		return { runId: this.runId, generation: this.#generation, signal: this.#abort.signal };
	}
	#guard(context: SpecRunContext): void {
		if (context.signal.aborted || context.signal !== this.#abort.signal) throw new StaleRun("原生运行已停止或被替换");
	}
	async #save(record: DevRequirementRecord): Promise<void> {
		await this.#options.persist(record);
		this.replaceRecord(record);
		this.#blockedReason = undefined;
		this.#options.onStatusChange?.(this.status());
	}
	async checkApproved(): Promise<SpecVersionCheck> {
		const files = stageDecisions(this.#record)
			.filter(d => STAGES.indexOf(d.stage) < Math.min(STAGES.indexOf(this.#record.stage), 5))
			.flatMap(d => d.files)
			.filter(file => !this.#record.report.development?.files.some(report => report.path === file.path));
		return this.#ports.artifacts.checkVersions(
			files,
			this.#record.syncRevisions.at(-1)?.archivedChangePath ?? undefined,
		);
	}
	async #approved(): Promise<void> {
		const result = await this.checkApproved();
		if (!result.matches)
			throw new SpecAdmissionError(
				`已批准材料发生变化，须相邻返回对应阶段重新确认：${result.changed.map(f => `${f.path}: ${f.reason}`).join("；")}`,
			);
	}
	#assertWritable(): void {
		if (this.#record.lifecycle !== "active") throw new SpecAdmissionError("需求已只读或正在取消");
		if (hasPendingDevSync(this.#record) || this.#options.getPendingSync?.())
			throw new SpecAdmissionError("原生同步仍有部分副作用或持久化未结清");
		const gitOperation = this.#options.getPendingGit?.();
		if (gitOperation) throw new SpecAdmissionError(`Git 提交或 index 尚未结清；只可续办原操作 ${gitOperation}`);
	}
	async #documents(stage: DevStage): Promise<SpecDocument[]> {
		const context = this.#context();
		const files = [await this.#ports.artifacts.readBusiness(context)];
		if (stage === "business") return files;
		files.push(...(await this.#ports.artifacts.readRequirements(context)).files);
		if (stage === "requirements") return files;
		files.push(await this.#ports.artifacts.readSolution(context));
		if (stage === "solution") return files;
		files.push(await this.#ports.artifacts.readPlan(context));
		if (stage === "planning") return files;
		files.push(await this.#ports.artifacts.readReport(context));
		return files;
	}
	async #stReport(): Promise<SpecDocument> {
		const report = await this.#ports.artifacts.readReport(this.#context());
		const approved = this.#record.report.development?.files.find(file => file.path === report.path);
		if (!approved) throw new SpecAdmissionError("缺少第五阶段开发报告批准");
		if (report.version !== approved.version) {
			const bytes = Buffer.from(report.content);
			let preserved = false;
			for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, end + 1)) {
				if (
					artifactVersion(bytes.subarray(0, end)) === approved.version ||
					artifactVersion(bytes.subarray(0, end + 1)) === approved.version
				) {
					preserved = true;
					break;
				}
			}
			if (!preserved)
				throw new SpecAdmissionError(
					"开发报告已被修改；须 Back 到开发与 UT 重新确认，ST 只能追加原结论之后的实际测试事实",
				);
		}
		return report;
	}
	#hasMerged(): boolean {
		return !!(
			this.#record.marks["pr-merged"] ||
			this.#record.pr?.state === "merged" ||
			this.#options.getObservedPr?.()?.state === "merged"
		);
	}
	async inspect(intent: DevActionIntent): Promise<{ files: SpecFileVersion[]; candidateId?: string }> {
		if (intent.kind !== "next") return this.#inspect(intent);
		const previousReason = this.#blockedReason;
		try {
			const inspected = await this.#inspect(intent);
			this.#blockedReason = undefined;
			return inspected;
		} catch (error) {
			this.#blockedReason = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			if (this.#blockedReason !== previousReason) this.#options.onStatusChange?.(this.status());
		}
	}
	async #inspect(intent: DevActionIntent): Promise<{ files: SpecFileVersion[]; candidateId?: string }> {
		this.#assertWritable();
		if (this.#transition) throw new SpecAdmissionError("当前控制操作尚未结清");
		if (intent.kind === "commit") {
			if (this.#hasMerged() && this.#record.stage !== "testing")
				throw new SpecAdmissionError("已观察 PR 合入；须由人员标记进入测试后仅提交自身记录");
			return { files: [] };
		}
		if (intent.kind === "back") {
			if (this.#record.stage === "business" || this.#hasMerged()) throw new SpecAdmissionError("当前阶段不能 Back");
			return { files: [] };
		}
		if (intent.kind === "cancel") {
			if (this.#hasMerged()) throw new SpecAdmissionError("已合入需求只能通过关联新需求修复");
			return { files: this.#record.materials.map(version) };
		}
		if (intent.kind === "set-test-state" || intent.kind === "link-fix") {
			if (this.#record.stage !== "testing" || !this.#record.marks["pr-merged"])
				throw new SpecAdmissionError("仅合入后测试阶段支持此操作");
			return { files: [] };
		}
		await this.#approved();
		if (intent.kind === "next") {
			if (STAGES.indexOf(this.#record.stage) > 4) throw new SpecAdmissionError("末三阶段必须由人员明确标记");
			if (intent.candidateId !== undefined && this.#record.stage !== "solution")
				throw new SpecAdmissionError("仅方案阶段接受候选 ID");
			const documents = await this.#documents(this.#record.stage);
			let candidateId: string | undefined;
			if (this.#record.stage === "solution") {
				const solution = await this.#ports.artifacts.readSolution(this.#context());
				candidateId =
					intent.candidateId ?? (solution.candidates.length === 1 ? solution.candidates[0].id : undefined);
				if (!candidateId || !solution.candidates.some(candidate => candidate.id === candidateId))
					throw new SpecAdmissionError("必须明确选择一个有效方案 ID");
				const basis = (await this.#ports.agents.solutionBasis?.(solution)) ?? this.#options.getSolutionBasis?.();
				if (
					basis &&
					(!basis.usableCandidateIds.includes(candidateId) || basis.solutionVersion !== solution.version)
				)
					throw new SpecAdmissionError("所选候选没有匹配的原生可采用来源");
			}
			if (this.#record.stage === "executing") {
				const report = documents.at(-1)!;
				const invalidated =
					this.#record.report.development?.files.find(file => file.path === report.path) ??
					(this.#reportNeedsUpdate ? this.#record.materials.find(file => file.kind === "report") : undefined);
				if (invalidated?.version === report.version)
					throw new SpecAdmissionError("明确修复后须更新旧完成报告，再进行第五次 Next");
			}
			return { files: documents.map(version), candidateId };
		}
		if (intent.kind === "sync-archive") {
			if (this.#record.stage !== "pr") throw new SpecAdmissionError("仅第七阶段可同步归档");
			if (this.#hasMerged()) throw new SpecAdmissionError("合入后不能再同步归档其他仓库文件");
			await this.#stReport();
			return { files: (await this.#documents("pr")).map(version) };
		}
		const allowed =
			intent.mark === "st-complete"
				? this.#record.stage === "st"
				: intent.mark === "tested"
					? this.#record.stage === "testing"
					: this.#record.stage === "pr";
		if (!allowed) throw new SpecAdmissionError("人工标记与当前阶段不匹配");
		if (intent.mark === "pr-merged" && !this.#record.marks["pr-submitted"])
			throw new SpecAdmissionError("须先由人员标记 PR 已提交");
		if (intent.mark === "tested" && !this.#record.marks["pr-merged"])
			throw new SpecAdmissionError("须先由人员确认实际 PR 合入");
		if (intent.mark === "st-complete") return { files: [version(await this.#stReport())] };
		return { files: intent.mark === "tested" ? [] : (await this.#documents("pr")).map(version) };
	}
	/** Called by the Git owner before its single CAS save; no model or persistence here. */
	async decide(
		record: DevRequirementRecord,
		intent: DevActionIntent,
		decision: DevDecision,
	): Promise<DevRequirementRecord> {
		if (record.requirementId !== this.runId || decision.stage !== record.stage)
			throw new SpecAdmissionError("人工决定需求或阶段不匹配");
		const inspected = await this.inspect(intent);
		if (!sameFiles(decision.files, inspected.files)) throw new SpecAdmissionError("人员确认后材料字节发生变化");
		const next = structuredClone(record);
		if (intent.kind === "mark") {
			next.marks[intent.mark] = decision;
			if (intent.mark === "st-complete") {
				next.stage = "pr";
				next.report.st = version(inspected.files[0]!);
			}
			if (intent.mark === "pr-merged") {
				if (next.pr?.state !== "merged") throw new SpecAdmissionError("真实 PR 尚未合入");
				next.stage = "testing";
			}
			if (intent.mark === "tested") {
				next.testing = "tested";
				next.lifecycle = "completed";
			}
		} else if (intent.kind === "set-test-state") next.testing = intent.state;
		else if (intent.kind === "link-fix") {
			if (intent.fixRequirementId === record.requirementId) throw new SpecAdmissionError("不能关联自身");
			if (!next.relatedRequirementIds.includes(intent.fixRequirementId))
				next.relatedRequirementIds.push(intent.fixRequirementId);
		}
		return next;
	}
	async execute(intent: DevActionIntent, decision: DevDecision): Promise<void> {
		if (this.#transition) throw new SpecAdmissionError("当前控制操作尚未结清");
		this.#options.assertTransitionAllowed?.();
		this.#transition = true;
		try {
			const inspected = await this.inspectDuringControl(intent);
			if (
				decision.stage !== this.#record.stage ||
				!sameFiles(decision.files, inspected.files) ||
				(decision.candidateId !== undefined && decision.candidateId !== inspected.candidateId)
			)
				throw new SpecAdmissionError("阶段或确认材料范围已经改变");
			if (intent.kind === "back") {
				const index = STAGES.indexOf(this.#record.stage) - 1;
				const next = this.record();
				next.stage = STAGES[index];
				const gitDecisions = new Set(next.gitOperations.map(operation => operation.operationId));
				next.decisions = next.decisions.filter(
					d => gitDecisions.has(d.operationId) || STAGES.indexOf(d.stage) < index,
				);
				for (const mark of Object.keys(next.marks) as Array<keyof typeof next.marks>) delete next.marks[mark];
				next.report =
					index >= 5 ? { development: next.report.development, st: null } : { development: null, st: null };
				next.solutionBasis = index <= 2 ? null : next.solutionBasis;
				await this.#save(next);
				return;
			}
			if (intent.kind !== "next") throw new SpecAdmissionError("Git 和同步动作由宿主专用服务执行");
			const stage = this.#record.stage;
			const documents = await this.#documents(stage);
			if (!sameFiles(documents, inspected.files))
				throw new SpecAdmissionError("材料读取期间发生变化，不能采用新的未确认字节");
			const next = this.record();
			const accepted: DevDecision = {
				operationId: decision.operationId,
				stage: decision.stage,
				actor: decision.actor,
				at: decision.at,
				userReply: decision.userReply,
				files: inspected.files,
				...(inspected.candidateId === undefined ? {} : { candidateId: inspected.candidateId }),
			};
			next.decisions.push(accepted);
			if (stage === "solution") {
				const solution = await this.#ports.artifacts.readSolution(this.#context());
				next.solutionBasis =
					(await this.#ports.agents.solutionBasis?.(solution)) ?? this.#options.getSolutionBasis?.() ?? null;
			}
			if (stage === "executing")
				next.report.development = { files: [version(documents.at(-1)!)], userReply: decision.userReply };
			next.stage = STAGES[STAGES.indexOf(stage) + 1];
			await this.#save(next);
			// Persist business phase before any native recipient or model admission.
			if (next.stage !== "st") {
				const work = () => this.startConversation("", true, documents);
				if (this.#options.startModel) this.#options.startModel(work);
				else await work();
			}
		} catch (error) {
			this.#blockedReason = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			this.#transition = false;
			this.#options.onStatusChange?.(this.status());
		}
	}
	async inspectDuringControl(intent: DevActionIntent): Promise<{ files: SpecFileVersion[]; candidateId?: string }> {
		this.#transition = false;
		try {
			return await this.inspect(intent);
		} finally {
			this.#transition = true;
		}
	}
	async prepareSession(hydrateConversation = true): Promise<SpecConversationRecipient> {
		if (this.#record.lifecycle !== "active") throw new SpecAdmissionError("需求只读");
		const role = this.currentRole();
		if (!role) throw new SpecAdmissionError("当前没有原生角色");
		const current = this.#ports.agents.recipient(role);
		if (current && this.#hydrated.has(role)) return current;
		const upstream = STAGES.indexOf(this.#record.stage) - 1;
		let files: SpecDocument[] = [];
		if (upstream >= 0) {
			try {
				files = await this.#documents(STAGES[Math.min(upstream, 4)]);
			} catch (error) {
				this.#blockedReason = error instanceof Error ? error.message : String(error);
			}
		}
		const context = this.#context();
		if (this.#record.stage === "requirements") await this.#ports.artifacts.initialize(this.#record.changeId, context);
		await this.#ports.agents.prepare(role, context, this.#sessions[role]);
		this.#guard(context);
		const recipient = this.#ports.agents.recipient(role);
		if (!recipient) throw new Error("原生会话未建立");
		this.#sessions[role] = recipient;
		await this.#options.persistSessions?.(structuredClone(this.#sessions));
		const paths = this.#options.paths;
		if (paths && hydrateConversation)
			await this.#ports.agents.prepareConversation?.(
				{
					role,
					entry: false,
					request: "",
					files,
					outputPaths:
						role === "business"
							? [paths.business!]
							: role === "requirements"
								? paths.requirements
								: [role === "solution" ? paths.solution : role === "planner" ? paths.plan : paths.report],
					decisions: Object.fromEntries(
						Object.entries(this.save().approvals).map(([role, approval]) => [role, approval.userReply]),
					),
					candidateId: stageDecisions(this.#record).findLast(d => d.stage === "solution")?.candidateId,
					readOnly: this.#record.stage === "testing",
				},
				context,
			);
		if (hydrateConversation) this.#hydrated.add(role);
		this.#ready.add(role);
		this.#options.onStatusChange?.(this.status());
		return recipient;
	}
	async startConversation(
		request: string,
		entry = false,
		files: SpecDocument[] = [],
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<void> {
		if (this.#record.lifecycle !== "active") throw new SpecAdmissionError("需求只读");
		if (!hasPendingDevSync(this.#record)) await this.#approved();
		const role = this.currentRole();
		if (!role) throw new SpecAdmissionError("当前没有原生角色");
		// A formal entry supplies its own complete handoff; cold/direct input still hydrates here.
		await this.prepareSession(!entry);
		const context = this.#context();
		const latest = stageDecisions(this.#record).reverse();
		const paths =
			this.#options.paths ??
			(await this.#ports.artifacts.initialize(
				this.#record.changeId,
				context,
				`docs/business-requirements/${this.#record.changeId}.md`,
			));
		const input: SpecAgentInput = {
			role,
			entry,
			request: entry ? request || this.#ports.agents.originalRequest() : "",
			feedback: entry ? undefined : request,
			files,
			outputPaths:
				role === "business"
					? [paths.business!]
					: role === "requirements"
						? paths.requirements
						: [role === "solution" ? paths.solution : role === "planner" ? paths.plan : paths.report],
			userReply: entry ? latest[0]?.userReply : undefined,
			decisions: entry
				? Object.fromEntries(
						Object.entries(this.save().approvals).map(([role, approval]) => [role, approval.userReply]),
					)
				: undefined,
			candidateId: latest.find(d => d.stage === "solution")?.candidateId,
			useTeam: entry && this.#record.stage === "solution" && this.#options.getUseTeam(),
			images,
			imageLinks,
			readOnly: this.#record.stage === "testing",
		};
		this.#transition = false;
		await this.#ports.agents.run(input, context);
		if (entry) this.#hydrated.add(role);
		this.#guard(context);
		if (entry && role === "solution") {
			const solution = await this.#ports.artifacts.readSolution(context);
			const basis = await this.#ports.agents.solutionBasis?.(solution);
			this.#guard(context);
			const next = this.record();
			next.solutionBasis = basis ?? null;
			// Publish generated material and native provenance without granting human approval.
			await this.#save(next);
		}
	}
	async converse(
		text: string,
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
		intent?: "repair",
	): Promise<SpecDrivenStatus> {
		if (this.#record.lifecycle !== "active") throw new SpecAdmissionError("需求只读");
		if (this.#transition) throw new SpecAdmissionError("当前控制操作尚未结清");
		if (intent === "repair") {
			this.#assertWritable();
			await this.#approved();
		}
		const role = this.currentRole()!;
		if (!this.recipient()) {
			await this.startConversation(text, false, [], images, imageLinks);
			return this.status();
		}
		const approved = await this.checkApproved();
		await this.#ports.agents.run(
			{
				role,
				entry: false,
				request: "",
				feedback: text,
				files: [],
				outputPaths: [],
				images,
				imageLinks,
				readOnly: !approved.matches || this.#record.stage === "testing",
			},
			this.#context(),
		);
		return this.status();
	}
	async beginRepair(): Promise<void> {
		this.#assertWritable();
		await this.#approved();
		if (this.#hasMerged() || this.#record.stage === "testing")
			throw new SpecAdmissionError("合入后仅能新建关联修复需求");
		if (!["executing", "st", "pr"].includes(this.#record.stage))
			throw new SpecAdmissionError("当前阶段不支持实现修复");
		// Invalidate unused confirmations when the actual native repair turn is admitted.
		this.#generation++;
		const next = this.record();
		next.stage = "executing";
		next.report = { development: next.report.development, st: null };
		next.marks = {};
		const gitDecisions = new Set(next.gitOperations.map(operation => operation.operationId));
		next.decisions = next.decisions.filter(d => gitDecisions.has(d.operationId) || STAGES.indexOf(d.stage) < 4);
		await this.#save(next);
		this.#reportNeedsUpdate = true;
	}
	async observeReport(): Promise<void> {
		if (this.#record.stage === "executing") {
			await this.#ports.artifacts.readReport(this.#context());
			this.#reportNeedsUpdate = false;
		}
	}
	async stop(): Promise<void> {
		this.#abort.abort();
		this.#generation++;
		this.#abort = new AbortController();
		this.#options.onStatusChange?.(this.status());
	}
}
