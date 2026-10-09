import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createServer, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { ModelHubComponent, type ModelHubSource } from "../../tui/src/overlays/model-hub";
import { ModelPickerComponent } from "../../tui/src/overlays/model-picker";
import { initTheme } from "../../tui/src/theme";
import type { TUI } from "../../tui/src/tui";
import { ModelBrowser, buildBrowserItems, resolveLiveScopedModels } from "../../tui/src/overlays/model-browser";
import {
	discoverJchTools,
	discoverJchToolsModels,
	getJchToolsPipePath,
	type JchToolsDescriptor,
} from "../src/config/jchtools-discovery";
import { ModelRegistry } from "../src/config/model-registry";
import { pickDefaultAvailableModel, resolveCliModel } from "../src/config/model-resolver";
import { cfgDisabledProviders } from "../src/config/model-settings";
import { Settings } from "../src/config/settings";
import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { cfgExtendedContext } from "../src/session/context-settings";
import { AuthStorage } from "../src/session/auth-storage";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function descriptor(baseUrl: string | null, phase: JchToolsDescriptor["phase"] = "ready"): JchToolsDescriptor {
	return {
		protocol_version: 1,
		service_id: "jchtools-acp-http",
		instance_id: "12345678-1234-4234-8234-123456789abc",
		phase,
		base_url: baseUrl,
		execution_mode: "server_agent",
		capabilities: { text: true, streaming: true, client_tools: false, server_tools: true },
	};
}

function frame(value: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(value));
	const output = Buffer.alloc(4 + payload.length);
	output.writeUInt32LE(payload.length);
	payload.copy(output, 4);
	return output;
}

function envelope(value: unknown): Buffer {
	return frame({ protocol: 1, pid: 42, result: { Ok: value } });
}

async function pipeFixture(reply: (socket: Socket) => void | Promise<void>, existingPipePath?: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jch-discovery-"));
	const pipePath =
		existingPipePath ??
		(process.platform === "win32"
			? `\\\\.\\pipe\\omp-jch-discovery-${crypto.randomUUID()}`
			: path.join(root, "control.sock"));
	const requests: unknown[] = [];
	const sockets = new Set<Socket>();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		let received = Buffer.alloc(0);
		let handled = false;
		socket.on("data", chunk => {
			if (handled) return;
			received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
			if (received.length < 4 || received.length < 4 + received.readUInt32LE()) return;
			handled = true;
			requests.push(JSON.parse(received.subarray(4).toString()));
			Promise.resolve(reply(socket)).catch(() => socket.destroy());
		});
	});
	const ready = Promise.withResolvers<void>();
	server.once("error", ready.reject);
	server.listen(pipePath, () => ready.resolve());
	await ready.promise;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		if (stopping) return stopping;
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		stopping = closed.promise;
		return stopping;
	};
	cleanups.push(async () => {
		await stop();
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { root, pipePath, requests, stop };
}

function modelsFixture(ids: string[]) {
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			calls.push(`${request.method} ${new URL(request.url).pathname}`);
			return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
		},
	});
	cleanups.push(() => server.stop(true));
	return { baseUrl: `http://127.0.0.1:${server.port}`, calls };
}

async function registryFixture(
	pipePath: string,
	extra: { disabled?: boolean; guard?: boolean; gateway?: boolean; fetch?: FetchImpl } = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-jch-registry-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(() => auth.close());
	const modelsPath = path.join(root, "models.yml");
	await Bun.write(modelsPath, "providers: {}\n");
	const settings = Settings.isolated();
	cfgDisabledProviders.set(settings, extra.disabled ? ["jchtools"] : []);
	const registry = new ModelRegistry(auth, modelsPath, {
		settings,
		ignoreLocalModelConfig: extra.gateway,
		jchToolsDiscovery: {
			pipePath,
			timeoutMs: 250,
			env: extra.guard ? { OMP_JCHTOOLS_DISCOVERY: "0" } : {},
			fetch: extra.fetch ?? fetch,
		},
	});
	return { registry, modelsPath, settings };
}

