import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type { ApprovalMode } from "../../tools/approval";
import { cfgToolsApprovalMode } from "../../tools/settings";

export type ZCodeCollaborationMode = "build" | "edit" | "plan" | "yolo" | "guarded";
export interface ZCodeRuntimeControlOptions {
	/** The command host's shared PlanHost, including draft exit confirmation. */
	setPlanEnabled(enabled: boolean, atInputBoundary?: boolean, signal?: AbortSignal): Promise<void>;
}
export interface ZCodeRuntimeControlSnapshot {
	mode: ZCodeCollaborationMode;
	planEnabled: boolean;
	approvalMode: ApprovalMode;
}

const APPROVAL_BY_MODE: Record<Exclude<ZCodeCollaborationMode, "plan">, ApprovalMode> = {
	build: "always-ask",
	edit: "write",
	yolo: "yolo",
	guarded: "guarded",
};

/** Presentation of effective native permissions without opening or mutating a session. */
export function workspaceMode(settings: Settings): Exclude<ZCodeCollaborationMode, "plan"> {
	const approvalMode = cfgToolsApprovalMode.get(settings);
	if (approvalMode === "write") return "edit";
	if (approvalMode === "yolo" || approvalMode === "guarded") return approvalMode;
	return "build";
}

/** Direct controls over the session's business owners, not a second mode state machine. */
export class ZCodeRuntimeControls {
	#switching = false;
	constructor(
		readonly session: AgentSession,
		readonly options: ZCodeRuntimeControlOptions,
	) {}

	snapshot(): ZCodeRuntimeControlSnapshot {
		const approvalMode = cfgToolsApprovalMode.get(this.session.settings);
		const planEnabled = this.session.getPlanModeState()?.enabled === true;
		const mode = planEnabled ? "plan" : workspaceMode(this.session.settings);
		return { mode, planEnabled, approvalMode };
	}

	async switchMode(
		mode: ZCodeCollaborationMode,
		atInputBoundary = false,
		planEnabled = mode === "plan",
		signal?: AbortSignal,
	): Promise<ZCodeRuntimeControlSnapshot> {
		if (mode !== "plan" && !Object.hasOwn(APPROVAL_BY_MODE, mode)) {
			throw Object.assign(new Error(`Invalid collaboration mode: ${mode}`), { code: "invalid_params" });
		}
		if (this.#switching) {
			throw Object.assign(new Error("A collaboration mode switch is awaiting completion"), { code: "session_busy" });
		}
		this.#switching = true;
		try {
			// Plan owns tool filtering, model-role handoff, persisted plan state and approval.
			// Do not relax permissions before a pending plan exit is actually approved.
			await this.options.setPlanEnabled(planEnabled, atInputBoundary, signal);
			signal?.throwIfAborted();
			if (mode !== "plan") {
				// Runtime-only; never write shared user/project defaults or blanket tool policies.
				cfgToolsApprovalMode.override(this.session.settings, APPROVAL_BY_MODE[mode]);
			}
			return this.snapshot();
		} finally {
			this.#switching = false;
		}
	}

	/** 冻结输入配置只在原生实际投递时应用，不在忙时入队改变当前回合权限。 */
	async applyInputConfiguration(
		configuration: { mode?: ZCodeCollaborationMode; planEnabled?: boolean },
		signal?: AbortSignal,
	): Promise<ZCodeRuntimeControlSnapshot> {
		const { mode, planEnabled } = configuration;
		if (mode !== undefined) return this.switchMode(mode, true, planEnabled ?? mode === "plan", signal);
		if (planEnabled !== undefined) await this.options.setPlanEnabled(planEnabled, true, signal);
		return this.snapshot();
	}

	cancelBackgroundWork(workId: string): { cancelled: true } {
		// AgentSession checks owner identity and rejects foreground jobs before asking
		// its AsyncJobManager to cancel. No session.abort(), process kill or global manager.
		if (!this.session.cancelAsyncJob(workId)) {
			throw Object.assign(new Error("Background work is not running in this session"), {
				code: "background_work_cancel_rejected",
				reason: "background_task_not_found",
				workId,
			});
		}
		return { cancelled: true };
	}
}
