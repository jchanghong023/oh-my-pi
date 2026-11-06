import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import offlineNoticeTemplate from "../prompts/system/offline-notice.md" with { type: "text" };

interface OfflinePromptEnvironment {
	platform: NodeJS.Platform;
	/** User terminal shell, not the bash tool's execution language. */
	shell?: string;
}

/** Shared by CLI, SDK provider requests, and task session construction. */
export function getOfflineSystemNotice(
	offline: boolean | undefined,
	environment: OfflinePromptEnvironment = { platform: process.platform, shell: Bun.env.SHELL },
): string | undefined {
	if (!offline) return undefined;
	const linux = environment.platform === "linux";
	const shell = path.posix.basename(environment.shell ?? "");
	return prompt.render(offlineNoticeTemplate, { linux, csh: linux && (shell === "csh" || shell === "tcsh") }).trim();
}