describe("JchTools bounded same-session discovery", () => {
	test("assembles fragmented length and UTF-8 payload and sends only the read-only operation", async () => {
		const fixture = await pipeFixture(async socket => {
			const bytes = envelope(descriptor("http://127.0.0.1:31415"));
			for (let index = 0; index < bytes.length; index += 3) {
				const flushed = Promise.withResolvers<void>();
				socket.write(bytes.subarray(index, index + 3), () => flushed.resolve());
				await flushed.promise;
			}
		});
		const result = await discoverJchTools({ pipePath: fixture.pipePath, timeoutMs: 1000 });
		expect(result?.base_url).toBe("http://127.0.0.1:31415");
		expect(fixture.requests).toEqual(["Discover"]);
	});

	test("rejects an oversized frame before waiting for or allocating its advertised payload", async () => {
		const fixture = await pipeFixture(socket => {
			const length = Buffer.alloc(4);
			length.writeUInt32LE(1024 * 1024 + 1);
			socket.write(length);
		});
		expect(await discoverJchTools({ pipePath: fixture.pipePath, timeoutMs: 5000 })).toBeUndefined();
	}, 500);

	test("rejects malformed JSON, invalid UTF-8 and EOF in the header or payload", async () => {
		const invalidUtf8 = Buffer.from([2, 0, 0, 0, 0xc3, 0x28]);
		for (const bytes of [
			Buffer.from([1, 0, 0, 0, 0x7b]),
			invalidUtf8,
			Buffer.from([2, 0]),
			Buffer.from([10, 0, 0, 0, 0x7b]),
		]) {
			const fixture = await pipeFixture(socket => {
				socket.end(bytes);
			});
			expect(await discoverJchTools({ pipePath: fixture.pipePath, timeoutMs: 100 })).toBeUndefined();
		}
	});

	test("rejects control-protocol mismatch, invalid process identity and error envelopes", async () => {
		const valid = descriptor("http://127.0.0.1:31415");
		for (const response of [
			{ protocol: 2, pid: 42, result: { Ok: valid } },
			{ protocol: 1, pid: 0, result: { Ok: valid } },
			{ protocol: 1, pid: 42, result: { Err: "unavailable" } },
			{ protocol: 1, pid: 42, result: { Ok: valid, Err: "ambiguous" } },
		]) {
			const fixture = await pipeFixture(socket => {
				socket.end(frame(response));
			});
			expect(await discoverJchTools({ pipePath: fixture.pipePath, timeoutMs: 100 })).toBeUndefined();
		}
	});

	test("rejects incompatible descriptors and never follows an untrusted endpoint", async () => {
		const valid = descriptor("http://127.0.0.1:31415");
		const invalid = [
			{ ...valid, protocol_version: 2 },
			{ ...valid, service_id: "other" },
			{ ...valid, instance_id: "not-a-uuid" },
			{ ...valid, phase: "ready_now" },
			{ ...valid, execution_mode: "client_tools" },
			{ ...valid, saved_config: {} },
			{ ...valid, capabilities: { ...valid.capabilities, client_tools: true } },
			{ ...valid, base_url: "http://localhost:31415" },
			{ ...valid, base_url: "http://127.0.0.1:65536" },
			{ ...valid, base_url: "http://127.0.0.1:31415/v1" },
			{ ...valid, phase: "starting" },
		];
		let httpCalls = 0;
		for (const value of invalid) {
			const fixture = await pipeFixture(socket => {
				socket.end(envelope(value));
			});
			expect(
				await discoverJchToolsModels({
					pipePath: fixture.pipePath,
					timeoutMs: 100,
					fetch: async () => {
						httpCalls++;
						return Response.json({ data: [] });
					},
				}),
			).toEqual([]);
		}
		expect(httpCalls).toBe(0);
	});

	test("absent, stalled and cancelled pipes terminate without a model request", async () => {
		// This IPC integration deliberately exercises the real socket deadline;
		// fake timers would not exercise the platform's live connection teardown.
		const fixture = await pipeFixture(() => {});
		expect(await discoverJchTools({ pipePath: `${fixture.pipePath}-absent`, timeoutMs: 50 })).toBeUndefined();
		expect(await discoverJchTools({ pipePath: fixture.pipePath, timeoutMs: 30 })).toBeUndefined();
		const abort = new AbortController();
		const pending = discoverJchTools({ pipePath: fixture.pipePath, signal: abort.signal, timeoutMs: 1000 });
		abort.abort();
		expect(await pending).toBeUndefined();
	});

	test("test-root hashing is explicit and ordinary tests never ask for the host identity", () => {
		let identities = 0;
		const identity = () => {
			identities++;
			return { sid: "S-1-5-21-123-456-789-1001", sessionId: 7 };
		};
		expect(getJchToolsPipePath({ platform: "win32", testRuntime: true, env: {}, identity })).toBeUndefined();
		expect(identities).toBe(0);
		const root = "C:\\isolated\\测试";
		const suffix = new Bun.CryptoHasher("sha256").update(root).digest("hex");
		expect(
			getJchToolsPipePath({
				platform: "win32",
				testRuntime: true,
				env: { JCHTOOLS_TEST_STATE_DIR: root },
				identity,
			}),
		).toBe(`\\\\.\\pipe\\jchtools-acp-http-S-1-5-21-123-456-789-1001-7-${suffix}`);
		expect(
			getJchToolsPipePath({
				platform: "win32",
				testRuntime: false,
				env: { JCHTOOLS_TEST_STATE_DIR: root },
				identity,
			}),
		).toBe("\\\\.\\pipe\\jchtools-acp-http-S-1-5-21-123-456-789-1001-7");
		expect(getJchToolsPipePath({ platform: "linux", testRuntime: false, env: {}, identity })).toBeUndefined();
	});
});

