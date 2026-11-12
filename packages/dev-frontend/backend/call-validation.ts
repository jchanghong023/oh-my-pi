import type { DevRemoteCall, DevRemotePath } from "./contract.js";

type ArgumentKind = "string" | "number" | "boolean" | "object" | "strings" | "optionalString";
/** Shallow wire-shape checks only; domain rules stay with the owning operation. */
const argumentsByPath = {
	readWorkflow: ["object"],
	command: ["object", "object", "number"],
	retryMaterial: ["string", "object"],
	retrySession: ["object"],
	readPrHandoff: ["object"],
	createFreeChat: ["string"],
	readFreeChat: ["string"],
	readRecentFreeChats: ["string"],
	selectProject: ["optionalString"],
	"progress.assignOwner": ["string", "string", "string"],
	"progress.updateSr": ["string", "string", "string", "number", "string"],
	"planning.updateSr": ["string", "string", "string", "object"],
	"projects.saveRepository": ["object"],
	"projects.readDevelopmentRoot": ["string", "optionalString"],
	"projects.listDirectories": [],
	"projects.checkProjectDirectory": ["string", "strings"],
	"projects.checkDevelopmentDirectory": ["string", "string"],
	"projects.checkSharedProjectDirectory": ["string", "string"],
	"models.read": [],
	"models.save": ["object"],
	"models.samples": [],
	"models.revision": [],
	"models.bindingChanged": ["object"],
	"prompts.read": [],
	"prompts.updateDraft": ["object"],
	"prompts.save": ["object"],
	"skills.list": ["object"],
	"skillDesign.session": ["string"],
	"skillDesign.binding": ["string"],
	"skillDesign.workspaceIdentity": ["string"],
	"skillDesign.read": ["string"],
	"skillDesign.saveDraft": ["string", "object"],
	"skillDesign.prompt": ["string", "object"],
	"skillDesign.temporaryDirectory": ["string"],
	"skillDesign.readPreview": ["string"],
	"skillDesign.listSkills": ["string"],
	"skillDesign.savePreview": ["string", "string", "string", "string"],
	"collaboration.peers": ["optionalString"],
	"prototype.setProposalMergeScenario": ["string", "string", "string"],
	"prototype.directoryIssue": ["string"],
	"prototype.restoreDirectory": ["string"],
	"prototype.readPrHandoff": ["object", "optionalString"],
	"progressScheduler.read": [],
	"progressScheduler.queryTasks": ["object", "number", "number"],
	"progressScheduler.queryRuns": ["object", "number", "number"],
	"progressScheduler.readRun": ["string"],
	"progressScheduler.setProjectEnabled": ["string", "boolean"],
	"progressScheduler.configure": ["boolean", "number"],
	"progressScheduler.runNow": ["object"],
	"progressScheduler.advance": [],
} satisfies Record<DevRemotePath, readonly ArgumentKind[]>;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function matches(kind: ArgumentKind, value: unknown): boolean {
	switch (kind) {
		case "object":
			return object(value);
		case "strings":
			return Array.isArray(value) && value.every(item => typeof item === "string");
		case "optionalString":
			return value == null || typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		default:
			return typeof value === kind;
	}
}
export function validateDevRemoteCall(input: unknown): DevRemoteCall {
	if (!object(input) || typeof input.path !== "string" || !Array.isArray(input.args))
		throw Object.assign(new Error("Expected {path,args}"), { code: "INVALID_ARGUMENT", status: 400 });
	if (!Object.hasOwn(argumentsByPath, input.path))
		throw Object.assign(new Error("Unknown Dev API path"), { code: "UNKNOWN_PATH", status: 404 });
	const path = input.path as DevRemotePath;
	const shape: readonly ArgumentKind[] = argumentsByPath[path];
	const args: unknown[] = input.args;
	if (
		args.length > shape.length ||
		shape.some((kind, index) => !matches(kind, args[index])) ||
		(input.selection !== undefined && !object(input.selection))
	)
		throw Object.assign(new Error(`Invalid arguments for ${path}`), { code: "INVALID_ARGUMENT", status: 400 });
	if (path === "command" && (!object(args[0]) || typeof args[0].type !== "string"))
		throw Object.assign(new Error("Invalid workflow action"), { code: "INVALID_ACTION", status: 400 });
	return input as unknown as DevRemoteCall;
}
