import type { SettingProvenance } from "../config/settings";
import type { UserSettingSaveResult, UserSettingSnapshot } from "../config/user-settings";

export interface TeamModelRef {
	provider: string;
	modelId: string;
}
export type TeamConfigSource = Exclude<SettingProvenance, "env">;
export interface TeamMemberSlot {
	index: number;
	rawSelector: string;
	model: TeamModelRef | null;
	name?: string;
	status: "available" | "unavailable" | "unresolved";
	reasonCode?: string;
	reason?: string;
}
export interface TeamConfigIssue {
	code: string;
	message: string;
	target: "member" | "session_model" | "config" | "storage";
	list?: "userMembers" | "persistentMembers" | "effectiveMembers" | "preview.userMembers" | "preview.effectiveMembers";
	source?: SettingProvenance;
	index?: number;
	selector?: string;
	side?: "active" | "persistent";
}
export interface TeamConfigParticipant {
	index: number;
	label: string;
	model: TeamModelRef;
}
export interface TeamConfigPreviewInput {
	clientRevision: string;
	members: readonly (TeamModelRef | { rawSelector: string })[] | null;
}
export interface TeamConfigPreview {
	clientRevision: string;
	userMembers: TeamMemberSlot[] | null;
	effectiveMembers: TeamMemberSlot[] | null;
	source: TeamConfigSource | null;
	participants: TeamConfigParticipant[];
	issues: TeamConfigIssue[];
}
export interface TeamConfigSnapshot {
	profile: string | null;
	revision: string | null;
	userMembers?: TeamMemberSlot[] | null;
	persistentMembers?: TeamMemberSlot[] | null;
	effectiveMembers: TeamMemberSlot[] | null;
	source: TeamConfigSource | null;
	sessionModel: { model: TeamModelRef; name: string; available: boolean } | null;
	participants: TeamConfigParticipant[];
	issues: TeamConfigIssue[];
	writableScopes: "user"[];
	storage: {
		mode: UserSettingSnapshot["mode"];
		syncState: UserSettingSnapshot["syncState"];
		active: { readState: UserSettingSnapshot["active"]["readState"] };
		persistent: { readState: UserSettingSnapshot["persistent"]["readState"] };
	};
	preview?: TeamConfigPreview;
}
export interface TeamConfigModel {
	model: TeamModelRef;
	name: string;
	selectable: boolean;
	reasonCode?: string;
	reason?: string;
}
export interface TeamConfigModelsResult {
	models: TeamConfigModel[];
}
export interface TeamConfigSaveInput {
	scope: "user";
	expectedRevision: string;
	members: readonly TeamModelRef[] | null;
}
export interface TeamConfigSaveResult extends UserSettingSaveResult {
	config: TeamConfigSnapshot;
	effectiveMatchesRequested: boolean;
	effectiveNote?: string;
}
export interface TeamConfigErrorData extends UserSettingSaveResult {
	config?: TeamConfigSnapshot;
	issues?: TeamConfigIssue[];
	effectiveMatchesRequested?: boolean;
	effectiveNote?: string;
}
export type TeamConfigErrorCode =
	| "invalid_params"
	| "scope_not_allowed"
	| "invalid_config"
	| "revision_conflict"
	| "persistence_failed"
	| "execution_failed";
