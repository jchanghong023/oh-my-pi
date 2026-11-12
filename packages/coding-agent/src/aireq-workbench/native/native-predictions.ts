import type { AgentSession } from "../../session/agent-session";
import { ComposerPredictionController } from "../../modes/controllers/composer-prediction-controller";
import {
	sameAIReqNativeSurfaceOwner,
	type AIReqNativeSurfaceTarget,
	type AIReqNativePredictionAction,
	type AIReqNativePredictionSnapshot,
} from "./native-surface-types";

/** One native controller per actor; browser subscriptions never run paid side turns. */
class NativePredictions {
	readonly controller: ComposerPredictionController;
	readonly detach: () => void;
	generation = 0;
	closed = false;
	constructor(
		readonly session: AgentSession,
		readonly target: AIReqNativeSurfaceTarget,
		readonly editor: () => string,
		readonly changed: () => void,
		readonly current: () => boolean,
		readonly updateDraft: (text: string) => void,
	) {
		this.controller = new ComposerPredictionController({
			settings: session.settings,
			viewSession: session,
			focusedAgentId: undefined,
			editor: { getText: editor },
			ui: {
				requestRender: () => {
					if (!this.closed) changed();
				},
			},
			isCurrent: () => !this.closed && current(),
		});
		this.detach = session.subscribe(event => {
			if (event.type === "agent_start") this.cancel();
			if (event.type === "agent_end" && event.isTerminal !== false && !this.closed && current()) {
				this.generation++;
				this.controller.request();
				changed();
			}
		});
	}
	cancel(): void {
		this.generation++;
		this.controller.cancel();
		if (!this.closed) this.changed();
	}
	snapshot(target: AIReqNativeSurfaceTarget): AIReqNativePredictionSnapshot {
		return { target, generation: this.generation, choices: this.editor() ? [] : (this.controller.choices ?? []) };
	}
}
const predictions = new WeakMap<AgentSession, NativePredictions>();
export function bindAIReqNativePredictions(
	session: AgentSession,
	target: AIReqNativeSurfaceTarget,
	editor: () => string,
	changed: () => void,
	current: () => boolean,
	updateDraft: (text: string) => void,
): void {
	const existing = predictions.get(session);
	if (existing) {
		if (!sameAIReqNativeSurfaceOwner(existing.target, target))
			throw new Error("Native prediction owner/round changed without settlement");
		return;
	}
	predictions.set(session, new NativePredictions(session, { ...target }, editor, changed, current, updateDraft));
}
function exact(session: AgentSession, target: AIReqNativeSurfaceTarget): NativePredictions {
	const state = predictions.get(session);
	if (
		!state ||
		state.closed ||
		session.isDisposed ||
		!state.current() ||
		!sameAIReqNativeSurfaceOwner(state.target, target)
	)
		throw new Error("Native prediction owner/round has ended");
	return state;
}
export function aiReqNativePredictionSnapshot(
	session: AgentSession,
	target: AIReqNativeSurfaceTarget,
): AIReqNativePredictionSnapshot {
	return exact(session, target).snapshot(target);
}
/** Draft changes retire an in-flight result even when the user later clears the draft. */
export function cancelAIReqNativePredictions(session: AgentSession): void {
	predictions.get(session)?.cancel();
}
export function aiReqNativePredictionAction(
	session: AgentSession,
	target: AIReqNativeSurfaceTarget,
	action: AIReqNativePredictionAction,
): AIReqNativePredictionSnapshot {
	const state = exact(session, target);
	if (action.type === "draft") {
		if (typeof action.text !== "string") throw new Error("Native composer draft must be text");
		state.updateDraft(action.text);
	} else if (action.type === "cancel") state.cancel();
	else {
		if (action.generation !== state.generation) throw new Error("Native prediction generation has ended");
		if (state.editor() || !state.controller.choices?.length)
			throw new Error("No current native prediction is offered");
		if (action.type === "shown") state.controller.shown();
		else if (action.type === "accepted") {
			if (
				!Number.isInteger(action.rank) ||
				action.rank < 0 ||
				action.rank >= (state.controller.choices?.length ?? 0)
			)
				throw new Error("Invalid native prediction alternative");
			state.controller.accepted(action.rank);
		} else throw new Error("Browser cannot request a billed native prediction");
	}
	return state.snapshot(target);
}
/** Cancel before native disposal, then await even providers which resolve after abort (usage must persist). */
export async function settleAIReqNativePredictions(session: AgentSession): Promise<void> {
	const state = predictions.get(session);
	if (!state) return;
	state.closed = true;
	state.detach();
	state.cancel();
	await state.controller.settled();
	if (predictions.get(session) === state) predictions.delete(session);
}