describe("JchTools live registry catalogs", () => {
	test("live keyless remote models require explicit selection instead of becoming an automatic default", async () => {
		const http = modelsFixture(["real-agent/raw"]);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(http.baseUrl)));
		});
		const { registry } = await registryFixture(fixture.pipePath);
		await registry.refreshLocalProviders();
		const available = registry.getAvailableForProviders(new Set(["jchtools"]));
		const remote = available[0];
		if (!remote) throw new Error("Expected live remote model");
		expect(registry.hasConfiguredAuth(remote)).toBe(true);
		expect(pickDefaultAvailableModel(available)).toBeUndefined();
		expect(pickDefaultAvailableModel(available, provider => registry.hasConcreteAuth(provider))).toBeUndefined();
		expect(resolveCliModel({ cliModel: "jchtools/real-agent/raw", modelRegistry: registry }).model).toBe(remote);
	});

	test("discovered unknown capacities remain unknown in the actual model browser", async () => {
		await initTheme(false);
		const http = modelsFixture(["remote/raw"]);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(http.baseUrl)));
		});
		const models = await discoverJchToolsModels({ pipePath: fixture.pipePath, timeoutMs: 250, fetch });
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})), {
			currentContextTokens: 100_000,
			markOverContext: true,
		});
		const items = buildBrowserItems(models);
		const item = items[0];
		if (!item) throw new Error("Expected discovered browser row");
		browser.setItems(items);
		expect(browser.isOverContext(item)).toBe(false);
		const rendered = browser
			.render(180)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("ctx unknown");
		expect(rendered).toContain("out unknown");
		expect(browser.pickerItems(items).items[0]?.facts?.ctx).toBe("?");
	});

	test("real slash IDs survive selection without inheriting ordinary model routing or capabilities", async () => {
		const http = modelsFixture(["org/claude-opus-4.6", "gpt-5.4"]);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(http.baseUrl)));
		});
		const { registry, modelsPath } = await registryFixture(fixture.pipePath);
		const before = await Bun.file(modelsPath).text();
		const ordinary = registry.getProviderModels("openai").map(model => [model.id, model.api, model.baseUrl]);
		await registry.refreshProvider("jchtools", "online");
		const rows = registry.getAvailableForProviders(new Set(["jchtools"]));
		expect(rows.map(model => model.id)).toEqual(["org/claude-opus-4.6", "gpt-5.4"]);
		for (const row of rows) {
			expect(registry.find("jchtools", row.id)?.api).toBe("jchtools-agent");
			expect(row.supportsTools).toBe(false);
			expect(row.reasoning).toBe(false);
			expect(row.input).toEqual(["text"]);
			expect(row.requestModelId).toBeUndefined();
			expect(row.baseUrl).toBe(http.baseUrl);
		}
		expect(http.calls).toEqual(["GET /v1/models"]);
		expect(registry.getProviderModels("openai").map(model => [model.id, model.api, model.baseUrl])).toEqual(ordinary);
		expect(registry.getAvailableForProviders(new Set(["openai"])).some(model => model.provider === "jchtools")).toBe(
			false,
		);
		expect(await Bun.file(modelsPath).text()).toBe(before);
	});

	test("fresh local lookup follows actual port changes, removes unavailable rows, and restores late service models", async () => {
		const first = modelsFixture(["first/raw", "shared/raw"]);
		const second = modelsFixture(["second/raw", "shared/raw"]);
		let current = descriptor(null, "starting");
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(current));
		});
		const { registry } = await registryFixture(fixture.pipePath);
		await registry.refreshLocalProviders();
		expect(registry.getAvailableForProviders(new Set(["jchtools"]))).toEqual([]);
		expect(first.calls).toEqual([]);
		current = descriptor(first.baseUrl);
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "first/raw")?.baseUrl).toBe(first.baseUrl);
		const ordinary = registry.getProviderModels("openai")[0];
		const shared = registry.find("jchtools", "shared/raw");
		const firstOnly = registry.find("jchtools", "first/raw");
		if (!ordinary || !shared || !firstOnly) throw new Error("Expected scoped model fixtures");
		const scoped = [ordinary, shared, firstOnly];
		registry.getAll(); // Exercise replacement in an already-materialized full snapshot.
		current = { ...descriptor(second.baseUrl), instance_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
		await registry.refreshProvider("jchtools", "online-if-uncached");
		expect(registry.find("jchtools", "first/raw")).toBeUndefined();
		expect(registry.find("jchtools", "second/raw")?.baseUrl).toBe(second.baseUrl);
		const liveScope = resolveLiveScopedModels(registry, scoped);
		expect(liveScope.map(model => model.id)).toEqual([ordinary.id, "shared/raw"]);
		expect(liveScope[0]).toBe(ordinary);
		expect(liveScope[1].baseUrl).toBe(second.baseUrl);
		current = descriptor(null, "stopped");
		await registry.refreshLocalProviders();
		expect(registry.getAvailableForProviders(new Set(["jchtools"]))).toEqual([]);
		expect(registry.find("jchtools", "second/raw")).toBeUndefined();
		expect(resolveLiveScopedModels(registry, scoped)).toEqual([ordinary]);
		current = descriptor(first.baseUrl);
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "first/raw")?.baseUrl).toBe(first.baseUrl);
		await fixture.stop();
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "first/raw")).toBeUndefined();
		await pipeFixture(socket => {
			socket.end(envelope(descriptor(first.baseUrl)));
		}, fixture.pipePath);
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "first/raw")?.baseUrl).toBe(first.baseUrl);
		expect(resolveLiveScopedModels(registry, scoped).map(model => model.id)).toEqual([
			ordinary.id,
			"shared/raw",
			"first/raw",
		]);
		expect(first.calls.length).toBe(3);
		expect(second.calls.length).toBe(1);
	});

	test("compact scoped and unscoped opens and full scoped opens refresh local endpoints without unrelated provider HTTP", async () => {
		await initTheme(false);
		const first = modelsFixture(["live/raw"]);
		const second = modelsFixture(["live/raw"]);
		let current = descriptor(first.baseUrl);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(current));
		});
		const { registry, settings } = await registryFixture(fixture.pipePath);
		const source: ModelHubSource = {
			revision: 0,
			defaultThinkingLevel: "off",
			modelProviderOrder: [],
			knownRoleIds: [],
			mruOrder: [],
			modelPerf: new Map(),
			disabledProviders: [],
			fallbackChains: {},
			modelRoleStorage: "global",
			cycleOrder: [],
			getRoleInfo: role => ({ tag: role, name: role, section: "chat", accepts: () => true }),
			defaultRoleChain: () => [],
			resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
			getModelRole: () => undefined,
			getProjectModelRole: () => undefined,
			getGlobalModelRole: () => undefined,
			getModelRoleSource: () => "global",
		};
		for (const mode of ["compact-scoped", "compact-unscoped", "full-scoped"]) {
			current = descriptor(first.baseUrl);
			await registry.refreshLocalProviders();
			const stale = registry.find("jchtools", "live/raw");
			if (!stale) throw new Error("Expected live model before picker open");
			const previousRequests = fixture.requests.length;
			const previousModelRequests = first.calls.length + second.calls.length;
			cfgExtendedContext.set(settings, mode === "compact-scoped");
			await registry.reapplyModelPolicies();
			expect(fixture.requests.length).toBe(previousRequests);
			expect(first.calls.length + second.calls.length).toBe(previousModelRequests);
			current = descriptor(second.baseUrl);
			const reconciled = Promise.withResolvers<void>();
			const ui = {
				terminal: { rows: 40 },
				requestRender: () => {
					if (registry.find("jchtools", "live/raw")?.baseUrl === second.baseUrl) reconciled.resolve();
				},
			} as unknown as TUI;
			if (mode === "full-scoped") {
				const hub = new ModelHubComponent(ui, source, registry, [{ model: stale }], {
					onAssign: () => {},
					onUnassign: () => {},
					onCancel: () => {},
				});
				try {
					await reconciled.promise;
				} finally {
					hub.dispose();
				}
			} else {
				const picked: Model[] = [];
				const picker = new ModelPickerComponent(
					ui,
					source,
					registry,
					mode === "compact-scoped" ? [{ model: stale }] : [],
					{ onPick: model => picked.push(model), onCancel: () => {} },
					{ currentSelector: "jchtools/live/raw" },
				);
				picker.handleInput("\r");
				expect(picked).toEqual([]);
				await reconciled.promise;
				picker.handleInput("\r");
				expect(picked[0]?.baseUrl).toBe(second.baseUrl);
				expect(picked[0]?.id).toBe("live/raw");
			}
		}
		expect(first.calls).toEqual(["GET /v1/models", "GET /v1/models", "GET /v1/models"]);
		expect(second.calls).toEqual(["GET /v1/models", "GET /v1/models", "GET /v1/models"]);
	});

	test("disable and re-enable rebuild policies without probing or restoring an old remote endpoint", async () => {
		const first = modelsFixture(["old/raw"]);
		const second = modelsFixture(["new/raw"]);
		let current = descriptor(first.baseUrl);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(current));
		});
		const { registry, settings } = await registryFixture(fixture.pipePath);
		await registry.refreshLocalProviders();
		registry.getAll();
		expect(registry.find("jchtools", "old/raw")?.baseUrl).toBe(first.baseUrl);
		cfgDisabledProviders.set(settings, ["jchtools"]);
		await registry.reapplyModelPolicies();
		await registry.refreshLocalProviders();
		expect(registry.getAvailableForProviders(new Set(["jchtools"]))).toEqual([]);
		expect(registry.find("jchtools", "old/raw")).toBeUndefined();
		cfgDisabledProviders.set(settings, []);
		await registry.reapplyModelPolicies();
		expect(registry.getAvailableForProviders(new Set(["jchtools"]))).toEqual([]);
		expect(fixture.requests).toEqual(["Discover"]);
		expect(first.calls).toEqual(["GET /v1/models"]);
		expect(second.calls).toEqual([]);
		current = descriptor(second.baseUrl);
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "old/raw")).toBeUndefined();
		expect(registry.find("jchtools", "new/raw")?.baseUrl).toBe(second.baseUrl);
		expect(second.calls).toEqual(["GET /v1/models"]);
	});

	test.each(["enabled", "disabled", "offline"] as const)(
		"overlapping refreshes replace an invalidated flight only while finally %s",
		async gate => {
			const received = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const freshReceived = Promise.withResolvers<void>();
			const freshRelease = Promise.withResolvers<void>();
			const calls: string[] = [];
			const stalled = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					calls.push(new URL(request.url).pathname);
					received.resolve();
					await release.promise;
					return Response.json({ data: [{ id: "obsolete/raw" }] });
				},
			});
			cleanups.push(() => {
				release.resolve();
				freshRelease.resolve();
				stalled.stop(true);
			});
			const fresh = modelsFixture(["current/raw"]);
			const obsoleteUrl = `http://127.0.0.1:${stalled.port}`;
			let current = descriptor(obsoleteUrl);
			const fixture = await pipeFixture(socket => {
				socket.end(envelope(current));
			});
			const { registry, settings } = await registryFixture(fixture.pipePath, {
				fetch: async (input, init) => {
					// Hold the real old HTTP response despite cancellation so policy
					// reapplication cannot accidentally settle the flight under test.
					if (String(input).startsWith(obsoleteUrl)) return fetch(input, { ...init, signal: undefined });
					const response = await fetch(input, init);
					freshReceived.resolve();
					await freshRelease.promise;
					return response;
				},
			});
			registry.getAll();
			let oldSettled = false;
			const pending = registry.refreshLocalProviders().then(changed => {
				oldSettled = true;
				return changed;
			});
			await received.promise;
			cfgDisabledProviders.set(settings, ["jchtools"]);
			await registry.reapplyModelPolicies();
			cfgDisabledProviders.set(settings, []);
			await registry.reapplyModelPolicies();
			current = descriptor(fresh.baseUrl);
			const refreshes = [
				registry.refreshLocalProviders(),
				registry.refreshLocalProviders(),
				registry.refreshLocalProviders(),
			];
			expect(oldSettled).toBe(false);
			if (gate === "disabled") {
				cfgDisabledProviders.set(settings, ["jchtools"]);
				await registry.reapplyModelPolicies();
			} else if (gate === "offline") {
				await registry.refreshProvider("jchtools", "offline");
			}
			expect(fixture.requests).toEqual(["Discover"]);
			expect(calls).toEqual(["/v1/models"]);
			release.resolve();
			if (gate === "enabled") {
				await freshReceived.promise;
				// Joining an eligible flight must not schedule another discovery.
				refreshes.push(registry.refreshLocalProviders());
				expect(fixture.requests).toEqual(["Discover", "Discover"]);
				expect(fresh.calls).toEqual(["GET /v1/models"]);
			}
			freshRelease.resolve();
			await Promise.all([pending, ...refreshes]);
			expect(registry.find("jchtools", "obsolete/raw")).toBeUndefined();
			const rows = registry.getAvailableForProviders(new Set(["jchtools"]));
			if (gate === "enabled") {
				expect(rows.map(model => [model.id, model.baseUrl])).toEqual([["current/raw", fresh.baseUrl]]);
				expect(fixture.requests).toEqual(["Discover", "Discover"]);
				expect(fresh.calls).toEqual(["GET /v1/models"]);
			} else {
				expect(rows).toEqual([]);
				expect(fixture.requests).toEqual(["Discover"]);
				expect(fresh.calls).toEqual([]);
			}
		},
	);

	test("an authoritative empty HTTP catalog removes prior models without cache resurrection", async () => {
		let ids = ["previous"];
		const http = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ data: ids.map(id => ({ id })) }),
		});
		cleanups.push(() => http.stop(true));
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(`http://127.0.0.1:${http.port}`)));
		});
		const { registry } = await registryFixture(fixture.pipePath);
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "previous")).toBeDefined();
		ids = [];
		await registry.refreshLocalProviders();
		expect(registry.find("jchtools", "previous")).toBeUndefined();
		await registry.refresh("offline");
		expect(registry.find("jchtools", "previous")).toBeUndefined();
	});

	test("malformed or failed HTTP model catalogs revoke prior rows rather than falling back to cached endpoints", async () => {
		let response = Response.json({ data: [{ id: "served/raw" }] });
		const http = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				const current = response;
				return new Response(await current.clone().arrayBuffer(), {
					status: current.status,
					statusText: current.statusText,
					headers: current.headers,
				});
			},
		});
		cleanups.push(() => http.stop(true));
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(`http://127.0.0.1:${http.port}`)));
		});
		const { registry } = await registryFixture(fixture.pipePath);
		for (const failure of [
			new Response("backend down", { status: 503 }),
			new Response("{not-json"),
			Response.json({ data: [{ id: "served/raw" }, { id: 42 }] }),
		]) {
			response = Response.json({ data: [{ id: "served/raw" }] });
			await registry.refreshLocalProviders();
			expect(registry.find("jchtools", "served/raw")).toBeDefined();
			response = failure;
			await registry.refreshLocalProviders();
			expect(registry.find("jchtools", "served/raw")).toBeUndefined();
		}
	});

	test("disabled provider, recursion guard, gateway and offline refresh never probe the pipe or HTTP", async () => {
		const http = modelsFixture(["must-not-register"]);
		const fixture = await pipeFixture(socket => {
			socket.end(envelope(descriptor(http.baseUrl)));
		});
		for (const gate of [{ disabled: true }, { guard: true }, { gateway: true }]) {
			const { registry } = await registryFixture(fixture.pipePath, gate);
			await registry.refreshProvider("jchtools", "online");
			await registry.reapplyModelPolicies();
			await registry.refreshLocalProviders();
			expect(registry.getAvailableForProviders(new Set(["jchtools"]))).toEqual([]);
			expect(registry.find("jchtools", "must-not-register")).toBeUndefined();
		}
		const { registry } = await registryFixture(fixture.pipePath);
		await registry.refresh("offline");
		await registry.reapplyModelPolicies();
		await registry.refreshLocalProviders();
		expect(fixture.requests).toEqual([]);
		expect(http.calls).toEqual([]);
	});
});
