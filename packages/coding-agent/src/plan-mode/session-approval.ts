/**
 * Session-layer plan approval (requirement 5.3, rpc-ui-protocol.md).
 *
 * The dispatch tail of the TUI plan-approval flow (`interactive-mode.ts`
 * `#approvePlan`) lives here so the RPC `approve_plan` command and the
 * interactive TUI share one implementation. TUI-specific concerns (context
 * clearing, compaction, tool-presentation capture, overlay management, model
 * transitions) stay in the interactive mode; this module owns only the
 * session-visible steps: plan reference bookkeeping, autosave, auto-naming,
 * and the synthetic plan-approved prompt dispatch.
 */
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { autosaveApprovedPlan } from "./plan-autosave";
import { humanizePlanTitle } from "./approved-plan";

export interface ApprovedPlanDispatchOptions {
	planFilePath: string;
	title: string;
	planContent: string;
	/** True when the execution turn keeps the current context (no clear/compact happened). */
	preserveContext?: boolean;
	/** TUI hook invoked right before the synthetic prompt dispatch (overlay teardown). */
	beforeDispatch?: () => void;
}

/**
 * Shared tail of every plan approval: record the plan reference, autosave the
 * approved plan, seed an auto session name, and dispatch the synthetic
 * plan-approved prompt (queued as a follow-up when a run is live).
 */
export async function dispatchApprovedPlan(session: AgentSession, options: ApprovedPlanDispatchOptions): Promise<void> {
	session.setPlanReferencePath(options.planFilePath);
	try {
		await autosaveApprovedPlan({
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			title: options.title,
			planContent: options.planContent,
		});
	} catch {
		// Autosave is best-effort in both hosts; approval intent stands.
	}

	// Approved plans land in a fresh (or compacted) session whose first
	// user-visible turn is the synthetic plan-approved prompt. Seed an auto
	// name from the plan title (`setSessionName("auto")` is a no-op when the
	// user already named the session).
	const seededName = humanizePlanTitle(options.title);
	if (seededName && !session.sessionManager.getSessionName()) {
		await session.sessionManager.setSessionName(seededName, "auto");
	}

	// Fires only on the dispatch path so the synthetic plan-approved prompt is
	// the source of the reference injection.
	session.markPlanReferenceSent();
	const planModePrompt = prompt.render(planModeApprovedPrompt, {
		planFilePath: options.planFilePath,
		planContent: options.planContent,
		contextPreserved: options.preserveContext === true,
	});
	options.beforeDispatch?.();
	// A user turn queued during compaction was already fired before we got
	// here; preserve it and queue the hidden execution directive behind it as
	// a synthetic follow-up (same AgentBusyError fallback as the TUI path).
	if (session.isStreaming) {
		await session.followUp(planModePrompt, undefined, { synthetic: true });
	} else {
		try {
			await session.prompt(planModePrompt, { synthetic: true });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await session.followUp(planModePrompt, undefined, { synthetic: true });
		}
	}
}

export interface PlanModeSessionEntry {
	planFilePath: string;
	/** Tool set to restore on exit (captured before augmentation). */
	previousTools: string[];
}

/**
 * Session-level plan-mode entry (the TUI-free core of `#enterPlanMode`):
 * state lands before the tool partition, the built-in `write` tool is
 * re-activated for plan drafting, and the proposal handler routes plan
 * submissions through `preparePlanForReview`.
 */
export async function enterPlanModeForSession(
	session: AgentSession,
	options?: { planFilePath?: string; workflow?: "parallel" | "iterative" },
): Promise<PlanModeSessionEntry> {
	const planFilePath = options?.planFilePath ?? (session.getPlanReferencePath() || "local://PLAN.md");
	const previousTools = session.getEnabledToolNames();
	const previousPlanModeState = session.getPlanModeState();
	// Plan mode state must land before the tool partition (mirrors the TUI).
	session.setPlanModeState({
		enabled: true,
		planFilePath,
		workflow: options?.workflow ?? "parallel",
	});
	try {
		const augmentations = session.hasBuiltInTool("write") ? ["write"] : [];
		await session.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
	} catch (error) {
		session.setPlanModeState(previousPlanModeState);
		throw error;
	}
	session.setPlanProposalHandler?.(title => session.preparePlanForReview(title));
	if (session.isStreaming) {
		await session.sendPlanModeContext({ deliverAs: "steer" });
	}
	session.sessionManager.appendModeChange("plan", { planFilePath });
	return { planFilePath, previousTools };
}

/**
 * Session-level plan-mode exit: restore the captured (or current non-MCP)
 * tool set, drop the proposal handler, and clear the plan state.
 */
export async function exitPlanModeForSession(session: AgentSession, previousTools?: string[]): Promise<void> {
	const restoreTo =
		previousTools ??
		session.getEnabledToolNames().filter(name => session.hasBuiltInTool(name) || !name.startsWith("mcp__"));
	session.setPlanModeState(undefined);
	await session.setActiveToolsByName(restoreTo);
	session.setPlanProposalHandler?.(null);
}
