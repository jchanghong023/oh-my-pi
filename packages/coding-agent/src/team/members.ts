/**
 * `/team` participant resolution.
 *
 * Rules (docs-zh-CN/team.md §2.2):
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

/** Resolve the proposer set. Pure: no I/O, all inputs injected for testability. */
export function resolveTeamParticipants(input: TeamMembersInput): TeamMembersResult {
	const sessionModel = input.sessionModel;
	if (!sessionModel) {
		return { ok: false, error: "/team 需要一个当前会话模型（主代理），但当前会话未选择模型。" };
	}

	let entries = input.configuredMembers.map(entry => entry.trim()).filter(entry => entry.length > 0);
	let source: "configured" | "company-default" = "configured";
	if (entries.length === 0) {
		if (!input.offlineLaneActive || input.companyModelPatterns.length === 0) {
			return { ok: false, error: CONFIG_EXAMPLE };
		}
		entries = [...input.companyModelPatterns];
		source = "company-default";
	}

	const seen = new Set<string>();
	const participants: TeamParticipant[] = [];
	const resolveEntry = (entry: string, isSessionModel: boolean): string | undefined => {
		const model = resolveModelFromString(entry, [...input.availableModels]);
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
	// An unresolvable session model is a hard error, not a silent skip: the
	// orchestrator's alignment/synthesis calls are pinned to it.
	const sessionMissing = resolveEntry(modelKey(sessionModel), true);
	if (sessionMissing) {
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
	participants.find(participant => participant.modelPattern === modelKey(sessionModel))!.isSessionModel = true;

	if (participants.length === 0) {
		return { ok: false, error: CONFIG_EXAMPLE };
	}
	return { ok: true, participants, source };
}
