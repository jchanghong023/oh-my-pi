/**
 * `/team` participant-resolution tests (docs-zh-CN/team.md §2.2): unconfigured
 * behavior under offline/normal start, explicit configuration precedence,
 * unavailable-member errors, and the dedup(∪ session model) rule.
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveTeamParticipants } from "@oh-my-pi/pi-coding-agent/team";

function fakeModel(provider: string, id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	});
}

const SESSION = fakeModel("anthropic", "claude-sonnet-4-5");
const AVAILABLE = [
	SESSION,
	fakeModel("company", "GLM-5.2-public"),
	fakeModel("company", "Qwen3.6-27B-public"),
	fakeModel("openai", "gpt-5"),
];
const COMPANY_PATTERNS = ["company/GLM-5.2-public", "company/Qwen3.6-27B-public"];

describe("team member resolution", () => {
	it("errors with a configuration example when unconfigured without a company lane", () => {
		const result = resolveTeamParticipants({
			configuredMembers: [],
			offlineLaneActive: false,
			companyModelPatterns: [],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("team.members");
			// The copy-paste example must not suggest IDs that only exist in a
			// --offline process; concrete company ids are named only as an
			// offline-lane note, with `omp models` as the source of real ids.
			expect(result.error).toContain("<provider>/<model-id>");
			expect(result.error).toContain("omp models");
			expect(result.error).toContain("company/GLM-5.2-public");
			expect(result.error).toContain("--offline");
			expect(result.error).toContain("不会静默降级为单模型");
		}
	});

	it("errors when offline but the company lane has no available models", () => {
		const result = resolveTeamParticipants({
			configuredMembers: [],
			offlineLaneActive: true,
			companyModelPatterns: [],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
	});

	it("defaults to the company lane snapshot when unconfigured offline", () => {
		const result = resolveTeamParticipants({
			configuredMembers: [],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("company-default");
			expect(result.participants.map(p => p.modelPattern)).toEqual([
				"company/GLM-5.2-public",
				"company/Qwen3.6-27B-public",
				"anthropic/claude-sonnet-4-5",
			]);
			expect(result.participants.at(-1)!.isSessionModel).toBe(true);
		}
	});

	it("treats an empty array as unconfigured", () => {
		const offline = resolveTeamParticipants({
			configuredMembers: [],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(offline.ok).toBe(true);
	});

	it("explicit configuration overrides the environment default list", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["openai/gpt-5"],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("configured");
			expect(result.participants.map(p => p.modelPattern)).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4-5"]);
		}
	});

	it("errors naming the unavailable entry instead of silently dropping it", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["openai/gpt-5", "company/NoSuchModel"],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("company/NoSuchModel");
			expect(result.error).toContain("不会静默剔除");
		}
	});

	it("dedups the session model against configured members by resolved instance", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["anthropic/claude-sonnet-4-5", "company/GLM-5.2-public", "company/GLM-5.2-public"],
			offlineLaneActive: false,
			companyModelPatterns: [],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.participants.map(p => p.modelPattern)).toEqual([
				"anthropic/claude-sonnet-4-5",
				"company/GLM-5.2-public",
			]);
			// The session-model participant is flagged however it joined:
			// reviewer rotation excludes it (§2.2).
			expect(result.participants[0]!.isSessionModel).toBe(true);
			expect(result.participants[1]!.isSessionModel).toBe(false);
		}
	});

	it("requires a session model to anchor the main agent", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["company/GLM-5.2-public"],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: undefined,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("主代理");
	});

	it("errors naming the session model when it is not in the available list", () => {
		const ghost = fakeModel("ghost", "m1");
		const result = resolveTeamParticipants({
			configuredMembers: ["company/GLM-5.2-public"],
			offlineLaneActive: true,
			companyModelPatterns: COMPANY_PATTERNS,
			sessionModel: ghost,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("ghost/m1");
			expect(result.error).toContain("主代理");
			expect(result.error).toContain("不会静默跳过");
		}
	});
});
