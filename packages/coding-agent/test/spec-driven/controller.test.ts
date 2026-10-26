import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../../src/session/agent-session";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import {
	getSpecDrivenController,
	observeSpecDrivenController,
	peekSpecDrivenController,
	type SpecDrivenController,
	type SpecRuntimeFactory,
} from "../../src/spec-driven/controller";
import type { SpecAgentInput, SpecConversationRecipient, SpecStageRole } from "../../src/spec-driven/types";
import { DevWorkspace } from "../../src/spec-driven/workspace";
const roots: string[] = [];
const owners: SpecDrivenController[] = [];
afterEach(async () => {
	for (const owner of owners.splice(0)) await owner.exit();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
const sessionListeners = new WeakMap<AgentSession, Set<(event: SessionEvent) => unknown>>();
function session(cwd: string): AgentSession {
	const listeners = new Set<(event: SessionEvent) => unknown>();
	const native = {
		sessionManager: { getCwd: () => cwd },
		isBusyForSnapshot: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		getAsyncJobTree: () => null,
		waitForAdmittedSubmissions: async () => {},
		waitForIdle: async () => {},
		subscribe: (listener: (event: SessionEvent) => unknown) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	} as unknown as AgentSession;
	sessionListeners.set(native, listeners);
	return native;
}
async function fixture(cwd?: string) {
	const root = cwd ?? (await fs.mkdtemp(path.join(os.tmpdir(), "dev-controller-")));
	if (!cwd) roots.push(root);
	const ordinary = session(root);
	const ordinaryHistory = [{ role: "user" as const, content: "ordinary draft", timestamp: 0 }];
	Object.assign(ordinary, { messages: ordinaryHistory });
	let bound = ordinary;
	const stages = new Map<SpecStageRole, AgentSession>();
	const refs = new Map<SpecStageRole, SpecConversationRecipient>();
	let prepareError: Error | undefined;
	const calls: string[] = [];
	const inputs: SpecAgentInput[] = [];
	let failPrepare = false;
	let failStop = false;
	let failInitialize = false;
	let failClose = false;
	let failModel = false;
	let runGate: Promise<void> | undefined;
	let modelStarted = Promise.withResolvers<void>();
	let pendingTeam: { owner: AgentSession; interrupt: () => Promise<boolean> } | undefined;
	const paths = { requirements: ["proposal.md"], solution: "solution.md", plan: "plan.md", report: "report.md" };
	const doc = (file: string) => ({ path: file, version: "bytes-1", content: "material" });
	const factory: SpecRuntimeFactory = async args => ({
		options: { runId: args.saved?.runId ?? crypto.randomUUID() },
		nativeSession: role => stages.get(role),
		sessionRefs: () => Object.fromEntries(refs),
		originalRequest: () => "request",
		hasPendingTeam: owner => pendingTeam?.owner === owner,
		async interruptTeam(owner) {
			if (pendingTeam?.owner !== owner) return false;
			const team = pendingTeam;
			pendingTeam = undefined;
			calls.push("interrupt-team");
			return team.interrupt();
		},
		async stop() {
			calls.push("stop");
			if (failStop) throw new Error("stop failed");
		},
		async dispose() {
			calls.push("dispose");
		},
		ports: {
			agents: {
				async prepare(role) {
					calls.push(`prepare:${role}`);
					if (prepareError) throw prepareError;
					if (failPrepare) throw new Error("prepare failed");
					if (!stages.has(role)) {
						const child = session(args.cwd);
						stages.set(role, child);
						args.onSessionCreated?.(role, child);
					}
					refs.set(role, {
						role,
						actorId: role,
						sessionId: role,
						sessionFile: path.join(args.cwd, `${role}.jsonl`),
					});
				},
				recipient: role => refs.get(role),
				originalRequest: () => "request",
				async run(input, context) {
					inputs.push(structuredClone(input));
					calls.push(`model:${input.role}`);
					modelStarted.resolve();
					if (failModel) throw new Error("network failed");
					context.signal.throwIfAborted();
					if (runGate) {
						let abort: () => void = () => {};
						const cancelled = new Promise<never>((_resolve, reject) => {
							abort = () => reject(context.signal.reason);
							context.signal.addEventListener("abort", abort, { once: true });
						});
						try {
							await Promise.race([runGate, cancelled]);
						} finally {
							context.signal.removeEventListener("abort", abort);
						}
					}
					return { text: "native" };
				},
			},
			artifacts: {
				async initialize() {
					calls.push("initialize");
					if (failInitialize) throw new Error("initialize failed");
					return paths;
				},
				async readRequirements() {
					return { files: paths.requirements.map(file => doc(file.replace("*", "greeting"))), version: "bytes-1" };
				},
				async readSolution() {
					return { ...doc("solution.md"), candidates: [{ id: "one", title: "One", content: "One" }] };
				},
				async readPlan() {
					return doc("plan.md");
				},
				async readReport() {
					return doc("report.md");
				},
				async checkVersions() {
					return { matches: true, changed: [] };
				},
				async close(input) {
					await input.onProgress?.({ synced: true });
					if (failClose) throw new Error("archive failed");
					return { archivedChangePath: "archive/change" };
				},
			},
		},
	});
	const host = {
		session: ordinary,
		sessionManager: ordinary.sessionManager,
		cwd: root,
		settings: {},
		output: () => {},
		bindMainSession: async (target: AgentSession) => {
			calls.push("bind");
			bound = target;
		},
	} as unknown as SlashCommandRuntime;
	const owner = getSpecDrivenController(host, { factory });
	owners.push(owner);
	return {
		owner,
		host,
		ordinary,
		stages,
		calls,
		inputs,
		root,
		paths,
		bound: () => bound,
		ordinaryHistory,
		failPrepare: (value: boolean) => {
			failPrepare = value;
		},
		failStop: (value: boolean) => {
			failStop = value;
		},
		failInitialize: (value: boolean) => {
			failInitialize = value;
		},
		failClose: (value: boolean) => {
			failClose = value;
		},
		prepareError: (error?: Error) => {
			prepareError = error;
		},
		failModel: (value: boolean) => {
			failModel = value;
		},
		gate: (value?: Promise<void>) => {
			runGate = value;
			modelStarted = Promise.withResolvers<void>();
		},
		waitForModel: () => modelStarted.promise,
		pendingTeam: (owner: AgentSession, interrupt: () => Promise<boolean>) => {
			pendingTeam = { owner, interrupt };
		},
		state: async () => JSON.parse(await fs.readFile(path.join(root, ".omp/dev/state.json"), "utf8")),
	};
}
describe("Dev workspace controller", () => {
	test("publishes ready actions after a direct native prompt releases admission and idle barriers", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		const native = f.owner.nativeSession()!;
		const admitted = Promise.withResolvers<void>();
		const idle = Promise.withResolvers<void>();
		Object.assign(native, {
			hasAdmittedSubmission: true,
			isBusyForSnapshot: true,
			waitForAdmittedSubmissions: () => admitted.promise,
			waitForIdle: () => idle.promise,
		});
		const ready = Promise.withResolvers<void>();
		let active = false;
		let nextAvailable = false;
		const unsubscribe = observeSpecDrivenController(f.ordinary.sessionManager, observation => {
			active = observation.active;
			nextAvailable = observation.interaction.actions.some(action => action.id === "next" && action.available);
			if (!active && nextAvailable) ready.resolve();
		});
		try {
			for (const listener of sessionListeners.get(native)!) {
				// The dispatcher must not await the barrier that drains its own handlers.
				expect(listener({ type: "agent_end", messages: [] })).toBeUndefined();
			}
			expect(active).toBe(true);
			expect(nextAvailable).toBe(false);
			Object.assign(native, { hasAdmittedSubmission: false });
			admitted.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(active).toBe(true);
			expect(nextAvailable).toBe(false);
			Object.assign(native, { isBusyForSnapshot: false });
			idle.resolve();
			await ready.promise;
			expect(active).toBe(false);
			expect(nextAvailable).toBe(true);
		} finally {
			admitted.resolve();
			idle.resolve();
			unsubscribe();
		}
	});
	test("rejects another owner without clearing the first owner's state or aliasing ordinary managers", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.setTeam(true);
		const b = await fixture(a.root);
		expect(peekSpecDrivenController({})).toBeUndefined();
		await expect(b.owner.enter()).rejects.toThrow("占用");
		expect(await a.state()).toEqual({ version: 1, team: true });
		await a.owner.exit();
		await b.owner.enter();
		expect(b.owner.status().useTeam).toBe(true);
	});
	test("reuses the controller but locks and restores the root manager's current workspace after exit", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.setTeam(true);
		await a.owner.exit();
		const savedA = await a.state();
		const b = await fixture();
		await b.owner.enter();
		await b.owner.new("request");
		const savedB = await b.state();
		const cwd = spyOn(a.ordinary.sessionManager, "getCwd").mockReturnValue(b.root);
		try {
			expect(a.host.cwd).toBe(a.root);
			expect(getSpecDrivenController({ ...a.host, cwd: b.root })).toBe(a.owner);
			expect(a.owner.observation().cwd).toBe(b.root);
			await expect(a.owner.enter()).rejects.toThrow("占用");
			expect(a.owner.observation().released).toBe(true);
			expect(await a.state()).toEqual(savedA);
			expect(await b.state()).toEqual(savedB);
			await b.owner.exit();
			await a.owner.enter();
			expect(a.owner.observation().cwd).toBe(await fs.realpath(b.root));
			expect(a.owner.observation().runId).toBe(savedB.run.runId);
			expect(a.owner.status().phase).toBe("requirements");
			expect(a.owner.status().useTeam).toBe(false);
			expect(a.owner.observation().interaction.recipient?.sessionFile).toBe(
				savedB.run.sessions.requirements.sessionFile,
			);
			expect(a.calls.some(call => call.startsWith("model:"))).toBe(false);
			await expect(b.owner.enter()).rejects.toThrow("占用");
			const workspaceA = await DevWorkspace.acquire(a.root);
			try {
				expect(await workspaceA.read()).toEqual(savedA);
			} finally {
				workspaceA.release();
			}
			await a.owner.exit();
			expect(await a.state()).toEqual(savedA);
			expect(await b.state()).toEqual(savedB);
		} finally {
			cwd.mockRestore();
		}
	});
	test("observes authoritative approvals through back, exit and restore", async () => {
		const f = await fixture();
		expect(f.owner.observation().approvals).toEqual({});
		await f.owner.enter();
		await f.owner.new("request");
		await f.owner.next(undefined, "/dev next 批准需求");
		await f.owner.next("one", "/dev next one 批准方案");
		const approved = (await f.state()).run.approvals;
		expect(f.owner.observation().approvals).toEqual(approved);
		expect(approved.requirements.userReply).toBe("/dev next 批准需求");
		expect(approved.solution.userReply).toBe("/dev next one 批准方案");
		await f.owner.back();
		expect(f.owner.status().specification).toBeDefined();
		expect(f.owner.observation().approvals).toEqual({ requirements: approved.requirements });
		await f.owner.exit();
		expect(f.owner.observation().approvals).toEqual({ requirements: approved.requirements });
		await f.owner.enter();
		expect(f.owner.observation().approvals).toEqual({ requirements: approved.requirements });
		await f.owner.back();
		expect(f.owner.observation().approvals).toEqual({});
	});
	test("keeps configuration separate from run and aliases only owned stage managers", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.setTeam(true);
		expect(await f.state()).toEqual({ version: 1, team: true });
		await f.owner.new("request");
		expect(peekSpecDrivenController(f.stages.get("requirements")!.sessionManager)).toBe(f.owner);
		expect(f.owner.rootSession()).toBe(f.ordinary);
		expect(f.owner.nativeSession()).toBe(f.stages.get("requirements"));
		const state = await f.state();
		expect(Object.keys(state).sort()).toEqual(["run", "team", "version"]);
		expect(state.run.sessions.requirements.sessionFile).toBeString();
		expect(JSON.stringify(state)).not.toContain("material");
		await f.owner.drop();
		expect(await f.state()).toEqual({ version: 1, team: false });
		expect(f.owner.inputMode()).toBe("dev");
		expect(peekSpecDrivenController(f.stages.get("requirements")!.sessionManager)).toBeUndefined();
	});
	test("restores executing sessions whose approved requirement files resolve output patterns", async () => {
		const a = await fixture();
		a.paths.requirements = ["openspec/changes/native/proposal.md", "openspec/changes/native/specs/*/spec.md"];
		await a.owner.enter();
		await a.owner.new("request");
		await a.owner.next();
		await a.owner.next("one");
		await a.owner.next();
		const saved = await a.state();
		expect(saved.run.approvals.requirements.files.map((file: { path: string }) => file.path)).toEqual([
			"openspec/changes/native/proposal.md",
			"openspec/changes/native/specs/greeting/spec.md",
		]);
		expect(saved.run.paths.requirements).toContain("openspec/changes/native/specs/*/spec.md");
		await a.owner.exit();
		const b = await fixture(a.root);
		await b.owner.enter();
		expect(b.owner.status().phase).toBe("executing");
		expect(b.owner.observation().interaction.recipient?.sessionFile).toBe(saved.run.sessions.executor.sessionFile);
		const native = b.owner.nativeSession();
		if (!native) throw new Error("Restored executor native session is missing");
		expect(b.bound()).toBe(native);
		expect(b.calls.some(call => call.startsWith("model:"))).toBe(false);
		expect(await b.state()).toEqual(saved);
	});
	test("restores native references without model work even when history is unavailable", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.setTeam(true);
		await a.owner.new("request");
		await a.owner.next();
		await a.owner.next();
		await a.owner.next();
		await a.owner.exit();
		const saved = await a.state();
		for (const ref of Object.values(saved.run.sessions) as SpecConversationRecipient[]) {
			await expect(fs.stat(ref.sessionFile!)).rejects.toMatchObject({ code: "ENOENT" });
		}
		const b = await fixture(a.root);
		await b.owner.enter();
		expect(b.owner.status().phase).toBe("executing");
		expect(b.owner.status().useTeam).toBe(true);
		expect(b.calls.some(call => call.startsWith("model:"))).toBe(false);
		expect(b.owner.nativeSession()).toBeDefined();
		expect(await b.state()).toEqual(saved);
	});
	test("failed restored preparation returns to ordinary chat and retries the same saved run", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.setTeam(true);
		await a.owner.new("request");
		await a.owner.exit();
		const saved = await fs.readFile(path.join(a.root, ".omp/dev/state.json"), "utf8");
		const b = await fixture(a.root);
		b.failPrepare(true);
		await expect(b.owner.enter()).rejects.toThrow("prepare failed");
		expect(b.owner.inputMode()).toBe("chat");
		expect(b.bound()).toBe(b.ordinary);
		expect(b.owner.observation().released).toBe(true);
		expect(b.owner.observation().interaction.recipient).toBeUndefined();
		expect(b.ordinary.messages).toBe(b.ordinaryHistory);
		await expect(b.owner.submitText("not a Dev prompt")).rejects.toThrow();
		expect(b.calls).not.toContain("model:requirements");
		expect(await fs.readFile(path.join(a.root, ".omp/dev/state.json"), "utf8")).toBe(saved);
		b.failPrepare(false);
		await b.owner.enter();
		expect(b.owner.inputMode()).toBe("dev");
		const native = b.owner.nativeSession();
		if (!native) throw new Error("Restored native session is missing");
		expect(b.bound()).toBe(native);
		expect((await b.state()).run.runId).toBe(JSON.parse(saved).run.runId);
		expect(b.calls).not.toContain("model:requirements");
	});
	test("failed restored host binding stops native work before another owner restores the untouched run", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.new("request");
		await a.owner.exit();
		const saved = await fs.readFile(path.join(a.root, ".omp/dev/state.json"), "utf8");
		const b = await fixture(a.root);
		const original = b.host.bindMainSession!;
		const bind = spyOn(b.host, "bindMainSession").mockImplementation(async target => {
			await original(target);
			if (target !== b.ordinary) throw new Error("binding failed");
		});
		try {
			await expect(b.owner.enter()).rejects.toThrow("binding failed");
		} finally {
			bind.mockRestore();
		}
		expect(b.owner.inputMode()).toBe("chat");
		expect(b.bound()).toBe(b.ordinary);
		expect(b.owner.nativeSession()).toBeUndefined();
		expect(b.owner.observation().released).toBe(true);
		expect(b.ordinary.messages).toBe(b.ordinaryHistory);
		expect(b.calls.indexOf("stop")).toBeLessThan(b.calls.indexOf("dispose"));
		expect(b.calls).not.toContain("model:requirements");
		expect(await fs.readFile(path.join(a.root, ".omp/dev/state.json"), "utf8")).toBe(saved);
		const c = await fixture(a.root);
		await c.owner.enter();
		expect((await c.state()).run.runId).toBe(JSON.parse(saved).run.runId);
		expect(c.calls).not.toContain("model:requirements");
	});
	test("failed enter cleanup retains a retryable owner while ordinary chat stays bound", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.new("request");
		await a.owner.exit();
		const saved = await a.state();
		const b = await fixture(a.root);
		b.failPrepare(true);
		b.failStop(true);
		await expect(b.owner.enter()).rejects.toThrow("stop failed");
		expect(b.owner.inputMode()).toBe("chat");
		expect(b.bound()).toBe(b.ordinary);
		expect(b.owner.observation().released).toBe(false);
		expect(b.calls).not.toContain("dispose");
		await expect(b.owner.enter()).rejects.toThrow("stop failed");
		await expect(b.owner.submitText("not a Dev prompt")).rejects.toThrow("停止");
		const c = await fixture(a.root);
		await expect(c.owner.enter()).rejects.toThrow("占用");
		expect(await b.state()).toEqual(saved);
		b.failStop(false);
		b.failPrepare(false);
		await b.owner.enter();
		expect(b.owner.inputMode()).toBe("dev");
		expect((await b.state()).run.runId).toBe(saved.run.runId);
		expect(b.calls).not.toContain("model:requirements");
		await b.owner.exit();
		await c.owner.enter();
		expect((await c.state()).run.runId).toBe(saved.run.runId);
		expect(c.calls).not.toContain("model:requirements");
	});
	test("saved-run read errors preserve valid state and release the uninitialized owner", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.new("request");
		await a.owner.exit();
		const saved = await a.state();
		const b = await fixture(a.root);
		const read = spyOn(DevWorkspace.prototype, "read").mockRejectedValue(new Error("read denied"));
		try {
			await expect(b.owner.enter()).rejects.toThrow("read denied");
		} finally {
			read.mockRestore();
		}
		expect(b.owner.inputMode()).toBe("chat");
		expect(b.bound()).toBe(b.ordinary);
		expect(b.owner.observation().released).toBe(true);
		expect(await b.state()).toEqual(saved);
		await b.owner.enter();
		expect((await b.state()).run.runId).toBe(saved.run.runId);
	});
	test("missing native history is not corrupt state and a later owner can retry its references", async () => {
		const a = await fixture();
		await a.owner.enter();
		await a.owner.setTeam(true);
		await a.owner.new("request");
		await a.owner.exit();
		const saved = await a.state();
		const b = await fixture(a.root);
		b.prepareError(Object.assign(new Error("native history missing"), { code: "ENOENT" }));
		await expect(b.owner.enter()).rejects.toThrow("native history missing");
		expect(b.owner.inputMode()).toBe("chat");
		expect(b.owner.observation().released).toBe(true);
		expect(await b.state()).toEqual(saved);
		const c = await fixture(a.root);
		await c.owner.enter();
		expect((await c.state()).run.sessions).toEqual(saved.run.sessions);
		expect(c.owner.status().useTeam).toBe(true);
		expect(c.calls).not.toContain("model:requirements");
	});
	test("first idle binding failure leaves ordinary input intact and permits entry retry", async () => {
		const f = await fixture();
		const original = f.host.bindMainSession!;
		let failed = false;
		const bind = spyOn(f.host, "bindMainSession").mockImplementation(async target => {
			await original(target);
			if (!failed) {
				failed = true;
				throw new Error("binding failed");
			}
		});
		try {
			await expect(f.owner.enter()).rejects.toThrow("binding failed");
		} finally {
			bind.mockRestore();
		}
		expect(f.owner.inputMode()).toBe("chat");
		expect(f.bound()).toBe(f.ordinary);
		expect(f.ordinary.messages).toBe(f.ordinaryHistory);
		expect(f.owner.observation().released).toBe(true);
		await f.owner.enter();
		expect(f.owner.inputMode()).toBe("dev");
	});
	test("clears only corrupt Dev state, leaving artifacts and unrelated settings intact", async () => {
		const f = await fixture();
		const dir = path.join(f.root, ".omp/dev");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "state.json"), '{"version":999,"team":true}');
		await fs.writeFile(path.join(dir, "keep.txt"), "artifact");
		await f.owner.enter();
		expect(f.owner.status().useTeam).toBe(false);
		expect(await fs.readFile(path.join(dir, "keep.txt"), "utf8")).toBe("artifact");
		await expect(fs.stat(path.join(dir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(f.owner.observation().notice).toContain("旧 Dev 状态无法恢复，已清除");
	});
	test.each(["current session", "prior approval", "retirement cleanup"])(
		"clears an unrecoverable run missing its %s and permits a new run",
		async missing => {
			const a = await fixture();
			await a.owner.enter();
			await a.owner.setTeam(true);
			await a.owner.new("request");
			await a.owner.next();
			await a.owner.next();
			await a.owner.next();
			await a.owner.exit();
			const saved = await a.state();
			if (missing === "current session") delete saved.run.sessions.executor;
			else if (missing === "prior approval") delete saved.run.approvals.planner;
			else saved.run.closing = { retirementCleanup: { diagnostic: "incomplete cleanup" } };
			const stateFile = path.join(a.root, ".omp/dev/state.json");
			await fs.writeFile(stateFile, JSON.stringify(saved));
			const preserved = [
				path.join(a.root, "proposal.md"),
				path.join(a.root, "executor.jsonl"),
				path.join(a.root, ".omp/settings.json"),
			];
			for (const file of preserved) await fs.writeFile(file, "preserve");
			const b = await fixture(a.root);
			await b.owner.enter();
			expect(b.owner.status().phase).toBe("idle");
			expect(b.owner.status().useTeam).toBe(false);
			expect(b.owner.nativeSession()).toBeUndefined();
			expect(b.calls.some(call => call.startsWith("prepare:") || call.startsWith("model:"))).toBe(false);
			await expect(fs.stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
			for (const file of preserved) expect(await fs.readFile(file, "utf8")).toBe("preserve");
			await b.owner.new("replacement request");
			expect(b.owner.status().phase).toBe("requirements");
			expect(b.owner.nativeSession()).toBeDefined();
			expect((await b.state()).run.runId).not.toBe(saved.run.runId);
		},
	);
	test("initialization and preparation failures retain configuration and remove only this run", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.setTeam(true);
		f.failInitialize(true);
		await expect(f.owner.new("request")).rejects.toThrow("initialize failed");
		expect(await f.state()).toEqual({ version: 1, team: true });
		f.failInitialize(false);
		f.failPrepare(true);
		await expect(f.owner.new("request")).rejects.toThrow("prepare failed");
		expect(await f.state()).toEqual({ version: 1, team: true });
	});
	test("failed atomic save does not advance the original phase or call its next model", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		const save = spyOn(DevWorkspace.prototype, "save").mockRejectedValue(new Error("disk full"));
		try {
			await expect(f.owner.next()).rejects.toThrow("disk full");
		} finally {
			save.mockRestore();
		}
		expect(f.owner.status().phase).toBe("requirements");
		expect(f.calls).not.toContain("model:solution");
		expect((await f.state()).run.phase).toBe("requirements");
	});
	test("failed stage binding preserves the saved phase and original approval", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		const saved = await f.state();
		const original = f.host.bindMainSession!;
		const bind = spyOn(f.host, "bindMainSession").mockImplementation(async target => {
			if (target === f.stages.get("solution")) throw new Error("binding failed");
			await original(target);
		});
		try {
			await expect(f.owner.next()).rejects.toThrow("binding failed");
		} finally {
			bind.mockRestore();
		}
		expect(f.owner.status().phase).toBe("requirements");
		expect(f.bound()).toBe(f.stages.get("requirements")!);
		expect(await f.state()).toEqual(saved);
		expect(f.calls).not.toContain("model:solution");
	});
	test("recovery binding failure retains the original operation diagnostic", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		f.failPrepare(true);
		const bind = spyOn(f.host, "bindMainSession").mockRejectedValue(new Error("secondary binding failed"));
		try {
			const error = await f.owner.next().catch(error => error);
			expect(error.message).toContain("prepare failed");
			expect(error.message).toContain("secondary binding failed");
			expect(f.owner.observation().error).toBe(error.message);
		} finally {
			bind.mockRestore();
		}
	});
	test("a successful native continuation clears the previous conversation error", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		f.failModel(true);
		await expect(f.owner.submitText("retry this discussion")).rejects.toThrow("network failed");
		expect(f.owner.observation().error).toContain("network failed");
		f.failModel(false);
		await f.owner.submitText("continue this discussion");
		expect(f.owner.observation().error).toBeUndefined();
		expect(f.inputs.at(-1)?.feedback).toBe("continue this discussion");
	});
	test.each([false, true])("blocks native admission while plan approval saves (save fails: %s)", async failSave => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		await f.owner.next();
		await f.owner.next();
		const saved = await f.state();
		const text = "  保留原始输入 Ω\n";
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		const imageLinks = ["https://example.test/image.png"];
		const attachments = structuredClone({ images, imageLinks });
		const saving = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const releaseModel = Promise.withResolvers<void>();
		const original = DevWorkspace.prototype.save;
		const save = spyOn(DevWorkspace.prototype, "save").mockImplementation(async function (
			this: DevWorkspace,
			state: unknown,
		) {
			saving.resolve();
			await releaseSave.promise;
			if (failSave) throw new Error("disk full");
			return original.call(this, state);
		});
		f.gate(releaseModel.promise);
		const next = f.owner.next(undefined, "/dev next 保留计划批准原文").then(
			() => undefined,
			error => error,
		);
		try {
			await saving.promise;
			await expect(f.owner.checkConversationAllowed()).rejects.toThrow("控制操作");
			await expect(f.owner.submitText(text, images, imageLinks)).rejects.toThrow("控制操作");
			expect(f.calls).not.toContain("model:executor");
			expect(f.inputs).toHaveLength(3);
			expect(await f.state()).toEqual(saved);
			expect({ images, imageLinks }).toEqual(attachments);
			releaseSave.resolve();
			if (failSave) {
				expect(await next).toEqual(new Error("disk full"));
				expect(f.owner.status().phase).toBe("planning");
				expect(await f.state()).toEqual(saved);
				expect(f.calls).not.toContain("model:executor");
				f.gate();
				await f.owner.checkConversationAllowed();
				await f.owner.submitText(text, images, imageLinks);
				expect(f.inputs.at(-1)).toMatchObject({ role: "planner", entry: false, feedback: text, ...attachments });
			} else {
				await f.waitForModel();
				Object.assign(f.owner.nativeSession()!, { isBusyForSnapshot: true, hasAdmittedSubmission: true });
				expect((await f.state()).run.phase).toBe("executing");
				expect((await f.state()).run.approvals.planner.userReply).toBe("/dev next 保留计划批准原文");
				await f.owner.checkConversationAllowed();
				const followup = f.owner.submitText(text, images, imageLinks);
				releaseModel.resolve();
				await followup;
				expect(await next).toBeUndefined();
				expect(f.inputs.at(-1)).toMatchObject({ role: "executor", entry: false, feedback: text, ...attachments });
				Object.assign(f.owner.nativeSession()!, { isBusyForSnapshot: false, hasAdmittedSubmission: false });
			}
		} finally {
			releaseSave.resolve();
			releaseModel.resolve();
			save.mockRestore();
			await next;
		}
	});
	test("new save failure preserves Team configuration and never starts a model", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.setTeam(true);
		const original = DevWorkspace.prototype.save;
		let failed = false;
		const save = spyOn(DevWorkspace.prototype, "save").mockImplementation(async function (
			this: DevWorkspace,
			state: unknown,
		) {
			if (!failed) {
				failed = true;
				throw new Error("disk full");
			}
			return original.call(this, state);
		});
		try {
			await expect(f.owner.new("request")).rejects.toThrow("disk full");
		} finally {
			save.mockRestore();
		}
		expect(await f.state()).toEqual({ version: 1, team: true });
		expect(f.calls).not.toContain("model:requirements");
		expect(f.owner.status().phase).toBe("idle");
	});
	test("Team freezes at solution without touching its saved value", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		await f.owner.setTeam(true);
		await f.owner.next();
		expect(f.owner.observation().teamMutable).toBe(false);
		await expect(f.owner.setTeam(false)).rejects.toThrow("冻结");
		expect((await f.state()).team).toBe(true);
	});
	test("Team interrupt cannot release a drop's stop ownership while workspace read is pending", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.setTeam(true);
		await f.owner.new("request");
		const releaseTeam = Promise.withResolvers<void>();
		f.gate(releaseTeam.promise);
		const advancing = f.owner.next();
		void advancing.catch(() => {});
		await f.waitForModel();
		expect(f.owner.status().phase).toBe("solution");
		const native = f.owner.nativeSession()!;
		f.pendingTeam(native, async () => {
			releaseTeam.resolve();
			return true;
		});
		const reading = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const originalRead = DevWorkspace.prototype.read;
		const read = spyOn(DevWorkspace.prototype, "read").mockImplementation(async function (this: DevWorkspace) {
			reading.resolve();
			await releaseRead.promise;
			return originalRead.call(this);
		});
		const save = spyOn(DevWorkspace.prototype, "save");
		const dropping = f.owner.drop();
		void dropping.catch(() => {});
		try {
			await reading.promise;
			const interrupted = await f.owner.interrupt(native);
			releaseTeam.resolve();
			await advancing;
			const models = f.calls.filter(call => call.startsWith("model:"));
			await expect(f.owner.next()).rejects.toThrow("当前控制操作尚未结清");
			await expect(f.owner.back()).rejects.toThrow("当前控制操作尚未结清");
			await expect(f.owner.drop()).rejects.toThrow("停止操作尚未结清");
			await expect(f.owner.exit()).rejects.toThrow("停止操作尚未结清");
			expect(interrupted).toBe(false);
			expect(f.calls).not.toContain("interrupt-team");
			expect(f.calls.filter(call => call.startsWith("model:"))).toEqual(models);
			releaseRead.resolve();
			await dropping;
			expect(save).toHaveBeenCalledTimes(1);
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
			expect(f.calls.filter(call => call === "dispose")).toHaveLength(1);
			expect(await f.state()).toEqual({ version: 1, team: false });
			expect(f.owner.status().phase).toBe("idle");
			expect(f.owner.nativeSession()).toBeUndefined();
		} finally {
			releaseTeam.resolve();
			releaseRead.resolve();
			await Promise.allSettled([advancing, dropping]);
			read.mockRestore();
			save.mockRestore();
		}
	});
	test("failed stop retains workspace ownership and can be retried", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		f.failStop(true);
		await expect(f.owner.exit()).rejects.toThrow("stop failed");
		expect(f.owner.inputMode()).toBe("dev");
		const other = await fixture(f.root);
		await expect(other.owner.enter()).rejects.toThrow("占用");
		f.failStop(false);
		await f.owner.exit();
		await other.owner.enter();
	});
	test("rejects next/back conflicts instead of approving a successor and rejects queued native input", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		const gate = Promise.withResolvers<void>();
		f.gate(gate.promise);
		const next = f.owner.next();
		await expect(f.owner.next()).rejects.toThrow("控制操作");
		await expect(f.owner.back()).rejects.toThrow("控制操作");
		gate.resolve();
		await next;
		f.gate();
		Object.assign(f.owner.nativeSession()!, { queuedMessageCount: 1 });
		await expect(f.owner.next()).rejects.toThrow("原生会话");
		await expect(f.owner.back()).rejects.toThrow("原生会话");
		Object.assign(f.owner.nativeSession()!, { queuedMessageCount: 0 });
	});
	test("partial archive limits controls; successful completion stays idle with Team retained", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.setTeam(true);
		await f.owner.new("request");
		await f.owner.next();
		await f.owner.next();
		await f.owner.next();
		f.failClose(true);
		await expect(f.owner.next()).rejects.toThrow("archive failed");
		expect((await f.state()).run.closing.synced).toBe(true);
		expect(f.owner.actions().find(action => action.id === "back")?.available).toBe(false);
		f.failClose(false);
		await f.owner.next();
		expect(f.owner.status().phase).toBe("idle");
		expect(f.owner.status().useTeam).toBe(true);
		expect((await f.state()).run.archivedChangePath).toBe("archive/change");
	});
	test("drop after partial archive abandons tracking without claiming side effects were reverted", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		await f.owner.next();
		await f.owner.next();
		await f.owner.next();
		f.failClose(true);
		await expect(f.owner.next()).rejects.toThrow("archive failed");
		expect(f.owner.actions().find(action => action.id === "drop")?.label).toContain("不会撤销");
		await f.owner.drop();
		expect(await f.state()).toEqual({ version: 1, team: false });
		expect(f.owner.inputMode()).toBe("dev");
	});
	test("new rejects ordinary mode rather than implicitly acquiring ownership", async () => {
		const f = await fixture();
		await expect(f.owner.new("request")).rejects.toThrow("进入开发模式");
		expect(f.owner.observation().released).toBe(true);
	});
	test("a model failure after durable stage preparation retains its native run", async () => {
		const f = await fixture();
		await f.owner.enter();
		f.failModel(true);
		await expect(f.owner.new("request")).rejects.toThrow("network failed");
		expect(f.owner.status().phase).toBe("requirements");
		expect((await f.state()).run.sessions.requirements).toBeDefined();
		expect(f.owner.nativeSession()).toBeDefined();
		f.failModel(false);
		const saved = await f.state();
		await f.owner.exit();
		const restored = await fixture(f.root);
		await restored.owner.enter();
		expect(restored.owner.status().phase).toBe("requirements");
		expect(await restored.state()).toEqual(saved);
		expect(restored.owner.nativeSession()).toBeDefined();
		expect(restored.calls).not.toContain("model:requirements");
	});
	test("exit cancels and waits for a gated native operation before releasing its owner", async () => {
		const f = await fixture();
		await f.owner.enter();
		await f.owner.new("request");
		const gate = Promise.withResolvers<void>();
		f.gate(gate.promise);
		const next = f.owner.next().then(
			() => undefined,
			error => error,
		);
		await f.waitForModel();
		await f.owner.exit();
		expect(await next).toBeInstanceOf(Error);
		expect(f.owner.observation().released).toBe(true);
		expect(f.owner.inputMode()).toBe("chat");
	});
	test("enter rejects active ordinary admission before taking the workspace lock", async () => {
		const f = await fixture();
		Object.assign(f.ordinary, { hasAdmittedSubmission: true });
		await expect(f.owner.enter()).rejects.toThrow("普通会话");
		Object.assign(f.ordinary, { hasAdmittedSubmission: false });
		await f.owner.enter();
	});
	test("idle enter and exit bind root using the destination mode before releasing ownership", async () => {
		const f = await fixture();
		const modes: string[] = [];
		const bind = spyOn(f.host, "bindMainSession").mockImplementation(async target => {
			expect(target).toBe(f.ordinary);
			modes.push(f.owner.inputMode());
			expect(f.owner.observation().released).toBe(false);
		});
		try {
			await f.owner.enter();
			await f.owner.exit();
		} finally {
			bind.mockRestore();
		}
		expect(modes).toEqual(["dev", "chat"]);
		expect(f.owner.observation().released).toBe(true);
	});
	test("failed exit binding restores Dev mode and keeps the lease for retry", async () => {
		const f = await fixture();
		await f.owner.enter();
		const bind = spyOn(f.host, "bindMainSession").mockRejectedValue(new Error("binding failed"));
		try {
			await expect(f.owner.exit()).rejects.toThrow("binding failed");
		} finally {
			bind.mockRestore();
		}
		expect(f.owner.inputMode()).toBe("dev");
		expect(f.owner.observation().released).toBe(false);
		await f.owner.exit();
		expect(f.owner.inputMode()).toBe("chat");
		expect(f.owner.observation().released).toBe(true);
	});
});
