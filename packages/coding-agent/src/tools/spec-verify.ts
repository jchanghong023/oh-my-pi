import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { cfgBashEnabled } from "../exec/settings";
import verifyDescription from "../prompts/tools/spec-verify.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolveApprovalFromContext } from "./approval";
import { BashTool } from "./bash";

const schema = type({ validationId: "string > 0", "+": "reject" });
type Params = typeof schema.infer;

export class SpecVerifyTool implements AgentTool<typeof schema, BashToolDetails> {
	readonly name = "spec_verify";
	readonly label = "Approved verification";
	readonly description = verifyDescription.trim();
	readonly parameters = schema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly #bash: BashTool;

	constructor(private readonly session: ToolSession) {
		this.#bash = new BashTool(session);
	}

	#command(args: unknown): string {
		this.session.toolRestrictions?.assertAllowed(this.name);
		this.session.toolRestrictions?.assertAllowed("bash");
		if (this.session.getPlanModeState?.()?.enabled) throw new ToolError("Verification is unavailable in plan mode.");
		const params = schema(args);
		if (params instanceof type.errors) throw new ToolError(params.summary);
		const checks = this.session.approvedPlanChecks;
		if (!checks) throw new ToolError("No approved plan verification commands are available.");
		const check = checks.find(item => item.id === params.validationId);
		if (!check) throw new ToolError(`Unapproved validation ID: ${params.validationId}`);
		return check.command;
	}

	#commandApproval(command: string, context?: AgentToolContext): ToolApprovalDecision {
		const { userPolicies: policies } = resolveApprovalFromContext({ settings: this.session.settings });
		if (!cfgBashEnabled.get(this.session.settings) || policies.bash === "deny" || policies[this.name] === "deny") {
			return { tier: "exec", override: true, policy: "deny", reason: "Shell verification is disabled by policy." };
		}
		const approval = this.#bash.approval({ command }, context);
		if (typeof approval !== "string" && approval.policy === "deny") return approval;
		if (policies.bash === "prompt") {
			return { tier: "exec", override: true, policy: "prompt", reason: "Shell verification requires approval." };
		}
		return typeof approval === "string" || approval.policy === "allow" ? "exec" : { ...approval, tier: "exec" };
	}

	readonly approval = (args: unknown, context?: AgentToolContext): ToolApprovalDecision => {
		try {
			return this.#commandApproval(this.#command(args), context);
		} catch (error) {
			return {
				tier: "exec",
				override: true,
				policy: "deny",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	};

	readonly formatApprovalDetails = (args: unknown): string[] =>
		this.#bash.formatApprovalDetails({ command: this.#command(args) });

	async execute(
		toolCallId: string,
		params: Params,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const command = this.#command(params);
		const approval = this.#commandApproval(command, context);
		if (typeof approval !== "string" && approval.policy === "deny") {
			throw new ToolError(approval.reason ?? "Shell verification is not allowed.");
		}
		return this.#bash.execute(toolCallId, { command }, signal, onUpdate, context);
	}
}
