import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import {
	currentExecutionModel,
	type ExecutionModelContext,
	releaseCurrentExecutionModel,
} from "../../src/session/execution-model";
import { ModelControls, type ModelControlsHost } from "../../src/session/model-controls";

function harness(selected = true) {
	const original = getBundledModel("anthropic", "claude-sonnet-4-5");
	const temporary = { ...original, provider: "execution-provider", id: "execution-model" } as Model;
	let current: Model | undefined = selected ? original : undefined;
	let idle = true;
	let authorized = true;
	const writes: string[] = [];
	const host = {
		agent: { setThinkingLevel() {}, setDisableReasoning() {} },
		settings: Settings.isolated(),
		modelRegistry: {
			hasConfiguredAuth: () => false,
			refreshSelectedModelMetadata: async (model: Model) => model,
			clearSuppressedSelector() {},
		},
		sessionManager: {
			appendModelChange: () => writes.push("model"),
			appendThinkingLevelChange() {},
		},
		providerSessionState: new Map(),
		model: () => current,
		sessionId: () => "session",
		promptGeneration: () => 0,
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async (model: Model) => {
			current = model;
		},
		clearActiveRetryFallback() {},
		clearInheritedProviderPromptCacheKey() {},
		magicKeywordEnabled: () => false,
		emit() {},
		emitSessionEvent: async () => {},
		emitNotice() {},
		executionModelIdle: () => idle,
		validateExecutionModelAuth: async () => authorized,
		clearExecutionModel: async () => {
			current = undefined;
		},
	} as unknown as ModelControlsHost;
	const controls = new ModelControls(host, {});
	return {
		controls,
		original,
		temporary,
		writes,
		host,
		current: () => current,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setAuthorized: (value: boolean) => {
			authorized = value;
		},
	};
}

