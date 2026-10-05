/**
 * `/team` participant resolution.
 *
 * Rules (docs-zh-CN/requirements/team.md §2.2):
 * - `team.members` holds full model IDs; unset or empty array = "not configured".
 * - Not configured + offline process: default to the company lane's current
 *   available chat models (runtime snapshot).
 * - Not configured + normal start: error with a configuration example; never
 *   silently degrade to a single-model flow.
 * - Explicit configuration wins in both environments; unavailable entries are
 *   reported by name, never silently dropped.
 * - Proposer set = dedup(resolved members ∪ session model), deduped by the
 *   resolved concrete model instance.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveModelFromString } from "../config/model-resolver";
import type { TeamParticipant } from "./types";

export interface TeamMembersInput {
	configuredMembers: readonly string[];
	/** Whether the company lane is active in this process (`--offline`). */
	offlineLaneActive: boolean;
	/** Full patterns of the company lane's current chat models, e.g. `company/GLM-5.2-public`. */
	companyModelPatterns: readonly string[];
	sessionModel: Model | undefined;
	availableModels: readonly Model[];
}

export type TeamMembersResult =
	| { ok: true; participants: TeamParticipant[]; source: "configured" | "company-default" }
	| { ok: false; error: string };

const CONFIG_EXAMPLE = [
	"team.members 未配置，且当前进程没有可用的 company 模型 lane，无法组建多模型团队。",
	"",
	"在 settings（config.yml）中配置参与模型（完整 ID；可用 ID 以 `omp models` 输出为准），格式例如：",
	"",
	"  team.members:",
	"    - <provider>/<model-id>",
	"    - <provider>/<model-id>",
	"",
	"注：`company/GLM-5.2-public` 等 company 模型仅存在于 `--offline` 进程；普通启动请从 `omp models` 列出的可用模型中选择。",
	"--offline 进程中未配置时默认使用 company lane 全部可用聊天模型；普通启动必须显式配置。",
	"/team 不会静默降级为单模型流程。",
].join("\n");

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

/** Resolve the proposer set. Pure: no I/O, all inputs injected for testability. */
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
	let entries = input.configuredMembers.map(entry => entry.trim());
	const emptyIndex = entries.findIndex(entry => entry.length === 0);
	if (emptyIndex !== -1) {
		return { ok: false, error: `team.members[${emptyIndex}] 为空；显式配置的参与模型不能为空。` };
	}
	let source: "configured" | "company-default" = "configured";
	if (entries.length === 0) {
		if (!input.offlineLaneActive || input.companyModelPatterns.length === 0) {
			return { ok: false, error: CONFIG_EXAMPLE };
		}
		const availablePatterns = new Set<string>();
		for (const model of input.availableModels) availablePatterns.add(modelKey(model));
		entries = input.companyModelPatterns.filter(pattern => availablePatterns.has(pattern));
		if (entries.length === 0) return { ok: false, error: CONFIG_EXAMPLE };
		source = "company-default";
	}

	const availableModels = [...input.availableModels];
	const seen = new Set<string>();
	const participants: TeamParticipant[] = [];
	const resolveEntry = (entry: string, isSessionModel: boolean): string | undefined => {
		const model = resolveModelFromString(entry, availableModels);
		if (!model) return entry;
		const key = modelKey(model);
		if (seen.has(key)) return undefined;
		seen.add(key);
		participants.push({
			index: participants.length,
			modelPattern: key,
			model,
			isSessionModel,
		});
		return undefined;
	};

	for (const entry of entries) {
		const missing = resolveEntry(entry, false);
		if (missing) {
			return {
				ok: false,
				error: [
					`team.members 中的模型不可用：${missing}`,
					"",
					"请修正或移除该项后重试。/team 不会静默剔除不可用模型后继续。",
					"可运行的模型可用 `omp models` 查看。",
				].join("\n"),
			};
		}
	}
	// The session model joins as an extra proposer when not already a member,
	// so the strongest model also investigates independently through a subagent.
	// It must join as itself: the orchestrator pins alignment/synthesis to its
	// exact pattern, and §2.2 requires a named error when the session model is
	// unavailable or disabled — a fuzzy sibling (renamed id, prefix variant,
	// near-match left by a disabledModels exclusion) is a different concrete
	// model and must not silently stand in for it.
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
			const fuzzyNote =
				resolvedKey && resolvedKey !== sessionKey
					? `（存在相近的可用模型 ${resolvedKey}，但 /team 不会用它替代会话模型）`
					: "";
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
	const sessionMissing = resolveEntry(sessionKey, true);
	if (sessionMissing) {
		// Unreachable while the exact-presence check above holds (resolveEntry
		// then resolves through the exact branch); kept as a named-error guard.
		return {
			ok: false,
			error: [
				`当前会话模型 ${sessionMissing} 不在可用模型列表中，无法作为 /team 的主代理（对齐与综合子调用依赖它）。`,
				"",
				"请先切换到可用模型（`omp models` 查看可运行模型）后重试；/team 不会静默跳过会话模型。",
			].join("\n"),
		};
	}
	// Whether the session model came from the configured list or joined as the
	// extra proposer, the matching participant is flagged: reviewer rotation
	// excludes it (§2.2) and the report labels it 会话模型.
	const sessionParticipant = participants.find(participant => participant.modelPattern === sessionKey);
	if (!sessionParticipant) {
		return {
			ok: false,
			error: `当前会话模型 ${sessionKey} 解析成功但未出现在参与者集合中，无法作为 /team 的主代理；这是 /team 的内部错误，请报告。`,
		};
	}
	sessionParticipant.isSessionModel = true;

	if (participants.length === 0) {
		return { ok: false, error: CONFIG_EXAMPLE };
	}
	return { ok: true, participants, source };
}
