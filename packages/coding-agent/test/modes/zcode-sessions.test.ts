import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ZCodeSessionManager } from "../../src/modes/zcode/sessions";
import { ModelRegistry } from "../../src/config/model-registry";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ZCodeQueries } from "../../src/modes/zcode/queries";
import { TextTap } from "../../src/job-widgets/text-tap";

const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-sessions-"));
	resources.push(() => fs.rm(root, { recursive: true, force: true }));
	resources.push(async () => {
		HistoryStorage.close();
		closeSessionIndex();
		AgentStorage.close();
		closeModelCache();
	});
	const authStorage = await AuthStorage.create(":memory:");
	resources.push(async () => {
		authStorage.close();
	});
	const modelRegistry = new ModelRegistry(authStorage);
	const cwd = path.join(root, "a");
	const other = path.join(root, "b");
	await fs.mkdir(cwd);
	await fs.mkdir(other);
	const manager = new ZCodeSessionManager({
		cwd,
		agentDir: path.join(root, "agent"),
		sessionOptions: {
			toolNames: [],
			restrictToolNames: true,
			skills: [],
			customTools: [],
			extensions: [],
			disableExtensionDiscovery: true,
			authStorage,
			modelRegistry,
		},
	});
	resources.push(() => manager.dispose());
	return { manager, cwd, other, root };
}

