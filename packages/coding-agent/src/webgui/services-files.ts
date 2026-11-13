import * as os from "node:os";
import type { ISystemService } from "../../../../vendor/zcode-frontend/packages/services/src/system/system";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { SystemInfo } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import {
	type WebGuiMethod,
	WebGuiNotImplementedError,
	type WebGuiServiceContext,
	type WebGuiServiceDefinition,
} from "./rpc-contract";
import { createWebGuiService } from "./service-channel";

function unavailable(feature: string): WebGuiMethod {
	return () => {
		throw new WebGuiNotImplementedError(feature);
	};
}

/** Host identity and explicit capability errors for the browser surface. */
export function createSystemServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	context.signal.throwIfAborted();
	return [
		createWebGuiService(ServiceChannels.System, {
			info: (): SystemInfo => ({ homedir: os.homedir(), platform: process.platform }),
			// Intranet probing is not part of the minimal browser surface.
			probeIntranet: unavailable("system.probeIntranet"),
		} satisfies Record<keyof ISystemService, WebGuiMethod>),
		createWebGuiService(ServiceChannels.File, {
			searchWorkspaceFiles: unavailable("file.searchWorkspaceFiles"),
			readdir: unavailable("file.readdir"),
			stat: unavailable("file.stat"),
			checkFilesExist: unavailable("file.checkFilesExist"),
			resolvePath: unavailable("file.resolvePath"),
			ensureConversationWorkspace: unavailable("file.ensureConversationWorkspace"),
			createDefaultWorkspace: unavailable("file.createDefaultWorkspace"),
			createScratchWorkspace: unavailable("file.createScratchWorkspace"),
			readTextFile: unavailable("file.readTextFile"),
			readMediaPreview: unavailable("file.readMediaPreview"),
			readFileRange: unavailable("file.readFileRange"),
			readBinaryPreview: unavailable("file.readBinaryPreview"),
			listWorkspaceFilesLength: unavailable("file.listWorkspaceFilesLength"),
			listWorkspaceFilesRange: unavailable("file.listWorkspaceFilesRange"),
			readWorkspaceFileSearchIgnore: unavailable("file.readWorkspaceFileSearchIgnore"),
			applyWorkspaceFileSearchIgnoreTransform: unavailable("file.applyWorkspaceFileSearchIgnoreTransform"),
			writeWorkspaceFileSearchIgnore: unavailable("file.writeWorkspaceFileSearchIgnore"),
		}),
	];
}
