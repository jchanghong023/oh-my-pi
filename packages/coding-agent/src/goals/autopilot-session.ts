import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type CustomMessage, isUserAuthoredMessage } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import {
	buildGoalAutoOrchestrateMessage,
	canBuildGoalAutoOrchestrateNotice,
	GOAL_AUTO_ORCHESTRATE_CONTEXT_TYPE,
	GoalAutopilotRequest,
} from "./request-context";
import { GoalAutopilotCompletionRequest } from "./runtime";
import type { LocalGoalModeState } from "./state";

export const GOAL_AUTOPILOT_ADMISSION_ENTRY = "goal-autopilot-admission";

type Run = GoalAutopilotRequest["run"];

interface InitialSource {
	goalId: string;
	sessionId: string;
	sessionGeneration: number;
	manualResume: boolean;
}

type QueuedDelivery = "initial" | AgentMessage;

interface GoalAutopilotSessionHost {
	getState(): LocalGoalModeState | undefined;
	sessionId(): string;
	sessionGeneration(): number;
	promptGeneration(): number;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isMain(): boolean;
	branch(): readonly SessionEntry[];
	messages(): readonly AgentMessage[];
	enabledTools(): readonly string[];
	continuationPrompt(): string | undefined;
	isClassifierRefusal(message: AssistantMessage): boolean;
	flushUsage(): Promise<void>;
}

/** Owns volatile Autopilot request and notice provenance. The session controls delivery and journal writes. */
export class GoalAutopilotSession {
	readonly #initialSources = new WeakMap<AgentMessage, InitialSource>();
	#run?: Run;
	#resumeSource?: { goalId: string; sessionGeneration: number };
	#admission?: { run: Run; promptGeneration: number; awaitingResponse: boolean };

	constructor(private readonly host: GoalAutopilotSessionHost) {}

	stateChanged(previous: LocalGoalModeState | undefined, state: LocalGoalModeState | undefined): void {
		const run = this.#run;
		if (run && state?.goal.id !== run.goalId) this.#run = undefined;
		else if (run && (state?.enabled !== previous?.enabled || state?.goal.status !== previous?.goal.status)) {
			this.#run = {
				goalId: run.goalId,
				sessionGeneration: run.sessionGeneration,
				...(state?.goal.status === "budget-limited" && state.enabled ? { review: run.review } : {}),
			};
		}
		if (!state?.enabled || state.goal.id !== this.#resumeSource?.goalId) this.#resumeSource = undefined;
	}

