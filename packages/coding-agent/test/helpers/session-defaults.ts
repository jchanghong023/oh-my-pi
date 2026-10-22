import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		setActiveToolsByName: async (_toolNames: string[]) => {},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		isParentIrcSteer: () => false,
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
		// The executor's IRC wake monitor resolves its run cwd through the
		// session manager; fakes that spread these defaults must stay stubbable.
		sessionManager: {
			getCwd: () => process.cwd(),
			appendSessionInit: () => "",
		} as unknown as AgentSession["sessionManager"],
	} satisfies Partial<AgentSession>;
}
