import type { PrimaryAgentId } from "@oh-my-pi/pi-tui/status-line/types";

export type { PrimaryAgentId };

export interface PrimaryAgentProfile {
	readonly id: PrimaryAgentId;
	readonly label: string;
	readonly systemPrompt?: string;
	readonly restrictTools: boolean;
	readonly allowedToolNames?: Readonly<Record<string, true>>;
}
