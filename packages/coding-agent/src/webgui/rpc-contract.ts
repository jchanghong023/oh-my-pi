import type { IServerChannel } from "../../../../vendor/zcode-frontend/packages/rpc/src/channels.shared";
import type { Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { WEBGUI_UNAVAILABLE_CODE } from "../../../../vendor/zcode-frontend/preview/session-info";
import type { AgentSession } from "../session/agent-session";

export {
	WEBGUI_RPC_PATH,
	WEBGUI_SERVER_INFO_PATH,
	WEBGUI_UNAVAILABLE_CODE,
} from "../../../../vendor/zcode-frontend/preview/session-info";
export type { IServerChannel } from "../../../../vendor/zcode-frontend/packages/rpc/src/channels.shared";
export type { CancellationToken, Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";

export interface WebGuiServiceContext {
	connectionId: string;
	projectId?: string;
	workspacePath?: string;
	readonly nativeSession?: AgentSession;
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
	readonly code = WEBGUI_UNAVAILABLE_CODE;
	readonly feature: string;

	constructor(feature: string) {
		super(`WebGUI business operation is not connected: ${feature}`);
		this.name = "WebGuiNotImplementedError";
		this.feature = feature;
	}
}
