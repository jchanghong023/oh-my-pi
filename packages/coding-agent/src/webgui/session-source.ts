import type { WebGuiSessionInfo } from "../../../../vendor/zcode-frontend/preview/session-info";
import type { AgentSession } from "../session/agent-session";

export function readWebGuiSessionInfo(session: AgentSession): WebGuiSessionInfo {
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
