import type { AgentSession } from "../../src/session/agent-session";
import type { Browser, Page } from "puppeteer-core";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";

export type CoreUiCase = "subagent" | "workflow";

export interface SeededHistory {
	readonly sessionId: string;
	readonly filePath: string;
	readonly title: string;
	readonly userText: string;
	readonly assistantText: string;
}

export interface ControlledReply {
	readonly began: Promise<void>;
	readonly finished: Promise<void>;
	finish(): void;
}

export interface NativeBrowserCase {
	/** Initially blank; seed/configure the case before navigating to url. */
	readonly page: Page;
	readonly session: AgentSession;
	readonly url: string;
	seedHistory(title: string, userText: string, assistantText: string, historyCwd?: string): Promise<SeededHistory>;
	setReply(prefix: string, suffix: string, session?: AgentSession): ControlledReply;
	setFailure(reason: string, session?: AgentSession): void;
	sessionFor(sessionId: string): AgentSession;
	createSibling(): Promise<AgentSession>;
	resumeHistory(sessionId: string): Promise<AgentSession>;
	contextFor(session: AgentSession): WebGuiServiceContext;
	rejectNextPrompt(reason: string): void;
	close(): Promise<void>;
}

export interface CoreBrowserFixture {
	readonly browser: Browser;
	nativeCase(options?: { withSkill?: boolean }): Promise<NativeBrowserCase>;
	componentPage(kind: CoreUiCase): Promise<Page>;
	close(): Promise<void>;
}
