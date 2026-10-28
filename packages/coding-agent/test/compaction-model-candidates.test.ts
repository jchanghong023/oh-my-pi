import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, shouldUseProviderNativeCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
afterAll(() => authStorage.close());

type BundledProvider = Parameters<typeof getBundledModel>[0];

function requireModel(provider: BundledProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected built-in ${provider}/${id} to exist`);
	return model;
}

function makeMaintenance(model: Model | undefined, settings = Settings.isolated()): SessionMaintenance {
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings, ignoreLocalModelConfig: true });
	const host = { settings, modelRegistry, model: () => model } as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

describe("resolveCompactionModelCandidates", () => {
	const sol = requireModel("openai-codex", "gpt-6.1-sol");
	const luna = requireModel("openai-codex", "gpt-6-luna");
	const sonnet = requireModel("anthropic", "claude-sonnet-4-5");

	test("preferred Codex model remains selected when Luna is available", () => {
		const candidates = makeMaintenance(sol).resolveCompactionModelCandidates(sol, [sol, luna]);
		expect(candidates[0]).toBe(sol);
	});

	test("a filtered largest model does not hide a smaller provider-native fallback", () => {
		const liveSol: Model = {
			...sol,
			contextWindow: 200_000,
			remoteCompaction: { ...sol.remoteCompaction, enabled: false, v2StreamingEnabled: false },
		};
		const largestSonnet: Model = { ...sonnet, contextWindow: 400_000 };
		const fallbackCodex: Model = {
			...requireModel("openai-codex", "gpt-5.6-terra"),
			contextWindow: 300_000,
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		};
		const candidates = makeMaintenance(liveSol).resolveCompactionModelCandidates(
			liveSol,
			[liveSol, largestSonnet, fallbackCodex],
			candidate =>
				candidate.provider === liveSol.provider &&
				shouldUseProviderNativeCompaction(candidate, DEFAULT_COMPACTION_SETTINGS),
		);
		expect(candidates).toEqual([fallbackCodex]);
	});

	test("explicitly configured compactionModel target takes precedence", () => {
		const configured: Model = { ...sol, compactionModel: "openai-codex/gpt-6-luna" };
		const candidates = makeMaintenance(configured).resolveCompactionModelCandidates(configured, [sol, luna]);
		expect(candidates[0]).toBe(luna);
		expect(candidates).toContain(configured);
	});

	test("Codex model reached via a model role is retained", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "openai-codex/gpt-6.1-sol" } });
		const candidates = makeMaintenance(sonnet, settings).resolveCompactionModelCandidates(sonnet, [
			sonnet,
			sol,
			luna,
		]);
		expect(candidates[0]).toBe(sonnet);
		expect(candidates).toContain(sol);
	});

	test("non-codex chain untouched", () => {
		const candidates = makeMaintenance(sonnet).resolveCompactionModelCandidates(sonnet, [sonnet]);
		expect(candidates).toEqual([sonnet]);
	});
});
