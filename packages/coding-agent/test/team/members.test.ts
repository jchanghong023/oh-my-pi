/**
 * `/team` participant-resolution tests: ordered independent slots, session
 * fallback, strict configured selectors, and exact session-anchor availability.
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
const PATTERNS = AVAILABLE.map(model => `${model.provider}/${model.id}`);

describe("team member resolution", () => {
	it.each([
		{ members: [0], slots: [0, 0, 0] },
		{ members: [0, 1], slots: [0, 1, 0] },
		{ members: [0, 1, 2], slots: [0, 1, 2] },
		{ members: [0, 1, 2, 3], slots: [0, 1, 2, 3] },
	])("cycles the ordered roster into at least three independent slots: %j", ({ members, slots }) => {
		const result = resolveTeamParticipants({
			configuredMembers: members.map(index => PATTERNS[index]!),
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("configured");
			expect(result.participants.map(participant => participant.modelPattern)).toEqual(
				slots.map(index => PATTERNS[index]!),
			);
			expect(result.participants.map(participant => participant.index)).toEqual(slots.map((_, index) => index));
			expect(result.participants.map(participant => participant.isSessionModel)).toEqual(
				slots.map(index => index === 0),
			);
			expect(new Set(result.participants).size).toBe(slots.length);
		}
	});

	it("defaults an empty roster to three independent slots using the current session model", () => {
		const result = resolveTeamParticipants({
			configuredMembers: [],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("session-default");
			expect(result.participants.map(participant => participant.modelPattern)).toEqual([
				PATTERNS[0]!,
				PATTERNS[0]!,
				PATTERNS[0]!,
			]);
			expect(result.participants.map(participant => participant.index)).toEqual([0, 1, 2]);
			expect(
				result.participants.every(participant => participant.model === SESSION && participant.isSessionModel),
			).toBe(true);
			expect(new Set(result.participants).size).toBe(3);
		}
	});

	it("preserves explicit duplicate entries and their order without appending the session model", () => {
		const configuredMembers = [PATTERNS[1]!, PATTERNS[3]!, PATTERNS[3]!, PATTERNS[1]!];
		const result = resolveTeamParticipants({
			configuredMembers,
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.participants.map(participant => participant.modelPattern)).toEqual(configuredMembers);
			expect(result.participants.map(participant => participant.index)).toEqual([0, 1, 2, 3]);
			expect(result.participants.every(participant => !participant.isSessionModel)).toBe(true);
		}
	});

	it("does not add the session model to a short explicit roster", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["openai/gpt-5"],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.participants.map(participant => participant.modelPattern)).toEqual([
				"openai/gpt-5",
				"openai/gpt-5",
				"openai/gpt-5",
			]);
			expect(result.participants.every(participant => !participant.isSessionModel)).toBe(true);
		}
	});

	it("canonicalizes case aliases without deduplicating their slots", () => {
		const session = AVAILABLE[1]!;
		const result = resolveTeamParticipants({
			configuredMembers: [" company/glm-5.2-public ", "COMPANY/GLM-5.2-public", "openai/gpt-5"],
			sessionModel: session,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.participants.map(participant => participant.modelPattern)).toEqual([
				"company/GLM-5.2-public",
				"company/GLM-5.2-public",
				"openai/gpt-5",
			]);
			expect(result.participants.map(participant => participant.isSessionModel)).toEqual([true, true, false]);
			expect(result.participants.map(participant => participant.model)).toEqual([session, session, AVAILABLE[3]!]);
		}
	});

	it("canonicalizes full revision-spelling aliases before cycling the roster", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5"],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.participants.map(participant => participant.modelPattern)).toEqual([
				PATTERNS[0]!,
				PATTERNS[0]!,
				PATTERNS[0]!,
			]);
			expect(result.participants.every(participant => participant.isSessionModel)).toBe(true);
		}
	});

	it("validates every configured entry before expansion rather than omitting an unavailable member", () => {
		const result = resolveTeamParticipants({
			configuredMembers: [PATTERNS[1]!, PATTERNS[1]!, "company/NoSuchModel"],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("company/NoSuchModel");
			expect(result.error).toContain("不会静默剔除");
		}
	});

	it.each(["company/GLM-5.2", "GLM-5.2-public"])(
		"rejects configured entries that are not strict full model references (%s)",
		entry => {
			const result = resolveTeamParticipants({
				configuredMembers: [entry],
				sessionModel: SESSION,
				availableModels: AVAILABLE,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain(entry);
		},
	);

	it.each([{ configuredMembers: ["   "] }, { configuredMembers: ["openai/gpt-5", ""] }])(
		"rejects explicitly empty configured entries: %j",
		({ configuredMembers }) => {
			const result = resolveTeamParticipants({
				configuredMembers,
				sessionModel: SESSION,
				availableModels: AVAILABLE,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain(`team.members[${configuredMembers.length - 1}]`);
		},
	);

	it.each([
		{ entry: 3, described: "number 3" },
		{ entry: true, described: "boolean true" },
		{ entry: null, described: "null" },
	])("rejects non-string configured entries with the index and actual type: %j", ({ entry, described }) => {
		const result = resolveTeamParticipants({
			configuredMembers: ["openai/gpt-5", entry] as unknown as readonly string[],
			sessionModel: SESSION,
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("team.members[1]");
			expect(result.error).toContain(described);
		}
	});

	it.each([{ configuredMembers: [] }, { configuredMembers: ["company/GLM-5.2-public"] }])(
		"requires a session anchor for roster %j",
		({ configuredMembers }) => {
			const result = resolveTeamParticipants({
				configuredMembers,
				sessionModel: undefined,
				availableModels: AVAILABLE,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("主代理");
		},
	);

	it.each([{ configuredMembers: [] }, { configuredMembers: ["company/GLM-5.2-public"] }])(
		"errors naming an unavailable session model even when absent from roster %j",
		({ configuredMembers }) => {
			const result = resolveTeamParticipants({
				configuredMembers,
				sessionModel: fakeModel("ghost", "m1"),
				availableModels: AVAILABLE,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("ghost/m1");
				expect(result.error).toContain("主代理");
				expect(result.error).toContain("不会静默跳过");
			}
		},
	);

	it("rejects a fuzzy sibling instead of replacing an unavailable session anchor", () => {
		const result = resolveTeamParticipants({
			configuredMembers: ["openai/gpt-5"],
			sessionModel: fakeModel("company", "GLM-5.2"),
			availableModels: AVAILABLE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("company/GLM-5.2");
			expect(result.error).toContain("company/GLM-5.2-public");
			expect(result.error).toContain("主代理");
			expect(result.error).toContain("不会静默跳过");
		}
	});

	it.each([{ configuredMembers: [] }, { configuredMembers: ["openai/gpt-5"] }])(
		"accepts a synthetic Bedrock session anchor without adding it to explicit roster %j",
		({ configuredMembers }) => {
			const session = fakeModel("amazon-bedrock", "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc");
			const sessionPattern = `${session.provider}/${session.id}`;
			const result = resolveTeamParticipants({
				configuredMembers,
				sessionModel: session,
				availableModels: [fakeModel("amazon-bedrock", "anthropic.claude-opus-4-8"), ...AVAILABLE],
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const expectedPattern = configuredMembers.length ? "openai/gpt-5" : sessionPattern;
				expect(result.participants.map(participant => participant.modelPattern)).toEqual([
					expectedPattern,
					expectedPattern,
					expectedPattern,
				]);
				expect(result.participants.every(participant => participant.isSessionModel)).toBe(
					configuredMembers.length === 0,
				);
			}
		},
	);
});
