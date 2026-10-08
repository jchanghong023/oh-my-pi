/**
 * Session-layer plan approval for the interactive TUI flow.
 *
 * The dispatch tail of the TUI plan-approval flow (`interactive-mode.ts`
 * `#approvePlan`) lives in this module so sessions and tests can exercise it
 * without the interactive mode. TUI-specific concerns (context
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
	/** Operator cancellation supplied by hosts that approve outside the active turn. */
	signal?: AbortSignal;
	/** True when the execution turn keeps the current context (no clear/compact happened). */
	preserveContext?: boolean;
	/** TUI hook invoked right before the synthetic prompt dispatch (overlay teardown). */
	beforeDispatch?: () => void;
	/** Invoked after the best-effort autosave attempt: the claimed path, or the error when it failed. */
	onAutosave?: (result: { savedPath: string | null; error?: Error }) => void;
}

function captureSessionGuard(session: AgentSession, signal?: AbortSignal): () => void {
	const sessionId = session.sessionId;
	const generation = session.sessionGeneration;
	const manager = session.sessionManager;
	return () => {
		if (signal?.aborted) throw new Error("Plan approval cancelled.");
		if (
			session.isDisposed ||
			session.sessionId !== sessionId ||
			session.sessionGeneration !== generation ||
			session.sessionManager !== manager
		) {
			throw Object.assign(new Error("Session changed during plan mode operation"), { code: "session_changed" });
		}
	};
}

/**
 * Shared tail of every plan approval: record the plan reference, autosave the
 * approved plan, seed an auto session name, and dispatch the synthetic
 * plan-approved prompt (queued as a follow-up when a run is live).
 */
export async function dispatchApprovedPlan(session: AgentSession, options: ApprovedPlanDispatchOptions): Promise<void> {
	const assertCurrentSession = captureSessionGuard(session, options.signal);
	assertCurrentSession();
	session.setPlanReferencePath(options.planFilePath);
	let autosavedPath: string | null = null;
	let autosaveError: Error | undefined;
	try {
		autosavedPath = await autosaveApprovedPlan({
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			title: options.title,
			planContent: options.planContent,
		});
	} catch (error) {
		// Autosave is best-effort in both hosts; approval intent stands.
		autosaveError = error instanceof Error ? error : new Error(String(error));
	}
	assertCurrentSession();
	options.onAutosave?.({ savedPath: autosavedPath, ...(autosaveError ? { error: autosaveError } : {}) });

	// Approved plans land in a fresh (or compacted) session whose first
	// user-visible turn is the synthetic plan-approved prompt. Seed an auto
	// name from the plan title (`setSessionName("auto")` is a no-op when the
	// user already named the session).
	const seededName = humanizePlanTitle(options.title);
	if (seededName && !session.sessionManager.getSessionName()) {
		await session.sessionManager.setSessionName(seededName, "auto");
	}
	assertCurrentSession();

	// Fires only on the dispatch path so the synthetic plan-approved prompt is
	// the source of the reference injection.
	session.markPlanReferenceSent();
	const planModePrompt = prompt.render(planModeApprovedPrompt, {
		planFilePath: options.planFilePath,
		planContent: options.planContent,
		contextPreserved: options.preserveContext === true,
	});
	options.beforeDispatch?.();
	assertCurrentSession();
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
			assertCurrentSession();
			await session.followUp(planModePrompt, undefined, { synthetic: true });
		}
	}
}
