/**
 * Fork-extension plan-mode commands (rpc-ui-protocol.md §14.9).
 *
 * `set_plan_mode`/`get_plan_state` wrap the session plan state (via
 * `plan-mode/session-approval.ts` for enter/exit); `list_plans`/`read_plan`
 * wrap `plan-mode/plan-files.ts`; `approve_plan` settles the plan-review loop
 * through the shared `dispatchApprovedPlan` tail. The `/plan` prompt text is
 * intercepted in RPC mode (any protocol version) and routed here instead of
 * reaching the model as a literal prompt — ending the TUI-only-command leak.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import type { LocalProtocolOptions } from "../../internal-urls";
import { listPlanFiles, readPlanFile, resolvePlanFilePath } from "../../plan-mode/plan-files";
import { humanizePlanTitle } from "../../plan-mode/approved-plan";
import {
	dispatchApprovedPlan,
	enterPlanModeForSession,
	exitPlanModeForSession,
} from "../../plan-mode/session-approval";
import type { PlanModeState } from "../../plan-mode/state";
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

const PLAN_SLASH_PATTERN = /^\/plan(?:[ \t]+(off))?[ \t]*$/i;

interface PendingPlanApproval {
	sessionId: string;
	sessionGeneration: number;
	modePlanFilePath: string;
	modeState: PlanModeState;
	planFilePath: string;
	title: string;
	approvalId: string;
	revision: string;
}

function planRevision(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export class RpcForkPlanController {
	readonly #localProtocolOptions: LocalProtocolOptions;
	#previousTools: string[] | undefined;
	#previousToolsSession: string | undefined;
	#pendingApproval: PendingPlanApproval | undefined;
	#decisionInFlight = false;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
		private readonly options: { projectMode?: boolean } = {},
	) {
		this.#localProtocolOptions = {
			getArtifactsDir: () => this.session.sessionManager.getArtifactsDir(),
			getSessionId: () => this.session.sessionManager.getSessionId(),
		};
		host.registerCommand("set_plan_mode", command => this.#setPlanMode(command));
		host.registerCommand("get_plan_state", command => this.#getPlanState(command));
		host.registerCommand("list_plans", command => this.#listPlans(command));
		host.registerCommand("read_plan", command => this.#readPlan(command));
		host.registerCommand("approve_plan", command => this.#approvePlan(command));
		host.registerPendingRequestSource(() => this.#decisionInFlight || this.#currentApproval() !== undefined);
		host.registerDisposer(() => {
			this.#pendingApproval = undefined;
			this.session.setPlanProposalHandler(null);
		});
		if (this.session.getPlanModeState()?.enabled) this.#installProposalHandler();
	}

	/**
	 * Intercept a `/plan` prompt text before it reaches the skill/agent
	 * dispatch. Only text that is exactly `/plan` (or `/plan off`, optional
	 * trailing whitespace) is consumed as a plan-mode toggle; anything else —
	 * `/plan <other>` or a multi-line prompt — reaches the model untouched.
	 */
	async interceptSlashPlan(text: string): Promise<boolean> {
		const match = PLAN_SLASH_PATTERN.exec(text.trim());
		if (!match) return false;
		const arg = match[1];
		const state = this.session.getPlanModeState();
		if (state?.enabled || arg === "off") {
			await exitPlanModeForSession(this.session, this.#toolSnapshot());
			this.#clearToolSnapshot();
		} else {
			const entry = await enterPlanModeForSession(this.session);
			this.#recordToolSnapshot(entry.previousTools);
		}
		return true;
	}

	/** Tool snapshot if it still belongs to the current session, else undefined. */
	#toolSnapshot(): string[] | undefined {
		return this.#previousToolsSession === this.session.sessionManager.getSessionId()
			? this.#previousTools
			: undefined;
	}

	#recordToolSnapshot(previousTools: string[]): void {
		this.#previousTools = previousTools;
		this.#previousToolsSession = this.session.sessionManager.getSessionId();
		this.#pendingApproval = undefined;
		this.#installProposalHandler();
	}

	#clearToolSnapshot(): void {
		this.#previousTools = undefined;
		this.#previousToolsSession = undefined;
		this.#pendingApproval = undefined;
	}

	#currentApproval(): PendingPlanApproval | undefined {
		const pending = this.#pendingApproval;
		const state = this.session.getPlanModeState();
		if (
			pending &&
			(state?.enabled !== true ||
				this.session.sessionManager.getSessionId() !== pending.sessionId ||
				this.session.sessionGeneration !== pending.sessionGeneration ||
				state !== pending.modeState ||
				state.planFilePath !== pending.modePlanFilePath)
		) {
			this.#pendingApproval = undefined;
		}
		return this.#pendingApproval;
	}

	#installProposalHandler(): void {
		this.session.setPlanProposalHandler(async title => {
			const state = this.session.getPlanModeState();
			const sessionId = this.session.sessionManager.getSessionId();
			const sessionGeneration = this.session.sessionGeneration;
			const result = await this.session.preparePlanForReview(title);
			const details = result.details;
			if (!details) throw new Error("Plan review did not return a plan artifact");
			const content = await this.#readPlanContent(details.planFilePath);
			if (content === null) throw new Error(`Plan file not found: ${details.planFilePath}`);
			const current = this.session.getPlanModeState();
			if (
				!this.host.isActive ||
				this.session.isDisposed ||
				this.#decisionInFlight ||
				this.session.sessionManager.getSessionId() !== sessionId ||
				this.session.sessionGeneration !== sessionGeneration ||
				current?.enabled !== true ||
				current !== state
			) {
				throw new Error("Plan mode changed while preparing review");
			}
			const pending: PendingPlanApproval = {
				sessionId,
				sessionGeneration,
				modePlanFilePath: current.planFilePath,
				modeState: current,
				planFilePath: details.planFilePath,
				title: details.title,
				approvalId: randomUUID(),
				revision: planRevision(content),
			};
			this.#pendingApproval = pending;
			return this.options.projectMode
				? { ...result, details: { ...details, approvalId: pending.approvalId, revision: pending.revision } }
				: result;
		});
	}

	#readPlanContent(planFilePath: string): Promise<string | null> {
		return readPlanFile(planFilePath, {
			localProtocolOptions: this.#localProtocolOptions,
			cwd: this.session.sessionManager.getCwd(),
		});
	}

	async #approvalMatches(pending: PendingPlanApproval, revision: unknown): Promise<boolean> {
		const content = await this.#readPlanContent(pending.planFilePath);
		return (
			this.host.isActive &&
			!this.session.isDisposed &&
			this.#currentApproval() === pending &&
			content !== null &&
			planRevision(content) === revision
		);
	}

	/**
	 * Run a prompt turn through the host's background dispatch so it never
	 * blocks the RPC serial queue; hosts without one (bare stubs) fall back to
	 * awaiting the turn inline.
	 */
	async #runPromptTurn(run: () => Promise<void>, id?: string): Promise<void> {
		const sessionId = this.session.sessionManager.getSessionId();
		const sessionGeneration = this.session.sessionGeneration;
		const sessionManager = this.session.sessionManager;
		const guardedRun = async () => {
			if (
				!this.host.isActive ||
				this.session.isDisposed ||
				this.session.sessionManager !== sessionManager ||
				this.session.sessionGeneration !== sessionGeneration ||
				this.session.sessionManager.getSessionId() !== sessionId
			) {
				throw Object.assign(new Error("Plan execution was cancelled because its session changed"), {
					code: "session_changed",
				});
			}
			await run();
		};
		const dispatch = this.host.context.dispatchForkPromptTurn;
		if (!dispatch) {
			await guardedRun();
			return;
		}
		dispatch(guardedRun, id);
	}

	async #setPlanMode(command: RpcForkCommandBase): Promise<RpcResponse> {
		const enabled = (command as { enabled?: unknown }).enabled;
		if (typeof enabled !== "boolean") {
			return this.host.context.error(command.id, "set_plan_mode", "enabled must be a boolean");
		}
		if (enabled) {
			if (this.session.getPlanModeState()?.enabled) {
				return this.host.context.success(command.id, "set_plan_mode", {
					enabled: true,
					planFilePath: this.session.getPlanModeState()?.planFilePath,
				});
			}
			const entry = await enterPlanModeForSession(this.session);
			this.#recordToolSnapshot(entry.previousTools);
			return this.host.context.success(command.id, "set_plan_mode", {
				enabled: true,
				planFilePath: entry.planFilePath,
			});
		}
		await exitPlanModeForSession(this.session, this.#toolSnapshot());
		this.#clearToolSnapshot();
		return this.host.context.success(command.id, "set_plan_mode", { enabled: false });
	}

	async #getPlanState(command: RpcForkCommandBase): Promise<RpcResponse> {
		const pending = this.#currentApproval();
		if (pending && !this.#decisionInFlight) {
			const content = await this.#readPlanContent(pending.planFilePath);
			if (this.#currentApproval() === pending) {
				if (content === null) this.#pendingApproval = undefined;
				else pending.revision = planRevision(content);
			}
		}
		const approval = this.#currentApproval();
		const state = this.session.getPlanModeState();
		return this.host.context.success(command.id, "get_plan_state", {
			enabled: state?.enabled ?? false,
			...(approval?.planFilePath || state?.planFilePath
				? { planFilePath: approval?.planFilePath ?? state?.planFilePath }
				: {}),
			...(state?.workflow ? { workflow: state.workflow } : {}),
			...(this.options.projectMode
				? {
						pendingApproval: approval !== undefined,
						...(approval ? { approvalId: approval.approvalId, revision: approval.revision } : {}),
					}
				: {}),
		});
	}

	async #listPlans(command: RpcForkCommandBase): Promise<RpcResponse> {
		const urls = await listPlanFiles({ localProtocolOptions: this.#localProtocolOptions });
		const plans = await Promise.all(
			urls.map(async url => {
				const filePath = resolvePlanFilePath(url, {
					localProtocolOptions: this.#localProtocolOptions,
					cwd: this.session.sessionManager.getCwd(),
				});
				let modified: string | undefined;
				try {
					modified = (await fs.stat(filePath)).mtime.toISOString();
				} catch {
					modified = undefined;
				}
				return { path: filePath, ...(modified ? { modified } : {}) };
			}),
		);
		return this.host.context.success(command.id, "list_plans", { plans });
	}

	async #readPlan(command: RpcForkCommandBase): Promise<RpcResponse> {
		const planPath = (command as { path?: unknown }).path;
		if (typeof planPath !== "string" || !planPath) {
			return this.host.context.error(command.id, "read_plan", "path is required");
		}
		const content = await readPlanFile(planPath, {
			localProtocolOptions: this.#localProtocolOptions,
			cwd: this.session.sessionManager.getCwd(),
		});
		if (content === null) {
			return this.host.context.error(command.id, "read_plan", `Plan file not found: ${planPath}`, "plan_not_found");
		}
		return this.host.context.success(command.id, "read_plan", {
			content,
			path: resolvePlanFilePath(planPath, {
				localProtocolOptions: this.#localProtocolOptions,
				cwd: this.session.sessionManager.getCwd(),
			}),
		});
	}

	async #approvePlan(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { decision, approvalId, expectedRevision } = command as {
			decision?: unknown;
			approvalId?: unknown;
			expectedRevision?: unknown;
		};
		if (decision !== "approve" && decision !== "refine" && decision !== "reject") {
			return this.host.context.error(command.id, "approve_plan", `Invalid decision: ${String(decision)}`);
		}
		const pending = this.#currentApproval();
		if (this.options.projectMode && !pending) {
			return this.host.context.error(command.id, "approve_plan", "No plan is awaiting approval", "plan_not_pending");
		}
		if (
			this.#decisionInFlight ||
			(this.options.projectMode && (approvalId !== pending?.approvalId || expectedRevision !== pending?.revision))
		) {
			return this.host.context.error(
				command.id,
				"approve_plan",
				"Plan approval is stale or already in progress",
				"plan_approval_conflict",
			);
		}
		this.#decisionInFlight = true;
		try {
			if (this.options.projectMode && pending && !(await this.#approvalMatches(pending, expectedRevision))) {
				return this.host.context.error(
					command.id,
					"approve_plan",
					"Plan changed; read its approval state again",
					"plan_approval_conflict",
				);
			}
			return await this.#applyPlanDecision(command, pending, expectedRevision);
		} finally {
			this.#decisionInFlight = false;
		}
	}

	async #applyPlanDecision(
		command: RpcForkCommandBase,
		pending: PendingPlanApproval | undefined,
		expectedRevision: unknown,
	): Promise<RpcResponse> {
		const { decision, feedback, model } = command as { decision?: unknown; feedback?: unknown; model?: unknown };
		const state = this.session.getPlanModeState();
		if (decision === "refine") {
			if (state?.enabled !== true) {
				return this.host.context.error(command.id, "approve_plan", "Plan mode is not enabled", "plan_not_active");
			}
			if (typeof feedback !== "string" || !feedback.trim()) {
				return this.host.context.error(command.id, "approve_plan", "refine requires feedback");
			}
			// TUI refine semantics: the feedback rides in as a normal user turn
			// while plan mode stays enabled. Dispatched off the RPC serial queue
			// so the turn cannot block abort/get_state.
			const message = feedback.trim();
			this.#pendingApproval = undefined;
			await this.#runPromptTurn(async () => {
				if (this.session.isStreaming) {
					await this.session.followUp(message);
				} else {
					await this.session.prompt(message);
				}
			}, command.id);
			return this.host.context.success(command.id, "approve_plan", { decision, dispatched: true });
		}
		if (decision === "reject") {
			if (!this.session.getPlanModeState()?.enabled) {
				return this.host.context.error(command.id, "approve_plan", "Plan mode is not enabled", "plan_not_active");
			}
			await exitPlanModeForSession(this.session, this.#toolSnapshot());
			this.#clearToolSnapshot();
			return this.host.context.success(command.id, "approve_plan", { decision, dispatched: false });
		}

		// approve
		const planFilePath = pending?.planFilePath ?? state?.planFilePath;
		if (!state?.enabled || !planFilePath) {
			return this.host.context.error(command.id, "approve_plan", "Plan mode is not enabled", "plan_not_active");
		}
		const planContent = await this.#readPlanContent(planFilePath);
		if (planContent === null) {
			return this.host.context.error(
				command.id,
				"approve_plan",
				`Plan file not found: ${planFilePath}`,
				"plan_not_found",
			);
		}
		if (this.options.projectMode && planRevision(planContent) !== expectedRevision) {
			return this.host.context.error(command.id, "approve_plan", "Plan content changed", "plan_approval_conflict");
		}
		if (typeof model === "string") {
			const separator = model.indexOf("/");
			if (separator <= 0) {
				return this.host.context.error(command.id, "approve_plan", 'model must be a "provider/modelId" selector');
			}
			let models = this.session.getAvailableModels();
			let match = models.find(m => m.provider === model.slice(0, separator) && m.id === model.slice(separator + 1));
			if (!match) {
				await this.session.modelRegistry.awaitBackgroundRefresh();
				models = this.session.getAvailableModels();
				match = models.find(m => m.provider === model.slice(0, separator) && m.id === model.slice(separator + 1));
			}
			if (!match) {
				return this.host.context.error(command.id, "approve_plan", `Model not found: ${model}`, "model_not_found");
			}
			await this.session.setModel(match, "default", { persist: false });
		} else if (model !== undefined) {
			return this.host.context.error(command.id, "approve_plan", 'model must be a "provider/modelId" selector');
		}
		if (this.options.projectMode && pending && !(await this.#approvalMatches(pending, expectedRevision))) {
			return this.host.context.error(
				command.id,
				"approve_plan",
				"Plan changed; read its approval state again",
				"plan_approval_conflict",
			);
		}
		const title = humanizePlanTitle(pending?.title ?? path.basename(planFilePath).replace(/\.md$/i, ""));
		await exitPlanModeForSession(this.session, this.#toolSnapshot());
		this.#clearToolSnapshot();
		// The execution turn runs for minutes: dispatched off the RPC serial
		// queue so ordinary commands (abort, get_state) keep answering while the
		// approved prompt executes, and the command is answered immediately.
		await this.#runPromptTurn(
			() =>
				dispatchApprovedPlan(this.session, {
					planFilePath,
					title,
					planContent,
					preserveContext: true,
				}),
			command.id,
		);
		return this.host.context.success(command.id, "approve_plan", { decision, dispatched: true });
	}
}
