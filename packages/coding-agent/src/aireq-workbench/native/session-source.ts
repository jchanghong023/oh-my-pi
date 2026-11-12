export type AIReqNativeSessionInfo =
	| { bound: false }
	| {
			bound: true;
			cwd: string;
			sessionId: string;
			sessionName: string | null;
			model: { provider: string; id: string; name: string } | null;
			busy: boolean;
	  };
import type { AgentSession } from "../../session/agent-session";

export function readWebGuiSessionInfo(session: AgentSession): AIReqNativeSessionInfo {
	const model = session.model;
	return {
		bound: true,
		cwd: session.sessionManager.getCwd(),
		sessionId: session.sessionManager.getSessionId(),
		sessionName: session.sessionName ?? null,
		model: model ? { provider: model.provider, id: model.id, name: model.name } : null,
		busy: session.isBusyForSnapshot,
	};
}
