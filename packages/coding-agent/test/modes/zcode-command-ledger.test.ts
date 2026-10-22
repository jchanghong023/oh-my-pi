import { afterEach, describe, expect, it } from "bun:test";
import type { AgentUserMessage } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { ZCodeCommandLedger } from "../../src/modes/zcode/command-ledger";
import type { CommandAck, CommandEnvelope } from "../../src/modes/zcode/schema";
import { ZCodeSessionManager } from "../../src/modes/zcode/sessions";
import { AgentStorage } from "../../src/session/agent-storage";
import { AuthStorage } from "../../src/session/auth-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import type { SessionEntry } from "../../src/session/session-entries";
import { closeSessionIndex } from "../../src/session/session-index";
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
