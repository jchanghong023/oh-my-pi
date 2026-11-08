import type { IServerChannel } from "../../../../vendor/zcode-frontend/packages/rpc/src/channels.shared";
import type { Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { WEBGUI_UNAVAILABLE_CODE } from "../../../../vendor/zcode-frontend/preview/session-info";

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
	signal: AbortSignal;
}

export type WebGuiMethod = (...args: unknown[]) => unknown | Promise<unknown>;

export interface WebGuiServiceDefinition extends IServerChannel<WebGuiServiceContext> {
	readonly name: string;
	dispose(): void;
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
