/**
 * `/team` participant resolution.
 *
 * Rules (docs-zh-CN/requirements/team.md §2.2):
 * - Ordered configured full model IDs resolve strictly, preserving duplicates.
 * - Unset or empty configuration uses the current session model.
 * - N = max(3, M) independent slots cycle through the M resolved members.
 * - The session model anchors alignment/synthesis, but is never appended to an
 *   explicit roster and must remain available even when absent from it.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import {
	formatModelStringWithRouting,
	resolveModelFromString,
	resolveProviderModelReference,
} from "../config/model-resolver";
import { isJchToolsAgentModel } from "../config/jchtools-provider";
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
	if (isJchToolsAgentModel(model)) {
		return {
			code: "unsupported_agent",
			message: `/team 不支持远端 Agent 模型 ${modelKey(model)}：后端执行权限无法由前端只读工具集限制，且不支持必需的结构化 yield。`,
		};
	}
	if (model.supportsTools === false || (model.kind !== undefined && model.kind !== "chat")) {
		return {
			code: "missing_capability",
			message: `模型 ${modelKey(model)} 不支持 Team 必需的聊天工具与结构化 yield。`,
		};
	}
	return undefined;
}
/** Resolve ordered independent proposer slots. Pure: no I/O, all inputs injected. */
export function resolveTeamParticipants(input: TeamMembersInput): TeamMembersResult {
	const sessionModel = input.sessionModel;
	if (!sessionModel) {
		return { ok: false, error: "/team 需要一个当前会话模型（主代理），但当前会话未选择模型。" };
	}

	// Settings only validate array-ness, not element types: a numeric/boolean/
	// null entry in config.yml must fail with the offending index instead of a
	// bare `entry.trim is not a function` TypeError (§2.2/§2.8: 报错指出具体项).
	for (const [index, entry] of (input.configuredMembers as readonly unknown[]).entries()) {
		if (typeof entry !== "string") {
			return {
				ok: false,
				error: `team.members[${index}] 必须是字符串（模型选择器），实际是 ${describeConfiguredEntry(entry)}；请在 config.yml 修正。`,
			};
		}
	}
	const entries = input.configuredMembers.map(entry => entry.trim());
	const emptyIndex = entries.findIndex(entry => entry.length === 0);
	if (emptyIndex !== -1) {
		return { ok: false, error: `team.members[${emptyIndex}] 为空；显式配置的参与模型不能为空。` };
	}
	const availableModels = [...input.availableModels];
	const resolvedMembers: Model[] = [];
	for (const entry of entries) {
		const separator = entry.indexOf("/");
		const model =
			separator > 0
				? resolveProviderModelReference(entry.slice(0, separator), entry.slice(separator + 1), availableModels)
				: undefined;
		if (!model) {
			return {
				ok: false,
				error: [
					`team.members 中的模型不可用：${entry}`,
					"",
					"请修正或移除该项后重试。/team 不会静默剔除不可用模型后继续。",
					"可运行的模型可用 `omp models` 查看。",
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
			const fuzzyNote = resolvedKey ? `（存在相近的可用模型 ${resolvedKey}，但 /team 不会用它替代会话模型）` : "";
			return {
				ok: false,
				error: [
					`当前会话模型 ${sessionKey} 不在可用模型列表中${fuzzyNote}，无法作为 /team 的主代理（对齐与综合子调用依赖它）。`,
					"",
					"请先切换到可用模型（`omp models` 查看可运行模型）后重试；/team 不会静默跳过会话模型。",
				].join("\n"),
			};
		}
	}
	for (const model of [sessionModel, ...resolvedMembers]) {
		const issue = teamModelCapabilityIssue(model);
		if (issue) return { ok: false, error: issue.message };
	}
	const roster = resolvedMembers.length > 0 ? resolvedMembers : [sessionModel];
	const participants = Array.from({ length: Math.max(3, roster.length) }, (_, index): TeamParticipant => {
		const model = roster[index % roster.length]!;
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