describe("ZCodeSessionManager", () => {
	it("reads cold child Bash output only from its existing execution tree across registry eviction and revival", async () => {
		const { manager, cwd } = await fixture();
		const [root, foreign] = await Promise.all([manager.create(), manager.create()]);
		const source = new TextTap("out", "output");
		source.append("prefix" + "中".repeat(5000));
		const jobs = root.session.asyncJobManager!;
		const foreignJobs = foreign.session.asyncJobManager!;
		const gate = Promise.withResolvers<string>();
		resources.push(async () => {
			gate.resolve("");
		});
		const file = root.session.sessionManager.getSessionFile()!;
		const childFile = path.join(file.slice(0, -6), "Child.jsonl");
		await fs.mkdir(path.dirname(childFile), { recursive: true });
		await fs.writeFile(
			childFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "cold-child",
				timestamp: new Date().toISOString(),
				cwd,
			}) + "\n",
		);
		root.registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: childFile,
			status: "parked",
		});
		jobs.register("task", "child", () => gate.promise, { id: "task-child", ownerId: "Main", agentId: "Child" });
		jobs.register("bash", "child output", () => gate.promise, {
			id: "collision",
			ownerId: "Child",
			widgetInputs: { sources: () => [source], brief: () => ({ kind: "bash" }) },
		});
		const secret = new TextTap("out", "secret");
		secret.append("foreign-secret");
		foreignJobs.register("bash", "unrelated output", () => gate.promise, {
			id: "collision",
			ownerId: "Main",
			widgetInputs: { sources: () => [secret], brief: () => ({ kind: "bash" }) },
		});
		jobs.register("bash", "sibling output", () => gate.promise, { id: "sibling", ownerId: "Sibling" });
		const queries = new ZCodeQueries({ manager, getProjection: () => undefined });
		const params = { sessionId: "cold-child", workId: "collision" };
		const result = await queries.backgroundBashOutput(params);
		expect(result.kind).toBe("output");
		if (result.kind !== "output") throw new Error("missing child output");
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(8192);
		expect(result.output).not.toContain("�");
		expect(result.truncated).toBe(true);
		expect((await queries.backgroundBashOutput({ ...params, sessionId: root.id })).kind).toBe("output");
		expect(await queries.backgroundBashOutput({ ...params, sessionId: foreign.id })).toMatchObject({
			kind: "output",
			output: "foreign-secret",
		});
		expect(await queries.backgroundBashOutput({ ...params, sessionId: "foreign-child" })).toMatchObject({
			kind: "unavailable",
		});
		expect(await queries.backgroundBashOutput({ ...params, workId: "sibling" })).toMatchObject({
			kind: "unavailable",
		});
		expect(await queries.backgroundBashOutput({ sessionId: root.id, workId: "task-child" })).toMatchObject({
			kind: "unavailable",
		});
		root.registry.unregister("Child");
		expect((await queries.backgroundBashOutput(params)).kind).toBe("output");
		// 恢复 UI 快照不重建历史后台目录；existing-only 输出查询也不激活冷会话。
		expect(manager.get("cold-child")).toBeUndefined();
		const hot = await manager.create({ sessionId: "cold-child" });
		expect((await queries.backgroundBashOutput(params)).kind).toBe("output");
		await manager.close(hot.id);
		expect((await queries.backgroundBashOutput(params)).kind).toBe("output");
		const revived = await manager.create({ sessionId: "revived-child" });
		root.registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: revived.session,
			sessionFile: childFile,
		});
		expect((await queries.backgroundBashOutput({ ...params, sessionId: revived.id })).kind).toBe("output");
		expect((await queries.backgroundBashOutput(params)).kind).toBe("unavailable");
		source.read = () => {
			throw Object.assign(new Error("read"), { code: "EIO" });
		};
		expect(await queries.backgroundBashOutput({ ...params, sessionId: revived.id })).toMatchObject({
			kind: "read_failed",
			code: "EIO",
		});
		gate.resolve("");
		await manager.close(root.id);
		expect((await queries.backgroundBashOutput({ ...params, sessionId: revived.id })).kind).toBe("unavailable");
	});

	it("isolates two main registries, settings and bound working directories", async () => {
		const { manager, cwd, other } = await fixture();
		const processCwd = process.cwd();
		const [a, b] = await Promise.all([manager.create(), manager.create({ cwd: other })]);
		expect(a.cwd).toBe(cwd);
		expect(b.cwd).toBe(other);
		expect(a.settings).not.toBe(b.settings);
		expect(a.registry).not.toBe(b.registry);
		expect(a.registry.get("Main")?.session).toBe(a.session);
		expect(b.registry.get("Main")?.session).toBe(b.session);
		await manager.stop(a.id);
		await manager.close(a.id);
		expect(b.session.isDisposed).toBe(false);
		expect(manager.get(b.id)).toBe(b);
		expect(process.cwd()).toBe(processCwd);
	});

	it("keeps asynchronous registry/lifecycle lookups in the owning main namespace", async () => {
		const { manager } = await fixture();
		const [a, b] = await Promise.all([manager.create(), manager.create()]);
		const gate = Promise.withResolvers<void>();
		const checkA = a.run(async () => {
			const lifecycle = AgentLifecycleManager.global();
			await gate.promise;
			expect(AgentRegistry.global()).toBe(a.registry);
			expect(AgentLifecycleManager.global()).toBe(lifecycle);
			expect(lifecycle.manages(a.registry)).toBe(true);
		});
		await b.run(async () => {
			await Promise.resolve();
			expect(AgentRegistry.global()).toBe(b.registry);
			expect(AgentLifecycleManager.global().manages(b.registry)).toBe(true);
			gate.resolve();
		});
		await checkA;
	});

	it("edits and removes duplicate-text queued inputs by stable identity only", async () => {
		const { manager } = await fixture();
		const record = await manager.create();
		record.session.setQueueAutoDrain(false);
		const first = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "same" }],
			timestamp: 1,
			inputId: "first",
		};
		const second = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "same" }],
			timestamp: 2,
			inputId: "second",
		};
		record.session.agent.followUp(first);
		record.session.agent.followUp(second);
		await manager.mutate(record.id, "editQueueItem", { queueItemId: "second", newText: "changed" });
		expect(record.session.getQueuedMessages().followUp).toEqual(["same", "changed"]);
		await manager.mutate(record.id, "deleteQueueItem", { queueItemId: "first" });
		expect(record.session.getQueuedMessages().followUp).toEqual(["changed"]);
		expect(record.session.getQueueAutoDrain()).toBe(false);
	});

	it("retains custom input provenance and attachments in the actual held queue", async () => {
		const { manager } = await fixture();
		const record = await manager.create();
		record.session.setQueueAutoDrain(false);
		const sourceCommand = {
			sessionId: record.id,
			commandId: "skill-command",
			fingerprint: "skill-fingerprint",
			epoch: "epoch",
		};
		const attachments = [{ ref: "attachment:skill", fileName: "input.txt", mime: "text/plain", bytes: 3 }];
		await record.run(() =>
			record.session.promptCustomMessage(
				{
					customType: "adapter-input",
					content: "same",
					display: true,
					attribution: "user",
				},
				{
					inputId: "skill-input",
					inputClientId: "client",
					sourceCommand,
					attachments,
					toolDenylist: ["bash"],
					queueOnly: true,
					streamingBehavior: "followUp",
				},
			),
		);
		expect(record.session.getQueuedInputMessages()).toHaveLength(1);
		expect(record.session.getQueuedInputMessages()[0]).toMatchObject({
			role: "custom",
			inputId: "skill-input",
			inputClientId: "client",
			sourceCommand,
			attachments,
			toolDenylist: ["bash"],
			inputAdmissionSeq: 1,
		});
		await manager.mutate(record.id, "editQueueItem", { queueItemId: "skill-input", newText: "edited" });
		expect(record.session.getQueuedInputMessages()[0]).toMatchObject({
			role: "user",
			inputId: "skill-input",
			inputClientId: "client",
			sourceCommand,
			attachments,
			toolDenylist: ["bash"],
			inputAdmissionSeq: 1,
		});
		expect(record.session.getQueueAutoDrain()).toBe(false);
	});

	it("uses the requested OMP identity and preserves admission facts across cold reads", async () => {
		const { manager } = await fixture();
		const record = await manager.create({ sessionId: "requested-session" });
		expect(record.id).toBe("requested-session");
		const sourceCommand = {
			sessionId: record.id,
			commandId: "command-1",
			fingerprint: "semantic-fingerprint",
			epoch: "epoch-1",
		};
		await manager.recordInputAdmission(record.id, "input-1", sourceCommand);
		await manager.close(record.id);
		const facts = await manager.readEntries(record.id);
		expect(
			facts.some(
				entry =>
					entry.type === "custom" &&
					entry.customType === "session_input" &&
					JSON.stringify(entry.data) ===
						JSON.stringify({ inputId: "input-1", state: "admitted", sourceCommand, delivery: "startNow" }),
			),
		).toBe(true);
		expect(manager.get(record.id)).toBeUndefined();
		await expect(manager.create({ sessionId: record.id })).rejects.toThrow("already exists");
	});

	it("targets model IO preferences by bound directory and includes newly created sessions", async () => {
		const { manager, cwd, other } = await fixture();
		await manager.create();
		await manager.create({ cwd: other });
		expect(manager.applyModelIoPreferences(cwd, true)).toBe(1);
		await manager.create();
		expect(manager.applyModelIoPreferences(cwd, false)).toBe(2);
		expect(manager.applyModelIoPreferences(other, true)).toBe(1);
	});

	it("blocks profile switching only while deletion is active and recovers after a failed deletion", async () => {
		const { manager } = await fixture();
		const record = await manager.create();
		const close = manager.close.bind(manager);
		const closeSpy = spyOn(manager, "close");
		try {
			closeSpy.mockImplementationOnce(async () => {
				throw new Error("close failed before deleting history");
			});
			await expect(manager.delete(record.id)).rejects.toThrow("close failed");
			expect(manager.profileSwitchBlockers()).toEqual([]);
			const info = (await manager.list()).find(item => item.id === record.id)!;
			expect(await manager.readCommandEntries(info)).toBeArray();
			expect(manager.get(record.id)).toBe(record);

			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			closeSpy.mockImplementationOnce(async id => {
				entered.resolve();
				await release.promise;
				await close(id);
			});
			const deleting = manager.delete(record.id);
			try {
				await entered.promise;
				expect(manager.profileSwitchBlockers()).toContainEqual(
					expect.objectContaining({ code: "sessionTransition" }),
				);
			} finally {
				release.resolve();
				await deleting;
			}
			expect(manager.profileSwitchBlockers()).toEqual([]);
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("validates concurrent resume options against the winning session without replacing its configuration", async () => {
		const { manager, cwd, other, root } = await fixture();
		const record = await manager.create({ additionalDirectories: [other] });
		await manager.close(record.id);
		const opening = manager.resume(record.id, {
			mcpServers: [],
			toolAllowlist: ["read"],
			toolDenylist: ["bash"],
			additionalDirectories: [other],
		});
		const conflicts = [
			manager.resume(record.id, {
				mcpServers: [{ name: "different", command: process.execPath, args: [], env: [] }],
			}),
			manager.resume(record.id, { toolAllowlist: [] }),
			manager.resume(record.id, { toolDenylist: [] }),
			manager.resume(record.id, { additionalDirectories: [root] }),
		];
		const compatible = manager.resume(record.id, {
			mcpServers: [],
			toolAllowlist: ["read"],
			toolDenylist: ["bash"],
			additionalDirectories: [path.relative(cwd, other), other, cwd],
		});
		const results = await Promise.allSettled(conflicts);
		const restored = await opening;
		expect(results.map(result => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
		expect(await compatible).toBe(restored);
		expect(manager.get(record.id)).toBe(restored);
		expect(restored.configuration.toolAllowlist).toEqual(["read"]);
		expect(restored.configuration.toolDenylist).toEqual(["bash"]);
		expect(restored.session.sessionManager.getAdditionalDirectories()).toEqual([other]);
		await expect(manager.resume(record.id, { additionalDirectories: [root] })).rejects.toThrow();
		expect(await manager.resume(record.id, { additionalDirectories: [] })).toBe(restored);
	});

	it("reads and renames cold history without hosting it, then restores and deletes it", async () => {
		const { manager } = await fixture();
		const record = await manager.create();
		await manager.close(record.id);
		await manager.rename(record.id, "Cold title");
		expect(manager.get(record.id)).toBeUndefined();
		expect((await manager.read(record.id)).title).toBe("Cold title");
		expect(manager.get(record.id)).toBeUndefined();
		const restored = await manager.resume(record.id);
		expect(restored.id).toBe(record.id);
		expect(await manager.resume(record.id)).toBe(restored);
		await manager.delete(record.id);
		expect((await manager.list()).some(info => info.id === record.id)).toBe(false);
		await expect(manager.read(record.id)).rejects.toThrow();
	});
});
