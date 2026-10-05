import type { AgentSession } from "../../session/agent-session";
import type { ResetSessionContextResult } from "../../session/agent-session-types";

/** The business part of `/clear`; each host owns only its transcript presentation. */
export async function resetContextForCommand(
	session: Pick<
		AgentSession,
		"isCompacting" | "abortCompaction" | "resetSessionContext" | "sessionGeneration" | "isDisposed"
	>,
): Promise<ResetSessionContextResult | undefined> {
	const generation = session.sessionGeneration;
	if (session.isCompacting) {
		session.abortCompaction();
		while (session.isCompacting) {
			await Bun.sleep(10);
			if (session.sessionGeneration !== generation || session.isDisposed) {
				throw Object.assign(new Error("Session changed while resetting context."), { code: "session_changed" });
			}
		}
	}
	if (session.sessionGeneration !== generation || session.isDisposed) {
		throw Object.assign(new Error("Session changed while resetting context."), { code: "session_changed" });
	}
	return session.resetSessionContext();
}

export function formatResetContextResult(result: ResetSessionContextResult): string {
	const noun = result.droppedCount === 1 ? "message" : "messages";
	return `Context reset — ${result.droppedCount} ${noun} dropped; session continues.`;
}
