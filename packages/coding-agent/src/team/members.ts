/**
 * `/team` participant resolution.
 *
 * Rules (openspec/specs/team-discussion/spec.md §2.2):
 * - Ordered configured full model IDs resolve strictly, preserving duplicates.
 * - Unset or empty configuration uses the current session model.
 * - N = max(3, M) independent slots cycle through the M resolved members.
 * - The session model anchors alignment/synthesis, but is never appended to an
 *   explicit roster and must remain available even when absent from it.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { routedModelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import {
	formatModelStringWithRouting,
	resolveModelFromString,
	resolveProviderModelReference,
} from "../config/model-resolver";
import type { TeamParticipant } from "./types";

export interface TeamMembersInput {
	configuredMembers: readonly string[];
	/** Current model anchoring alignment/synthesis, independent of the roster. */
	sessionModel: Model | undefined;
	availableModels: readonly Model[];
}

export type TeamMembersResult =
	| { ok: true; participants: TeamParticipant[]; source: "configured" | "session-default" }
	| { ok: false; error: string };

function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Describe a non-string `team.members` entry for the error message. Settings
 * array validation only checks `Array.isArray`, so numbers/booleans/null from
 * config.yml reach this function; JSON.stringify(BigInt) throws, so those fall
 * back to the bare type name.
 */
function describeConfiguredEntry(entry: unknown): string {
	if (entry === null) return "null";
	let json: string | undefined;
	try {
		json = JSON.stringify(entry);
	} catch {
		// BigInt and cyclic values make the formatter itself throw.
		return typeof entry;
	}
	return json === undefined ? typeof entry : `${typeof entry} ${json}`;
}

/** Capability policy shared by discussion preflight and the configuration catalog. */
export function teamModelCapabilityIssue(model: Model): { code: string; message: string } | undefined {
	if (model.supportsTools === false || (model.kind !== undefined && model.kind !== "chat")) {
		return {
			code: "missing_capability",
			message: `Model ${modelKey(model)} does not support the chat tools and structured yield required by Team.`,
		};
	}
	return undefined;
}

/** Expand an explicit roster into the ordered proposer slots shared by preview and discussion. */
export function expandTeamRoster<T, U>(roster: readonly T[], project: (member: T, index: number) => U): U[] {
	if (roster.length === 0) return [];
	return Array.from({ length: Math.max(3, roster.length) }, (_, index) =>
		project(roster[index % roster.length]!, index),
	);
}

/** Resolve exact references against the allowed models, including their aliases. */
export function resolveTeamMemberReference(
	selector: string,
	models: readonly Model[],
	literalOnly = false,
): Model | undefined {
	const separator = selector.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = literalOnly ? selector.slice(0, separator) : selector.slice(0, separator).trim();
	const modelId = literalOnly ? selector.slice(separator + 1) : selector.slice(separator + 1).trim();
	// Several allowed upstream pins can share this literal ID. The first exact row is in scope.
	const exact = models.find(model => model.provider === provider && model.id === modelId);
	if (exact || literalOnly) return exact;
	const model = resolveProviderModelReference(provider, modelId, models);
	if (!model) return undefined;
	// Native resolution can synthesize these exact IDs from a row in the allowed pool.
	if ((model.provider === "amazon-bedrock" || model.provider === "openrouter") && model.id === modelId) return model;
	return models.some(candidate => routedModelsAreEqual(candidate, model)) ? model : undefined;
}

/** Resolve ordered independent proposer slots. Pure: no I/O, all inputs injected. */
export function resolveTeamParticipants(input: TeamMembersInput): TeamMembersResult {
	const sessionModel = input.sessionModel;
	if (!sessionModel) {
		return { ok: false, error: "/team requires a session model as its main agent, but no model is selected." };
	}

	// Settings only validate array-ness, not element types: a numeric/boolean/
	// null entry in config.yml must fail with the offending index instead of a
	// bare `entry.trim is not a function` TypeError (§2.2/§2.8: identify the offending entry).
	for (const [index, entry] of (input.configuredMembers as readonly unknown[]).entries()) {
		if (typeof entry !== "string") {
			return {
				ok: false,
				error: `team.members[${index}] must be a string (model selector), but got ${describeConfiguredEntry(entry)}. Fix it in config.yml.`,
			};
		}
	}
	const entries = input.configuredMembers.map(entry => entry.trim());
	const emptyIndex = entries.findIndex(entry => entry.length === 0);
	if (emptyIndex !== -1) {
		return {
			ok: false,
			error: `team.members[${emptyIndex}] is empty; configured model selectors must not be blank.`,
		};
	}
	const availableModels = [...input.availableModels];
	const resolvedMembers: Model[] = [];
	for (const entry of entries) {
		const model = resolveTeamMemberReference(entry, availableModels);
		if (!model) {
			return {
				ok: false,
				error: [
					`Model in team.members is unavailable: ${entry}`,
					"",
					"Fix or remove this entry and retry. /team will not silently drop unavailable models.",
					"Run `omp models` to see available models.",
				].join("\n"),
			};
		}
		resolvedMembers.push(model);
	}
	// Alignment/synthesis pin the exact session identity even when it is not a
	// proposer. A fuzzy sibling cannot silently replace an unavailable session.
	const sessionKey = modelKey(sessionModel);
	if (!availableModels.some(model => modelKey(model) === sessionKey)) {
		const resolved = resolveModelFromString(sessionKey, availableModels);
		const resolvedKey = resolved ? modelKey(resolved) : undefined;
		// A synthetic clone of a catalog row (Bedrock inference-profile ARN,
		// OpenRouter fallback) resolves to its own key — it IS the session
		// model and runs exactly like the row it was cloned from, so the
		// missing literal entry is not an availability problem. Only a
		// resolution to a different concrete model is a fuzzy sibling.
		if (resolvedKey !== sessionKey) {
			// Provider-qualified resolution deliberately does not fuzzy-match siblings.
			// Find a suggestion separately; it must never make the anchor available.
			const sibling = availableModels.find(
				model =>
					model.provider.toLowerCase() === sessionModel.provider.toLowerCase() &&
					model.id.toLowerCase().includes(sessionModel.id.toLowerCase()),
			);
			const suggestion = resolvedKey ?? (sibling ? modelKey(sibling) : undefined);
			const fuzzyNote = suggestion ? ` (similar available model: ${suggestion}; /team will not substitute it)` : "";
			return {
				ok: false,
				error: [
					`Session model ${sessionKey} is not available${fuzzyNote} and cannot act as the main agent for /team alignment and synthesis.`,
					"",
					"Switch to an available model (see `omp models`) and retry. /team will not silently skip the session model.",
				].join("\n"),
			};
		}
	}
	for (const model of [sessionModel, ...resolvedMembers]) {
		const issue = teamModelCapabilityIssue(model);
		if (issue) return { ok: false, error: issue.message };
	}
	const roster = resolvedMembers.length > 0 ? resolvedMembers : [sessionModel];
	const participants = expandTeamRoster(roster, (model, index): TeamParticipant => {
		const modelPattern = formatModelStringWithRouting(model);
		return {
			index,
			modelPattern,
			model,
			isSessionModel: modelKey(model) === sessionKey,
		};
	});
	const source = entries.length > 0 ? "configured" : "session-default";
	return { ok: true, participants, source };
}
