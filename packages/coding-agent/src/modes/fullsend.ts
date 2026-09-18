import { prompt } from "@oh-my-pi/pi-utils";
import fullsendNoticeTemplate from "../prompts/system/fullsend-notice.md" with { type: "text" };

/** Render the hidden execution-policy notice for the tools available to the session. */
export function renderFullsendNotice({ tools }: { tools: readonly string[] }): string {
	return prompt.render(fullsendNoticeTemplate, { tools }).trim();
}
