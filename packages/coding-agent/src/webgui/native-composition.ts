import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { cfgToolsApprovalMode } from "../tools/settings";
import { configureWebGuiNativePorts, type WebGuiNativePorts } from "./native-session-host";

const ports: WebGuiNativePorts = {
	createSession: async options => {
		const cwd = options.cwd ?? getProjectDir();
		const source = await (options.settings ?? options.settingsManager ?? Settings.current);
		const settings = source
			? await source.cloneForCwd(cwd)
			: await Settings.loadIsolated({ cwd, agentDir: options.agentDir ?? getAgentDir() });
		// WebGUI 不提供权限审批界面：会话固定以 yolo 跑，所有工具调用直接执行。
		cfgToolsApprovalMode.override(settings, "yolo");
		return createAgentSession({ ...options, settings });
	},
};

/** Install browser chat dependencies without starting an Agent or listener. */
export function activateNativeWebGuiComposition(): void {
	configureWebGuiNativePorts(ports);
}
