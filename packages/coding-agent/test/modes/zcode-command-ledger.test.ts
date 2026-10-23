import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadedCustomCommand } from "../../src/extensibility/custom-commands";
import { ZCodeCommandLedger } from "../../src/modes/zcode/command-ledger";
import type { CommandAck, CommandEnvelope } from "../../src/modes/zcode/schema";
import { ZCodeSessionManager } from "../../src/modes/zcode/sessions";
import { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { AuthStorage } from "../../src/session/auth-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import type { SessionEntry } from "../../src/session/session-entries";
import { closeSessionIndex } from "../../src/session/session-index";
import { convertToLlm } from "../../src/session/messages";
import { loadEntriesFromFile } from "../../src/session/session-loader";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const resources: { dir: TempDir; managers: SessionManager[] }[] = [];
afterEach(async () => {
	for (const { dir, managers } of resources.splice(0)) {
		await Promise.all(managers.map(manager => manager.close()));
		await dir.remove();
	}
});
async function fixture() {
	const dir = TempDir.createSync("zcode-ledger-");
	const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
	await manager.ensureOnDisk();
	const managers = [manager];
	resources.push({ dir, managers });
	let active = true;
	const adapter = {
		get: (id: string) =>
			active && managers.some(item => item.getSessionId() === id)
				? { session: { sessionManager: managers.find(item => item.getSessionId() === id)!, isStreaming: false } }
				: undefined,
		list: async () => managers.map(item => ({ id: item.getSessionId() })),
		readCommandEntries: async (id: string): Promise<readonly SessionEntry[]> => {
			const source = managers.find(item => item.getSessionId() === id);
			if (!source) throw new Error("Session not found");
			return (
				await loadEntriesFromFile(source.getSessionFile()!, new FileSessionStorage(), { throwIfMissing: true })
			).filter((entry): entry is SessionEntry => entry.type !== "session");
		},
	};
	return {
		manager,
		managers,
		adapter,
		cold: () => {
			active = false;
		},
	};
}
function command(sessionId: string | null, commandId = "command-1"): CommandEnvelope {
	return { sessionId, commandId, clientId: "desktop", issuedAt: 1, type: "sendText", payload: { text: "same text" } };
}
function accepted(envelope: CommandEnvelope): CommandAck {
	return {
		commandId: envelope.commandId,
		status: "accepted",
		revisionAtDecision: 1,
		result: { type: "inputAccepted", inputId: envelope.commandId, delivery: "queue" },
	};
}

describe("ZCode durable command facts", () => {
	it("does not let deletion after the journal list snapshot poison a new create or query", async () => {
		const { manager, managers, adapter } = await fixture();
		const retiredId = manager.getSessionId();
		const owner = new ZCodeSessionManager({
			cwd: manager.getCwd(),
			sessionDir: path.dirname(manager.getSessionFile()!),
		});
		const destination = SessionManager.create(manager.getCwd(), path.dirname(manager.getSessionFile()!));
		await destination.ensureOnDisk();
		managers.push(destination);
		const snapshot = await adapter.list();
		await manager.close();
		await owner.delete(retiredId);
		const ledger = new ZCodeCommandLedger({
			...adapter,
			list: async () => snapshot,
			readCommandEntries: id => owner.readCommandEntries(id),
		});
		const envelope: CommandEnvelope = {
			...command(null, "next-draft"),
			type: "createSession",
			payload: { workspaceId: "workspace" },
		};
		const result = { type: "createSession" as const, sessionId: destination.getSessionId() };
		let decisions = 0;
		const ack = await ledger.execute(envelope, async () => {
			decisions++;
			return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 4, result };
		});
		expect(ack).toMatchObject({ status: "accepted", result });
		expect(decisions).toBe(1);
		const query = await new ZCodeCommandLedger({
			...adapter,
			list: async () => snapshot,
			readCommandEntries: id => owner.readCommandEntries(id),
		}).query([{ sessionId: null, commandId: envelope.commandId }]);
		expect(query.results[0]?.result).toMatchObject({ status: "accepted", result });
	});

	it("keeps an admitted journal read alive until deletion can safely remove it", async () => {
		const { manager } = await fixture();
		const id = manager.getSessionId();
		const owner = new ZCodeSessionManager({
			cwd: manager.getCwd(),
			sessionDir: path.dirname(manager.getSessionFile()!),
		});
		await manager.close();
		const readEntries = owner.readEntries.bind(owner);
		const gate = Promise.withResolvers<void>();
		owner.readEntries = async sessionId => {
			await gate.promise;
			return readEntries(sessionId);
		};
		const reading = owner.readCommandEntries(id);
		const deleting = owner.delete(id);
		gate.resolve();
		expect(await reading).toBeArray();
		await deleting;
		expect(await owner.readCommandEntries(id)).toBeUndefined();
	});

	it("finishes an admitted read and deletion before recreating the same explicit identity", async () => {
		const { manager, managers, adapter } = await fixture();
		const id = manager.getSessionId();
		const envelope = command(id, "retired-command");
		await new ZCodeCommandLedger(adapter).execute(envelope, async () => accepted(envelope));
		await manager.flush();
		await manager.close();
		const authStorage = await AuthStorage.create(":memory:");
		const owner = new ZCodeSessionManager({
			cwd: manager.getCwd(),
			sessionDir: path.dirname(manager.getSessionFile()!),
			agentDir: path.join(manager.getCwd(), "agent"),
			sessionOptions: {
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				toolNames: [],
				restrictToolNames: true,
				skills: [],
				customTools: [],
				extensions: [],
				disableExtensionDiscovery: true,
			},
		});
		const gate = Promise.withResolvers<void>();
		const readEntries = owner.readEntries.bind(owner);
		const order: string[] = [];
		owner.readEntries = async sessionId => {
			await gate.promise;
			return readEntries(sessionId);
		};
		try {
			const reading = owner.readCommandEntries(id).then(entries => {
				order.push("read");
				return entries;
			});
			const deleting = owner.delete(id).then(() => {
				order.push("delete");
			});
			const creating = owner.create({ sessionId: id }).then(record => {
				order.push("create");
				return record;
			});
			expect(order).toEqual([]);
			gate.resolve();
			const [entries, , recreated] = await Promise.all([reading, deleting, creating]);
			expect(entries?.length).toBeGreaterThan(0);
			expect(order).toEqual(["read", "delete", "create"]);
			expect(recreated.id).toBe(id);
			expect(owner.get(id)).toBe(recreated);
			const query = await new ZCodeCommandLedger(owner).query([{ sessionId: id, commandId: envelope.commandId }]);
			expect(query.results[0]?.result).toBe("unknown");
			await recreated.session.sessionManager.flush();
			const recreatedPath = recreated.session.sessionManager.getSessionFile()!;
			await owner.close(id);
			const foreign = await SessionManager.open(
				recreatedPath,
				path.dirname(recreatedPath),
				new FileSessionStorage(),
				{
					throwIfMissing: true,
					suppressBreadcrumb: true,
					runtimeOwnership: true,
				},
			);
			managers.push(foreign);
			foreign.acquireRuntimeOwnership();
			expect(foreign.getSessionId()).toBe(id);
			await foreign.close();
		} finally {
			gate.resolve();
			await owner.dispose();
			// Hosting opens process-wide SQLite caches outside the session manager's lifetime.
			// Release their Windows file handles before the fixture removes its agent directory.
			HistoryStorage.close();
			closeSessionIndex();
			AgentStorage.close();
			closeModelCache();
			authStorage.close();
		}
	});

	it("surfaces journal IO failures rather than treating unreadable history as deletion", async () => {
		const { manager, adapter } = await fixture();
		const failure = new Error("journal IO failure");
		const owner = new ZCodeSessionManager({
			cwd: manager.getCwd(),
			sessionDir: path.dirname(manager.getSessionFile()!),
		});
		owner.readEntries = async () => {
			throw failure;
		};
		const ledger = new ZCodeCommandLedger({
			...adapter,
			readCommandEntries: id => owner.readCommandEntries(id),
		});
		await expect(
			ledger.execute(command(manager.getSessionId()), async () => {
				throw new Error("must not admit after an unreadable journal");
			}),
		).rejects.toBe(failure);
	});

	it.each([
		{ name: "void", result: undefined, known: true },
		{ name: "empty", result: "", known: true },
		{ name: "transformed", result: "Expanded native command prompt", known: true },
		{ name: "unknown", result: undefined, known: false },
	])("admits a native custom command exactly once: $name", async ({ name, result, known }) => {
		const { manager, adapter } = await fixture();
		const auth = await AuthStorage.create(":memory:");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		auth.keys.setRuntime(model.provider, "isolated-native-command-test");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const registry = new ModelRegistry(auth, path.join(manager.getCwd(), "models.yml"), {
			settings,
			ignoreLocalModelConfig: true,
			fetch: () => Promise.reject(new Error("Network forbidden in native command regression")),
		});
		const executed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let effects = 0;
		let admissions = 0;
		let modelTurns = 0;
		const customCommand: LoadedCustomCommand = {
			path: "native-admission-probe.ts",
			resolvedPath: path.join(manager.getCwd(), "native-admission-probe.ts"),
			source: "project",
			command: {
				name: "native-admission-probe",
				description: "Native custom command admission regression",
				execute: async () => {
					effects++;
					executed.resolve();
					await release.promise;
					return result;
				},
			},
		};
		const mock = createMockModel({
			handler: () => {
				modelTurns++;
				return { content: ["Input completed."] };
			},
		});
		const session = new AgentSession({
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			customCommands: [customCommand],
			agent: new Agent({
				getApiKey: () => "isolated-native-command-test",
				initialState: { model, systemPrompt: ["Isolated native command admission"], tools: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
		});
		const text = known ? "/native-admission-probe" : "/unregistered-admission-probe";
		const envelope: CommandEnvelope = {
			...command(manager.getSessionId(), `native-${name}`),
			payload: { text },
		};
		const ledger = new ZCodeCommandLedger(adapter);
		const decide = async () => {
			await session.prompt(text, {
				inputId: envelope.commandId,
				sourceCommand: ledger.identity(envelope),
				onPromptAdmitted: () => {
					admissions++;
				},
			});
			// 中文修复依据：原生 void 命令不产生模型正文，必须仍有真实准入；
			// 非空变换与未知命令只能由后续模型／队列边界准入一次。
			if (admissions !== 1) throw new Error("Input completed without exactly one runtime admission");
			return accepted(envelope);
		};
		try {
			const first = ledger.execute(envelope, decide);
			if (known) {
				await executed.promise;
				expect(admissions).toBe(0);
			}
			release.resolve();
			expect(await first).toMatchObject({ status: "accepted" });
			expect(await ledger.execute(envelope, decide)).toMatchObject({ status: "duplicate" });
			expect(effects).toBe(known ? 1 : 0);
			expect(admissions).toBe(1);
			expect(modelTurns).toBe(result || !known ? 1 : 0);
			const userMessages = session.messages.filter(message => message.role === "user");
			if (result || !known) {
				expect(userMessages).toHaveLength(1);
				expect(userMessages[0]?.content).toEqual([{ type: "text", text: result || text }]);
			} else {
				expect(userMessages).toHaveLength(0);
			}
		} finally {
			release.resolve();
			await session.dispose();
			auth.close();
		}
	});

	it("keeps raw native command arguments in durable identity across reconnect and session boundaries", async () => {
		const { manager, managers, adapter, cold } = await fixture();
		const peer = SessionManager.create(manager.getCwd(), path.dirname(manager.getSessionFile()!));
		await peer.ensureOnDisk();
		managers.push(peer);
		const text = '/compact Preserve "quoted checkpoint"  and   internal spaces\nKeep cedar-731.';
		const envelope: CommandEnvelope = {
			...command(manager.getSessionId(), "raw-native-command"),
			payload: { text },
		};
		const auth = await AuthStorage.create(":memory:");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		auth.keys.setRuntime(model.provider, "isolated-ledger-test");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const registry = new ModelRegistry(auth, path.join(manager.getCwd(), "models.yml"), {
			settings,
			ignoreLocalModelConfig: true,
			fetch: () => Promise.reject(new Error("Network forbidden in ledger regression")),
		});
		const sessions = [manager, peer].map(sessionManager => {
			const mock = createMockModel({ handler: { content: ["Input completed."] } });
			return new AgentSession({
				sessionManager,
				settings,
				modelRegistry: registry,
				agent: new Agent({
					getApiKey: () => "isolated-ledger-test",
					initialState: { model, systemPrompt: ["Isolated ledger input lifecycle"], tools: [] },
					convertToLlm,
					streamFn: mock.stream,
				}),
			});
		});
		const ledger = new ZCodeCommandLedger(adapter);
		let decisions = 0;
		const decide = async (input: CommandEnvelope, index: number) => {
			decisions++;
			// 使用真实 AgentSession admission 与 journal promotion，而不是只返回
			// inputAccepted；未 promotion 的输入跨 epoch 应按合同 discarded。
			await sessions[index]!.prompt(text, {
				inputId: input.commandId,
				sourceCommand: ledger.identity(input),
			});
			await sessions[index]!.sessionManager.flush();
			return accepted(input);
		};
		try {
			await ledger.execute(envelope, () => decide(envelope, 0));
			const reconnected = new ZCodeCommandLedger(adapter);
			expect(
				await reconnected.execute({ ...envelope, clientId: "reconnected", issuedAt: 99 }, async () => {
					throw new Error("A restored command must not execute again");
				}),
			).toMatchObject({ status: "duplicate" });
			// 中文修复依据：引号、换行和内部空格均属于原生命令参数，去重不能把
			// 规范化后的另一条输入当成相同 payload，更不能在恢复时重新执行。
			for (const changed of [
				text.replace('"quoted checkpoint"', "quoted checkpoint"),
				text.replace("\n", " "),
				text.replace("  and   ", " and "),
			]) {
				await expect(
					reconnected.execute({ ...envelope, payload: { text: changed } }, async () => {
						throw new Error("Conflicting arguments must not reach admission");
					}),
				).rejects.toThrow("different payload");
			}
			const isolated = { ...envelope, sessionId: peer.getSessionId() };
			expect(await reconnected.execute(isolated, () => decide(isolated, 1))).toMatchObject({ status: "accepted" });
			expect(decisions).toBe(2);
			await Promise.all(managers.map(item => item.close()));
			cold();
			const keys = [
				{ sessionId: envelope.sessionId, commandId: envelope.commandId },
				{ sessionId: isolated.sessionId, commandId: isolated.commandId },
			];
			const restarted = new ZCodeCommandLedger(adapter);
			const facts = await restarted.query(keys);
			expect(facts.results).toEqual([
				{ key: keys[0], result: accepted(envelope) },
				{ key: keys[1], result: accepted(isolated) },
			]);
			expect(
				await restarted.execute(envelope, async () => {
					throw new Error("Cold history recovery must not execute again");
				}),
			).toMatchObject({ status: "duplicate" });
			const rows = await loadEntriesFromFile(manager.getSessionFile()!, new FileSessionStorage(), {
				throwIfMissing: true,
			});
			expect(
				rows.filter(
					entry =>
						entry.type === "message" &&
						"inputId" in entry.message &&
						entry.message.inputId === envelope.commandId,
				),
			).toHaveLength(1);
		} finally {
			await Promise.all(sessions.map(session => session.dispose()));
			auth.close();
		}
	});

	it("shares an in-flight decision and rejects semantic identity reuse", async () => {
		const { manager, adapter } = await fixture();
		const ledger = new ZCodeCommandLedger(adapter);
		const envelope = command(manager.getSessionId());
		const gate = Promise.withResolvers<void>();
		let runs = 0;
		const decide = async () => {
			runs++;
			await gate.promise;
			return accepted(envelope);
		};
		const first = ledger.execute(envelope, decide);
		const duplicate = ledger.execute({ ...envelope, issuedAt: 99, clientId: "mobile" }, decide);
		gate.resolve();
		expect((await first).status).toBe("accepted");
		expect((await duplicate).status).toBe("duplicate");
		expect(runs).toBe(1);
		await expect(ledger.execute({ ...envelope, payload: { text: "changed" } }, decide)).rejects.toThrow(
			"different payload",
		);
	});

	it("recovers promoted input by actual journal identity without activation or replay", async () => {
		const { manager, adapter, cold } = await fixture();
		const envelope = command(manager.getSessionId());
		await new ZCodeCommandLedger(adapter).execute(envelope, async () => {
			const message: AgentUserMessage = {
				role: "user",
				content: "same text",
				timestamp: 1,
				inputId: envelope.commandId,
			};
			manager.appendMessage(message);
			return accepted(envelope);
		});
		await manager.flush();
		cold();
		const restarted = new ZCodeCommandLedger(adapter);
		const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
		expect((await restarted.query([key])).results[0]?.result).toEqual(accepted(envelope));
		expect(
			(
				await restarted.execute({ ...envelope, issuedAt: 2 }, async () => {
					throw new Error("must not execute");
				})
			).status,
		).toBe("duplicate");
		expect((await restarted.query([{ ...key, commandId: "missing" }])).results[0]?.result).toBe("unknown");
	});

	it("reports admitted but unpromoted inputs discarded after restart, never replays them", async () => {
		const { manager, adapter, cold } = await fixture();
		const envelope = command(manager.getSessionId());
		await new ZCodeCommandLedger(adapter).execute(envelope, async () => accepted(envelope));
		cold();
		const restarted = new ZCodeCommandLedger(adapter);
		const result = (await restarted.query([{ sessionId: envelope.sessionId, commandId: envelope.commandId }]))
			.results[0]?.result;
		expect(result).toMatchObject({ status: "failed", reasonCode: "session_resumed" });
		expect(
			(
				await restarted.execute(envelope, async () => {
					throw new Error("must not execute");
				})
			).status,
		).toBe("duplicate");
	});

	it("keeps equal text under different command ids distinct and recovers evicted receipts", async () => {
		const { manager, adapter } = await fixture();
		const ledger = new ZCodeCommandLedger(adapter, { settledLimit: 1 });
		let runs = 0;
		for (const id of ["first", "second"]) {
			const envelope = command(manager.getSessionId(), id);
			await ledger.execute(envelope, async () => {
				runs++;
				return { commandId: id, status: "accepted", revisionAtDecision: 1 };
			});
		}
		const replay = await ledger.execute(command(manager.getSessionId(), "first"), async () => {
			runs++;
			return accepted(command(manager.getSessionId(), "first"));
		});
		expect(replay.status).toBe("duplicate");
		expect(runs).toBe(2);
	});

	it.each(["createSession", "createSelectionSideSession"] as const)(
		"discovers %s in the actual produced journal before a final receipt exists",
		async type => {
			const { manager, adapter, cold } = await fixture();
			const envelope: CommandEnvelope = {
				...command(type === "createSession" ? null : manager.getSessionId()),
				type,
				payload: { workspaceId: "workspace" },
			};
			const result = { type, sessionId: manager.getSessionId() };
			await new ZCodeCommandLedger(adapter).recordProduced(envelope, manager.getSessionId(), result, 0);
			cold();
			const replay = await new ZCodeCommandLedger(adapter).execute(envelope, async () => {
				throw new Error("must not create twice");
			});
			expect(replay).toMatchObject({ status: "duplicate", result });
		},
	);

	it("recovers durable runtime admission when the process dies before the ACK receipt", async () => {
		const { manager, adapter, cold } = await fixture();
		const envelope = command(manager.getSessionId());
		const sourceCommand = new ZCodeCommandLedger(adapter).identity(envelope);
		await manager.appendEntriesAtomically(() =>
			manager.appendCustomEntry("session_input", {
				inputId: envelope.commandId,
				state: "admitted",
				sourceCommand,
			}),
		);
		cold();
		const restarted = new ZCodeCommandLedger(adapter);
		expect(
			(await restarted.query([{ sessionId: envelope.sessionId, commandId: envelope.commandId }])).results[0]?.result,
		).toMatchObject({ status: "failed", reasonCode: "session_resumed" });
		await expect(
			restarted.execute({ ...envelope, payload: { text: "different" } }, async () => accepted(envelope)),
		).rejects.toThrow("different payload");
		expect(
			(
				await restarted.execute(envelope, async () => {
					throw new Error("must not replay admission");
				})
			).status,
		).toBe("duplicate");
	});

	it("uses a stable promoted user entry rather than text to reconcile partial admission", async () => {
		const { manager, adapter, cold } = await fixture();
		const envelope = command(manager.getSessionId());
		const sourceCommand = new ZCodeCommandLedger(adapter).identity(envelope);
		await manager.appendEntriesAtomically(() => {
			manager.appendCustomEntry("session_input", { inputId: envelope.commandId, state: "admitted", sourceCommand });
			const message: AgentUserMessage = {
				role: "user",
				content: "different rendered text",
				timestamp: 1,
				inputId: envelope.commandId,
			};
			manager.appendMessage(message);
		});
		cold();
		expect(
			(
				await new ZCodeCommandLedger(adapter).query([
					{ sessionId: envelope.sessionId, commandId: envelope.commandId },
				])
			).results[0]?.result,
		).toMatchObject({ status: "accepted", commandId: envelope.commandId });
	});

	it("reports actual cancellation instead of a stale cached accepted receipt", async () => {
		const { manager, adapter } = await fixture();
		const envelope = command(manager.getSessionId());
		const ledger = new ZCodeCommandLedger(adapter);
		await ledger.execute(envelope, async () => accepted(envelope));
		await manager.appendEntriesAtomically(() =>
			manager.appendCustomEntry("session_input", {
				inputId: envelope.commandId,
				state: "cancelled",
				sourceCommand: ledger.identity(envelope),
			}),
		);
		expect(
			(await ledger.query([{ sessionId: envelope.sessionId, commandId: envelope.commandId }])).results[0]?.result,
		).toMatchObject({ status: "failed", reasonCode: "input.cancelled" });
	});

	it("discovers fork results in the produced session and ignores copied parent receipts", async () => {
		const { manager, managers, adapter, cold } = await fixture();
		const ledger = new ZCodeCommandLedger(adapter);
		const original = command(manager.getSessionId(), "shared-id");
		await ledger.execute(original, async () => ({
			commandId: original.commandId,
			status: "accepted",
			revisionAtDecision: 1,
		}));
		const child = await manager.persistCopy({ sessionDir: manager.getSessionDir(), suppressBreadcrumb: true });
		managers.push(child);
		let childRuns = 0;
		const childCommand = command(child.getSessionId(), "shared-id");
		await ledger.execute(childCommand, async () => {
			childRuns++;
			return { commandId: childCommand.commandId, status: "accepted", revisionAtDecision: 1 };
		});
		expect(childRuns).toBe(1);
		const fork: CommandEnvelope = {
			...command(manager.getSessionId(), "fork-id"),
			type: "forkAssistant",
			payload: {},
		};
		const result = { type: "forkAssistant" as const, sessionId: child.getSessionId() };
		await ledger.recordProduced(fork, child.getSessionId(), result, 1);
		cold();
		expect(
			await new ZCodeCommandLedger(adapter).execute(fork, async () => {
				throw new Error("must not fork twice");
			}),
		).toMatchObject({ status: "duplicate", result });
	});
});
