/**
 * Fork contract (docs-zh-CN/requirements/fork.md, 「Codex 压缩默认模型」):
 * compaction candidates that would land on the `openai-codex` provider are
 * substituted with `openai-codex/gpt-6-luna` (cheap, fast, pinned `low`
 * effort); an explicitly configured `compactionModel` target is never
 * substituted, and non-codex chains pass through untouched.
 */
import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SessionMaintenance,
	substituteForkCodexCompactionModel,
	type SessionMaintenanceHost,
} from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

type BundledProvider = Parameters<typeof getBundledModel>[0];

function requireModel(provider: BundledProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected built-in ${provider}/${id} to exist`);
	return model;
}

function makeMaintenance(model: Model | undefined): SessionMaintenance {
	const host = { settings: Settings.isolated(), model: () => model } as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

describe("substituteForkCodexCompactionModel (pure)", () => {
	test("codex non-luna candidate → luna", () => {
		const sol = requireModel("openai-codex", "gpt-6.1-sol");
		const luna = requireModel("openai-codex", "gpt-6-luna");
		expect(substituteForkCodexCompactionModel(sol, [sol, luna])).toBe(luna);
	});

	test("codex candidate without luna available → passthrough", () => {
		const sol = requireModel("openai-codex", "gpt-6.1-sol");
		expect(substituteForkCodexCompactionModel(sol, [sol])).toBe(sol);
	});

	test("non-codex candidate → passthrough", () => {
		const sonnet = requireModel("anthropic", "claude-sonnet-4-5");
		const luna = requireModel("openai-codex", "gpt-6-luna");
		expect(substituteForkCodexCompactionModel(sonnet, [sonnet, luna])).toBe(sonnet);
	});

	test("luna itself → passthrough; undefined → undefined", () => {
		const luna = requireModel("openai-codex", "gpt-6-luna");
		expect(substituteForkCodexCompactionModel(luna, [luna])).toBe(luna);
		expect(substituteForkCodexCompactionModel(undefined, [luna])).toBeUndefined();
	});
});

describe("resolveCompactionModelCandidates (fork contract)", () => {
	const sol = requireModel("openai-codex", "gpt-6.1-sol");
	const luna = requireModel("openai-codex", "gpt-6-luna");
	const sonnet = requireModel("anthropic", "claude-sonnet-4-5");

	test("codex main model → first candidate is luna; no other codex model enters the chain", () => {
		const candidates = makeMaintenance(sol).resolveCompactionModelCandidates(sol, [sol, luna, sonnet]);
		expect(candidates[0]).toBe(luna);
		expect(candidates.some(c => c.provider === "openai-codex" && c.id !== "gpt-6-luna")).toBe(false);
	});

	test("explicitly configured compactionModel target is never substituted", () => {
		const configured: Model = { ...sol, compactionModel: "openai-codex/gpt-6.1-sol" };
		const candidates = makeMaintenance(configured).resolveCompactionModelCandidates(configured, [sol, luna]);
		expect(candidates[0]).toBe(sol);
		expect(candidates).toContain(luna);
	});

	test("codex model reached via a model role is substituted too", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "openai-codex/gpt-6.1-sol" } });
		const host = { settings, model: () => sonnet } as unknown as SessionMaintenanceHost;
		const candidates = new SessionMaintenance(host).resolveCompactionModelCandidates(sonnet, [sonnet, sol, luna]);
		expect(candidates[0]).toBe(sonnet);
		expect(candidates).toContain(luna);
		expect(candidates.some(c => c.provider === "openai-codex" && c.id !== "gpt-6-luna")).toBe(false);
	});

	test("non-codex chain untouched", () => {
		const candidates = makeMaintenance(sonnet).resolveCompactionModelCandidates(sonnet, [sonnet]);
		expect(candidates).toEqual([sonnet]);
	});
});
