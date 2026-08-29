export type PrimaryAgentId = "main" | "discuss";

export interface PrimaryAgentProfile {
	readonly id: PrimaryAgentId;
	readonly label: string;
	readonly systemPrompt?: string;
	readonly restrictTools: boolean;
	readonly allowedToolNames?: Readonly<Record<string, true>>;
}