	resume(goalId: string, source: "explicit" | "restored"): void {
		const state = this.host.getState();
		if (
			!this.host.isMain() ||
			this.host.isDisposed() ||
			state?.autoOrchestrate !== true ||
			!state.enabled ||
			state.goal.id !== goalId
		) {
			return;
		}
		const sessionGeneration = this.host.sessionGeneration();
		const currentRun = this.#run?.goalId === goalId && this.#run.sessionGeneration === sessionGeneration;
		if (source === "restored" && currentRun) return;
		const hasReceipt = this.host.branch().some(
			entry => entry.type === "custom" && entry.customType === GOAL_AUTOPILOT_ADMISSION_ENTRY && entry.data === goalId,
		);
		if (currentRun || hasReceipt) {
			// Resuming creates a new run; no response from the earlier run is current.
			this.#run = { goalId, sessionGeneration };
			this.#admission = hasReceipt
				? undefined
				: { run: this.#run, promptGeneration: this.host.promptGeneration(), awaitingResponse: false };
			this.#resumeSource = undefined;
		} else if (source === "explicit") {
			this.#resumeSource = { goalId, sessionGeneration };
		}
	}

	pendingResumeId(message?: AgentMessage): string | undefined {
		const resume = this.#resumeSource;
		if (resume?.sessionGeneration !== this.host.sessionGeneration() || resume.goalId !== this.host.getState()?.goal.id)
			return undefined;
		if (
			message &&
			(!isUserAuthoredMessage(message) ||
				(message.role === "user" && (message.synthetic || message.attribution === "agent")))
		) {
			return undefined;
		}
		return resume.goalId;
	}

	continuationResumeId(customType: string, text: string, initialGoalId?: string): string | undefined {
		if (initialGoalId !== undefined || customType !== "goal-continuation") return undefined;
		const resumeGoalId = this.pendingResumeId();
		return resumeGoalId !== undefined && text === this.host.continuationPrompt() ? resumeGoalId : undefined;
	}

	rememberInitialSource(message: AgentMessage, goalId: string, manualResume = false): void {
		// Stop can return the same message to the queue. Keep its ownership until the transcript changes.
		this.#initialSources.set(message, {
			goalId,
			sessionId: this.host.sessionId(),
			sessionGeneration: this.host.sessionGeneration(),
			manualResume,
		});
	}

	messageStarted(message: AgentMessage): void {
		// Dequeue preparation can be rolled back before genuine delivery starts.
		this.#initialSources.delete(message);
	}

	#currentInitialSource(message: AgentMessage): InitialSource | undefined {
		const source = this.#initialSources.get(message);
		return source?.sessionGeneration === this.host.sessionGeneration() &&
			source.sessionId === this.host.sessionId() &&
			source.goalId === this.host.getState()?.goal.id
			? source
			: undefined;
	}

	captureRequest(
		messages: readonly AgentMessage[],
		acceptedSteering: readonly AgentMessage[] | undefined,
		signal?: AbortSignal,
	): GoalAutopilotRequest | GoalAutopilotCompletionRequest | undefined {
		const state = this.host.getState();
		if (
			signal?.aborted ||
			this.host.isDisposed() ||
			!this.host.isMain() ||
			!state?.autoOrchestrate ||
			!state.enabled ||
			(state.goal.status !== "active" && state.goal.status !== "budget-limited")
		) {
			return;
		}
		// At the steering handoff, recapture only for an accepted initial source, not ordinary steering.
		if (acceptedSteering && !acceptedSteering.some(message => this.#currentInitialSource(message))) return;
		const { id: goalId, status } = state.goal;
		const generation = this.host.promptGeneration();
		const sessionGeneration = this.host.sessionGeneration();
		if (this.#run?.goalId !== goalId || this.#run.sessionGeneration !== sessionGeneration) {
			if (status !== "active") return;
			if (!acceptedSteering && !messages.some(message => this.#currentInitialSource(message))) return;
			this.#resumeSource = undefined;
			this.#run = { goalId, sessionGeneration };
			this.#admission = { run: this.#run, promptGeneration: generation, awaitingResponse: false };
		}
		const run = this.#run;
		if (status === "budget-limited" && !run.review) return;
		const admission = this.#admission;
		if (admission?.run === run && admission.promptGeneration === generation) admission.awaitingResponse = true;
		const isCurrent = (): boolean => {
			const current = this.host.getState();
			return (
				!signal?.aborted &&
				!this.host.isDisposed() &&
				this.host.isStreaming() &&
				this.#run === run &&
				run.currentRequest === request &&
				this.host.sessionGeneration() === sessionGeneration &&
				this.host.promptGeneration() === generation &&
				current?.autoOrchestrate === true &&
				current.enabled &&
				current.goal.id === goalId &&
				current.goal.status === status
			);
		};
		const request =
			status === "budget-limited"
				? new GoalAutopilotCompletionRequest(run, isCurrent)
				: new GoalAutopilotRequest(run, isCurrent, () => this.host.flushUsage());
		run.currentRequest = request;
		return request;
	}

	responseEnded(message: AssistantMessage, promptGeneration: number): string | undefined {
		const admission = this.#admission;
		if (!admission) return undefined;
		if (
			admission.run !== this.#run ||
			admission.run.sessionGeneration !== this.host.sessionGeneration() ||
			admission.promptGeneration !== promptGeneration
		) {
			this.#admission = undefined;
			return undefined;
		}
		if (!admission.awaitingResponse) return undefined;
		admission.awaitingResponse = false;
		// Failed attempts do not prove delivery. Leave admission pending for the next native attempt.
		if (message.stopReason === "error" || message.stopReason === "aborted" || this.host.isClassifierRefusal(message)) {
			return undefined;
		}
		this.#admission = undefined;
		return admission.run.goalId;
	}

	canPersistAdmission(goalId: string): boolean {
		return this.host.getState()?.goal.id === goalId;
	}

	suppressesKeywordNotice(initialGoalId?: string): boolean {
		const state = this.host.getState();
		return state?.autoOrchestrate === true && state.goal.id === initialGoalId;
	}

	prepareQueuedDelivery(
		messages: readonly AgentMessage[],
		userMessages: readonly AgentMessage[],
	): QueuedDelivery | undefined {
		if (messages.some(message => this.#currentInitialSource(message))) return "initial";
		if (this.pendingResumeId() === undefined) return undefined;
		return userMessages.find(message => this.pendingResumeId(message) !== undefined);
	}

	queuedNotice(messages: readonly AgentMessage[], delivery: QueuedDelivery | undefined): CustomMessage | undefined {
		if (delivery && delivery !== "initial") {
			const goalId = this.pendingResumeId(delivery);
			if (goalId !== undefined) this.rememberInitialSource(delivery, goalId, true);
		}
		for (const message of messages) {
			const source = this.#currentInitialSource(message);
			if (!source || source.manualResume) continue;
			const notice = this.initialNotice(source.goalId);
			if (notice) return notice;
		}
		return undefined;
	}

	initialNotice(initialGoalId: string | undefined): CustomMessage | undefined {
		const state = this.host.getState();
		if (
			!canBuildGoalAutoOrchestrateNotice(state) ||
			this.host.isDisposed() ||
			initialGoalId !== state.goal.id ||
			this.#hasNotice(state.goal.id)
		) {
			return undefined;
		}
		return buildGoalAutoOrchestrateMessage(state, this.host.enabledTools());
	}

	previewCompactionNotice(): CustomMessage | undefined {
		const state = this.host.getState();
		if (!canBuildGoalAutoOrchestrateNotice(state) || this.host.isDisposed()) return undefined;
		return buildGoalAutoOrchestrateMessage(state, this.host.enabledTools());
	}

	compactionNotice(entryId: string, preview?: { notice: CustomMessage | undefined }): CustomMessage | undefined {
		const state = this.host.getState();
		if (
			!canBuildGoalAutoOrchestrateNotice(state) ||
			this.host.isDisposed() ||
			this.#hasNotice(state.goal.id, entryId)
		) {
			return undefined;
		}
		// Keep the exact notice used in the commit's token projection, including its tool snapshot.
		const notice = preview ? preview.notice : buildGoalAutoOrchestrateMessage(state, this.host.enabledTools());
		if (!notice || !isRecord(notice.details) || notice.details.goalId !== state.goal.id) return undefined;
		notice.details = { ...notice.details, compactionEntryId: entryId };
		return notice;
	}

	#hasNotice(goalId: string, compactionEntryId?: string): boolean {
		const belongsToEvent = (details: unknown): boolean =>
			isRecord(details) &&
			details.goalId === goalId &&
			(compactionEntryId === undefined || details.compactionEntryId === compactionEntryId);
		return (
			this.host.branch().some(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === GOAL_AUTO_ORCHESTRATE_CONTEXT_TYPE &&
					belongsToEvent(entry.details),
			) ||
			this.host.messages().some(
				message =>
					message.role === "custom" &&
					message.customType === GOAL_AUTO_ORCHESTRATE_CONTEXT_TYPE &&
					belongsToEvent(message.details),
			)
		);
	}
}
