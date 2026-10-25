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
