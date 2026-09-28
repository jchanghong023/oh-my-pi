/**
 * Fork-extension plan-mode commands (requirement 5.3, rpc-ui-protocol.md).
 *
 * `set_plan_mode`/`get_plan_state` wrap the session plan state (via
 * `plan-mode/session-approval.ts` for enter/exit); `list_plans`/`read_plan`
 * wrap `plan-mode/plan-files.ts`; `approve_plan` settles the plan-review loop
 * through the shared `dispatchApprovedPlan` tail. The `/plan` prompt text is
 * intercepted in RPC mode (any protocol version) and routed here instead of
 * reaching the model as a literal prompt — ending the TUI-only-command leak.
 */
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
import type { RpcForkHost } from "./rpc-fork-host";
import type { RpcForkCommandBase } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

const PLAN_SLASH_PATTERN = /^\/plan(?:\s+(.*))?$/is;

export class RpcForkPlanController {
	readonly #localProtocolOptions: LocalProtocolOptions;
	#previousTools: string[] | undefined;

	constructor(
		private readonly host: RpcForkHost,
		private readonly session: AgentSession,
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
	}

	/**
	 * Intercept a `/plan` prompt text before it reaches the skill/agent
	 * dispatch. Returns true when the text was consumed as a plan-mode toggle.
	 */
	async interceptSlashPlan(text: string): Promise<boolean> {
		const match = PLAN_SLASH_PATTERN.exec(text.trim());
		if (!match) return false;
		const arg = match[1]?.trim();
		const state = this.session.getPlanModeState();
		if (state?.enabled || arg === "off") {
			await exitPlanModeForSession(this.session, this.#previousTools);
			this.#previousTools = undefined;
		} else {
			const entry = await enterPlanModeForSession(this.session);
			this.#previousTools = entry.previousTools;
		}
		return true;
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
			this.#previousTools = entry.previousTools;
			return this.host.context.success(command.id, "set_plan_mode", {
				enabled: true,
				planFilePath: entry.planFilePath,
			});
		}
		await exitPlanModeForSession(this.session, this.#previousTools);
		this.#previousTools = undefined;
		return this.host.context.success(command.id, "set_plan_mode", { enabled: false });
	}

	async #getPlanState(command: RpcForkCommandBase): Promise<RpcResponse> {
		const state = this.session.getPlanModeState();
		return this.host.context.success(command.id, "get_plan_state", {
			enabled: state?.enabled ?? false,
			...(state?.planFilePath ? { planFilePath: state.planFilePath } : {}),
			...(state?.workflow ? { workflow: state.workflow } : {}),
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
		return this.host.context.success(command.id, "read_plan", { content, path: path.resolve(planPath) });
	}

	async #approvePlan(command: RpcForkCommandBase): Promise<RpcResponse> {
		const { decision, feedback, model } = command as { decision?: unknown; feedback?: unknown; model?: unknown };
		if (decision !== "approve" && decision !== "refine" && decision !== "reject") {
			return this.host.context.error(command.id, "approve_plan", `Invalid decision: ${String(decision)}`);
		}
		const state = this.session.getPlanModeState();
		if (decision === "refine") {
			if (typeof feedback !== "string" || !feedback.trim()) {
				return this.host.context.error(command.id, "approve_plan", "refine requires feedback");
			}
			// TUI refine semantics: the feedback rides in as a normal user turn
			// while plan mode stays enabled.
			if (this.session.isStreaming) {
				await this.session.followUp(feedback.trim());
			} else {
				await this.session.prompt(feedback.trim());
			}
			return this.host.context.success(command.id, "approve_plan", { decision, dispatched: true });
		}
		if (decision === "reject") {
			await exitPlanModeForSession(this.session, this.#previousTools);
			this.#previousTools = undefined;
			return this.host.context.success(command.id, "approve_plan", { decision, dispatched: false });
		}

		// approve
		const planFilePath = state?.planFilePath;
		if (!state?.enabled || !planFilePath) {
			return this.host.context.error(command.id, "approve_plan", "Plan mode is not enabled", "plan_not_active");
		}
		const planContent = await readPlanFile(planFilePath, {
			localProtocolOptions: this.#localProtocolOptions,
			cwd: this.session.sessionManager.getCwd(),
		});
		if (planContent === null) {
			return this.host.context.error(
				command.id,
				"approve_plan",
				`Plan file not found: ${planFilePath}`,
				"plan_not_found",
			);
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
			await this.session.setModel(match);
		} else if (model !== undefined) {
			return this.host.context.error(command.id, "approve_plan", 'model must be a "provider/modelId" selector');
		}
		const title = humanizePlanTitle(path.basename(planFilePath).replace(/\.md$/i, ""));
		await exitPlanModeForSession(this.session, this.#previousTools);
		this.#previousTools = undefined;
		await dispatchApprovedPlan(this.session, {
			planFilePath,
			title,
			planContent,
			preserveContext: true,
		});
		return this.host.context.success(command.id, "approve_plan", { decision, dispatched: true });
	}
}