describe("single-execution model ownership", () => {
	it("uses request-authorized selection without recording credentials or a model change", async () => {
		const h = harness();
		const other = harness();
		await h.controls.withExecutionModel({ model: h.temporary }, async () => {
			expect(h.current()).toBe(h.temporary);
			expect(other.current()).toBe(other.original);
		});
		expect(h.current()).toBe(h.original);
		expect(h.writes).toEqual([]);
	});

	it("restores an initially unselected session and accepts resolved headers-only auth", async () => {
		const h = harness(false);
		h.setAuthorized(false);
		let authCalls = 0;
		await h.controls.withExecutionModel(
			{
				model: h.temporary,
				resolveRequestAuth: async () => {
					authCalls++;
					return { headers: { Authorization: "request-only" } };
				},
			},
			async () => {
				expect(h.current()).toBe(h.temporary);
			},
		);
		expect(authCalls).toBe(1);
		expect(h.current()).toBeUndefined();
		expect(h.writes).toEqual([]);
	});

	it("preserves an explicit same-model selection made during execution", async () => {
		const h = harness();
		await h.controls.withExecutionModel({ model: h.temporary }, async () => {
			await h.controls.setModelTemporary(h.temporary);
		});
		expect(h.current()).toBe(h.temporary);
	});

	it("restores on error and cancellation without replaying the callback", async () => {
		const h = harness();
		let calls = 0;
		await expect(
			h.controls.withExecutionModel({ model: h.temporary }, async () => {
				calls++;
				throw new Error("provider failed");
			}),
		).rejects.toThrow("provider failed");
		expect(calls).toBe(1);
		expect(h.current()).toBe(h.original);
		const controller = new AbortController();
		controller.abort();
		await expect(
			h.controls.withExecutionModel({ model: h.temporary, signal: controller.signal }, async () => {
				calls++;
			}),
		).rejects.toThrow();
		expect(calls).toBe(1);
		expect(h.current()).toBe(h.original);
	});

	it("rejects missing real authorization and busy sessions before admission", async () => {
		const h = harness();
		let calls = 0;
		h.setAuthorized(false);
		await expect(
			h.controls.withExecutionModel({ model: h.temporary }, async () => {
				calls++;
			}),
		).rejects.toThrow("No API key");
		h.setAuthorized(true);
		h.setIdle(false);
		await expect(
			h.controls.withExecutionModel({ model: h.temporary }, async () => {
				calls++;
			}),
		).rejects.toThrow("idle");
		expect(calls).toBe(0);
		expect(h.current()).toBe(h.original);
	});

	it("binds execution policies only to the active asynchronous scope", async () => {
		const h = harness();
		await h.controls.withExecutionModel(
			{
				model: h.temporary,
				policies: {
					subagents: { foregroundModel: "submission", background: "deny" },
					memoryExtraction: "skip",
				},
			},
			async () => {
				await Promise.resolve();
				expect(currentExecutionModel()?.model).toBe(h.temporary);
				expect(currentExecutionModel()?.policies?.subagents?.background).toBe("deny");
				expect(currentExecutionModel()?.policies?.memoryExtraction).toBe("skip");
			},
		);
		expect(currentExecutionModel()).toBeUndefined();
		expect(h.current()).toBe(h.original);
	});

	it("does not overwrite an explicit selection while authorization is resolving", async () => {
		const h = harness();
		const auth = Promise.withResolvers<boolean>();
		h.host.validateExecutionModelAuth = () => auth.promise;
		const pending = h.controls.withExecutionModel({ model: h.temporary }, async () => {});
		const explicit = { ...h.original, id: "explicit" } as Model;
		h.host.modelRegistry.hasConfiguredAuth = () => true;
		await h.controls.setModelTemporary(explicit);
		auth.resolve(true);
		await expect(pending).rejects.toThrow("selection changed");
		expect(h.current()).toBe(explicit);
	});

	it("tracks the installed identity when the agent adapts catalog model options", async () => {
		const h = harness();
		const setModel = h.host.setModelWithProviderSessionReset;
		h.host.setModelWithProviderSessionReset = model => setModel({ ...model });
		await h.controls.withExecutionModel({ model: h.temporary }, async () => {
			expect(h.current()).not.toBe(h.temporary);
			expect(h.current()?.id).toBe(h.temporary.id);
		});
		expect(h.current()?.id).toBe(h.original.id);
		expect(h.writes).toEqual([]);
	});

	it("revokes captured request authorization callbacks after completion", async () => {
		const h = harness();
		let resolver: ExecutionModelContext | undefined;
		await h.controls.withExecutionModel(
			{
				model: h.temporary,
				resolveRequestAuth: async () => ({ apiKey: "single-execution" }),
			},
			async () => {
				resolver = currentExecutionModel();
				expect(await resolver?.resolveRequestAuth?.(h.temporary)).toEqual({ apiKey: "single-execution" });
			},
		);
		await expect(resolver!.resolveRequestAuth!(h.temporary)).rejects.toThrow("scope has ended");
	});

	it("releases before the next input without double restoration at prompt completion", async () => {
		const h = harness();
		const setModel = h.host.setModelWithProviderSessionReset;
		let switches = 0;
		h.host.setModelWithProviderSessionReset = async model => {
			switches++;
			await setModel(model);
		};
		const explicit = { ...h.original, id: "later-user-selection" } as Model;
		await h.controls.withExecutionModel(
			{
				model: h.temporary,
				policies: { memoryExtraction: "skip" },
				resolveRequestAuth: async () => ({ apiKey: "single-input" }),
			},
			async () => {
				const material = currentExecutionModel()!;
				await Promise.all([releaseCurrentExecutionModel(), releaseCurrentExecutionModel()]);
				expect(h.current()).toBe(h.original);
				expect(currentExecutionModel()).toBeUndefined();
				await expect(material.resolveRequestAuth!(h.temporary)).rejects.toThrow("scope has ended");
				expect(switches).toBe(2);
				await h.controls.setModelTemporary(explicit);
			},
		);
		expect(switches).toBe(3);
		expect(h.current()).toBe(explicit);
	});
});
