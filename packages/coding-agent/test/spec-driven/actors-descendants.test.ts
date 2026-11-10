import { expect, test } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { cancelSpecDescendantJobs } from "../../src/spec-driven/actors";

test("cancels idle grandchild jobs owned by descendant agents without touching unrelated owners", async () => {
	const registry = new AgentRegistry();
	registry.register({ id: "spec-actor", displayName: "spec-actor", kind: "sub", session: null });
	registry.register({ id: "child-agent", displayName: "child", kind: "sub", parentId: "spec-actor", session: null });
	registry.register({
		id: "grandchild-agent",
		displayName: "grandchild",
		kind: "sub",
		parentId: "child-agent",
		session: null,
	});
	const jobs = new AsyncJobManager({});
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const grandchildId = jobs.register(
		"task",
		"grandchild background work",
		async ({ signal }) => {
			started.resolve();
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			stopped.resolve();
			return "stopped";
		},
		{ ownerId: "grandchild-agent" },
	);
	const unrelatedRelease = Promise.withResolvers<void>();
	const unrelatedId = jobs.register(
		"task",
		"unrelated owner work",
		async () => {
			await unrelatedRelease.promise;
			return "unrelated";
		},
		{ ownerId: "unrelated-owner" },
	);
	try {
		await started.promise;
		expect(jobs.getJob(grandchildId)?.status).toBe("running");
		expect(await cancelSpecDescendantJobs(jobs, "spec-actor", registry)).toBe(true);
		expect(jobs.getJob(grandchildId)?.status).toBe("cancelled");
		await stopped.promise;
		expect(jobs.getJob(unrelatedId)?.status).toBe("running");
	} finally {
		unrelatedRelease.resolve();
		await jobs.waitForOwnerJobs("unrelated-owner").catch(() => {});
		await jobs.dispose({ timeoutMs: 1_000 });
	}
});

test("arbitrary-depth descendants retain their real settlement barrier after cancellation acknowledgement", async () => {
	const registry = new AgentRegistry();
	let parentId: string | undefined;
	for (let depth = 0; depth < 24; depth++) {
		const id = `native-depth-${depth}`;
		registry.register({ id, displayName: id, kind: "sub", parentId, session: null });
		parentId = id;
	}
	const jobs = new AsyncJobManager({});
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const id = jobs.register(
		"bash",
		"deep owned work",
		async ({ signal }) => {
			entered.resolve();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await release.promise;
			return "actual cleanup settled";
		},
		{ ownerId: parentId! },
	);
	let returned = false;
	let cancelling: Promise<boolean> | undefined;
	try {
		await entered.promise;
		cancelling = cancelSpecDescendantJobs(jobs, "native-depth-0", registry).then(value => {
			returned = true;
			return value;
		});
		await aborted.promise;
		await Promise.resolve();
		expect(jobs.getJob(id)?.status).toBe("cancelled");
		expect(jobs.getJob(id)?.endTime).toBeUndefined();
		expect(returned).toBe(false);
		release.resolve();
		expect(await cancelling).toBe(true);
		expect(jobs.getJob(id)?.endTime).toBeDefined();
	} finally {
		release.resolve();
		await cancelling;
		await jobs.dispose({ timeoutMs: 1_000 });
	}
});

test("settlement discovers descendants and owned jobs registered during abort cleanup", async () => {
	const registry = new AgentRegistry();
	registry.register({ id: "native-root", displayName: "root", kind: "sub", session: null });
	const jobs = new AsyncJobManager({});
	const started = Promise.withResolvers<void>();
	const lateStarted = Promise.withResolvers<void>();
	const lateAborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let lateId: string | undefined;
	jobs.register(
		"task",
		"initial owned work",
		async ({ signal }) => {
			started.resolve();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			registry.register({
				id: "late-child",
				displayName: "late child",
				kind: "sub",
				parentId: "native-root",
				session: null,
			});
			lateId = jobs.register(
				"task",
				"late descendant cleanup",
				async ({ signal: childSignal }) => {
					childSignal.addEventListener("abort", () => lateAborted.resolve(), { once: true });
					lateStarted.resolve();
					await release.promise;
					return "late cleanup actually settled";
				},
				{ ownerId: "late-child" },
			);
			return "initial cleanup finished";
		},
		{ ownerId: "native-root" },
	);
	await started.promise;
	let returned = false;
	const cancelling = cancelSpecDescendantJobs(jobs, "native-root", registry).then(value => {
		returned = true;
		return value;
	});
	try {
		await lateStarted.promise;
		await lateAborted.promise;
		expect(jobs.getJob(lateId!)?.status).toBe("cancelled");
		expect(jobs.getJob(lateId!)?.endTime).toBeUndefined();
		expect(returned).toBe(false);
	} finally {
		release.resolve();
	}
	expect(await cancelling).toBe(true);
	expect(jobs.getJob(lateId!)?.endTime).toBeDefined();
	await jobs.dispose({ timeoutMs: 1_000 });
});
