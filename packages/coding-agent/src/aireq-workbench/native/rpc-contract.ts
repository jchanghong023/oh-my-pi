import type { IServerChannel } from "../../../../../packages/aireq-frontend/packages/rpc/src/channels.shared";
import type { Event } from "../../../../../packages/aireq-frontend/packages/rpc/src/foundation";
import type { AgentSession } from "../../session/agent-session";
import type { AIReqNativeInputKind } from "../../spec-driven/actors";

export type { IServerChannel } from "../../../../../packages/aireq-frontend/packages/rpc/src/channels.shared";
export type { CancellationToken, Event } from "../../../../../packages/aireq-frontend/packages/rpc/src/foundation";

export interface AIReqNativeServiceOwner {
	assertCurrent(context: WebGuiServiceContext, sessionId?: string): void;
	assertSession(session: AgentSession): void;
	prepare(context: WebGuiServiceContext): Promise<AgentSession>;
	runInput<T>(
		session: AgentSession,
		operation: () => Promise<T>,
		text?: string,
		kind?: AIReqNativeInputKind,
	): Promise<T>;
	stop(session: AgentSession): Promise<void>;
}
export interface WebGuiServiceContext {
	connectionId: string;
	projectId?: string;
	workspacePath?: string;
	readonly agentDir?: string;
	readonly nativeOwner?: AIReqNativeServiceOwner;
	readonly nativeSession?: AgentSession;
	readonly inputAllowed?: boolean;
	signal: AbortSignal;
}

export type WebGuiMethod = (...args: unknown[]) => unknown | Promise<unknown>;
export interface WebGuiHandoffBinding {
	sessionId: string;
	interactionId: string;
	connectionId: string;
	clientId?: string;
}

export interface WebGuiServiceDefinition extends IServerChannel<WebGuiServiceContext> {
	readonly name: string;
	dispose(): void;
	/** A retiring connection may project only its already-admitted opaque control action. */
	drainHandoffFrame?(arg: unknown, frame: unknown, binding: WebGuiHandoffBinding): unknown | undefined;
}

export interface WebGuiServiceOptions {
	readonly events?: Readonly<Record<string, Event<unknown>>>;
	readonly dynamicEvents?: Readonly<Record<string, (arg: unknown, context: WebGuiServiceContext) => Event<unknown>>>;
	readonly dispose?: () => void;
}

export class WebGuiNotImplementedError extends Error {
	readonly code = "OMP_WEBGUI_NOT_IMPLEMENTED";
	readonly feature: string;

	constructor(feature: string) {
		super(`AIReq native capability is unavailable: ${feature}`);
		this.name = "AIReqNativeCapabilityError";
		this.feature = feature;
	}
}
