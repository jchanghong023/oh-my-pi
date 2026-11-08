import { createDevWorkbenchHost, DevWorkbenchStartError, getOrStartDevWorkbench } from "../dev-workbench/host";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { closeNativeAttachments } from "./native-attachments";
import { bindNativeWebGuiCommandEnvironment } from "./native-command-host";
import { installNativeWebGuiSessionOperations } from "./native-command-session-operations";
import { closeNativeWebGuiSketches, fetchNativeWebGuiSketch } from "./native-command-sketch";
import {
	disposeNativeWebGuiCommands,
	stopNativeWebGuiCommands,
	beginNativeWebGuiHostStop,
	cancelNativeWebGuiCommandInputs,
	prepareNativeWebGuiCommands,
	nativeWebGuiCommands,
	executeNativeWebGuiCommand,
} from "./native-commands";
import { bindWebGuiCollabProjection, webGuiCollabGuest } from "./native-command-collaboration";
import {
	reportNativeWebGuiMediaState,
	disconnectNativeWebGuiMedia,
	registerNativeWebGuiInputOrigin,
	forgetNativeWebGuiInputOrigin,
} from "./native-command-modes";
import { configureWebGuiNativePorts, type WebGuiNativePorts } from "./native-session-host";
import { beginWebGuiConnectionHandoff, retireWebGuiConnectionsForHandoff } from "./rpc-server";

const ports: WebGuiNativePorts = {
	createSession: async options => {
		const cwd = options.cwd ?? getProjectDir();
		const source = await (options.settings ?? options.settingsManager ?? Settings.current);
		const settings = source
			? await source.cloneForCwd(cwd)
			: await Settings.loadIsolated({ cwd, agentDir: options.agentDir ?? getAgentDir() });
		return createAgentSession({ ...options, settings });
	},
	installSessionOperations: installNativeWebGuiSessionOperations,
	prepareCommands: prepareNativeWebGuiCommands,
	listCommands: nativeWebGuiCommands,
	executeCommand: executeNativeWebGuiCommand,
	collabGuest: webGuiCollabGuest,
	bindCollabProjection: bindWebGuiCollabProjection,
	reportMediaState: reportNativeWebGuiMediaState,
	disconnectMedia: disconnectNativeWebGuiMedia,
	registerInputOrigin: registerNativeWebGuiInputOrigin,
	forgetInputOrigin: forgetNativeWebGuiInputOrigin,
	stopCommands: stopNativeWebGuiCommands,
	beginHostStop: beginNativeWebGuiHostStop,
	cancelCommandInputs: cancelNativeWebGuiCommandInputs,
	disposeCommands: disposeNativeWebGuiCommands,
	bindCommandEnvironment: bindNativeWebGuiCommandEnvironment,
	closeAttachments: closeNativeAttachments,
	closeSketches: closeNativeWebGuiSketches,
	fetchSketch: fetchNativeWebGuiSketch,
	createDevHost: createDevWorkbenchHost,
	startDevHost: getOrStartDevWorkbench,
	recoverDevHost: error => (error instanceof DevWorkbenchStartError ? error.host : undefined),
	beginHandoff: beginWebGuiConnectionHandoff,
	retireConnections: retireWebGuiConnectionsForHandoff,
};

/** Explicit command/mode entry installs real native dependencies without starting an Agent or listener. */
export function activateNativeWebGuiComposition(): void {
	configureWebGuiNativePorts(ports);
}
