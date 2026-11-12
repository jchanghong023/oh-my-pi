import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { cancelSpecDescendantJobs } from "../../src/spec-driven/actors";
import { assertAIReqFrozenAuthority, type AIReqFrozenAuthority } from "../../src/aireq-workbench/workflow-runtime";
import { sha256 } from "../../src/aireq-workbench/requirement-package";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function frozen() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-freeze-"));
	directories.push(cwd);
	const prefix = "docs/aireq/requirements/ir-one";
	const files = [
		{ path: `${prefix}/ir.md`, content: "# Original IR\n\nComplete original business authority.\n" },
		{ path: `${prefix}/srs/sr-one.md`, content: "# Original SR\n\n## Acceptance\n\nExact original acceptance.\n" },
		{ path: `${prefix}/attachments/business.bin`, content: new Uint8Array([0, 128, 255, 13, 10]) },
	].map(file => ({ ...file, digest: sha256(file.content) }));
	for (const file of files) {
		await fs.mkdir(path.dirname(path.join(cwd, file.path)), { recursive: true });
		await fs.writeFile(path.join(cwd, file.path), file.content);
	}
	const authority: AIReqFrozenAuthority = { digest: sha256("fixed whole IR/SR snapshot"), files, roots: [prefix] };
	return { cwd, prefix, authority };
}

test("whole frozen authority preserves binary attachments and permits technical changes outside its roots", async () => {
	const { cwd, authority } = await frozen();
	await assertAIReqFrozenAuthority(cwd, authority);
	await fs.writeFile(path.join(cwd, "implementation.ts"), "export const implemented = true;\n");
	await assertAIReqFrozenAuthority(cwd, authority);
});

test("same original digests do not authorize a newly added nested SR member", async () => {
	const { cwd, prefix, authority } = await frozen();
	await fs.mkdir(path.join(cwd, prefix, "srs", "nested"), { recursive: true });
	await fs.writeFile(path.join(cwd, prefix, "srs", "nested", "unapproved.md"), "# Unapproved split\n");
	await expect(assertAIReqFrozenAuthority(cwd, authority)).rejects.toThrow("Unexpected frozen requirement member");
	expect(await fs.readFile(path.join(cwd, prefix, "srs", "nested", "unapproved.md"), "utf8")).toContain("Unapproved");
});

test("changed titles or deleted SRs are rejected without repairing or deleting the actual files", async () => {
	const { cwd, authority } = await frozen();
	const ir = authority.files[0]!;
	await fs.writeFile(path.join(cwd, ir.path), "# Unauthorized title\n");
	await expect(assertAIReqFrozenAuthority(cwd, authority)).rejects.toThrow("Frozen requirement changed");
	expect(await fs.readFile(path.join(cwd, ir.path), "utf8")).toBe("# Unauthorized title\n");
	await fs.writeFile(path.join(cwd, ir.path), ir.content);
	await fs.rm(path.join(cwd, authority.files[1]!.path));
	await expect(assertAIReqFrozenAuthority(cwd, authority)).rejects.toThrow("missing from whole-set authority");
});

test("hard links cannot alias an otherwise byte-identical frozen authority", async () => {
	const { cwd, authority } = await frozen();
	const ir = authority.files[0]!;
	await fs.link(path.join(cwd, ir.path), path.join(cwd, "alias.md"));
	await expect(assertAIReqFrozenAuthority(cwd, authority)).rejects.toThrow("Hard-linked material");
});

test("frozen snapshot must include every declared root member and every supplied file must be covered", async () => {
	const { cwd, authority } = await frozen();
	const outside = { path: "outside.md", content: "not covered", digest: sha256("not covered") };
	await fs.writeFile(path.join(cwd, outside.path), outside.content);
	await expect(assertAIReqFrozenAuthority(cwd, { ...authority, files: [...authority.files, outside] })).rejects.toThrow(
		"missing from whole-set authority",
	);
});

test("recursive stop waits actual cleanup after cancellation and discovers late descendants beyond three passes", async () => {
	const jobs = new AsyncJobManager({});
	const registry = new AgentRegistry();
	registry.register({ id: "aireq-native-root", displayName: "root", kind: "sub", session: null });
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const unrelated = Promise.withResolvers<void>();
	const unrelatedId = jobs.register(
		"bash",
		"unrelated",
		async () => {
			await unrelated.promise;
			return "retained";
		},
		{ ownerId: "another-project" },
	);
	const descendant = jobs.register(
		"task",
		"native child",
		async ({ signal }) => {
			started.resolve();
			await new Promise<void>(resolve =>
				signal.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						resolve();
					},
					{ once: true },
				),
			);
			await cleanup.promise;
			let parent = "aireq-native-root";
			for (let depth = 0; depth < 12; depth++) {
				const child = `late-native-${depth}`;
				jobs.publishCompleted(
					"task",
					"retained native lineage",
					{ text: "settled parent" },
					{ ownerId: parent, agentId: child },
				);
				parent = child;
			}
			jobs.register(
				"bash",
				"late deep cleanup",
				async ({ signal: lateSignal }) => {
					if (!lateSignal.aborted)
						await new Promise<void>(resolve =>
							lateSignal.addEventListener("abort", () => resolve(), { once: true }),
						);
					return "late child settled";
				},
				{ ownerId: parent },
			);
			return "parent cleanup complete";
		},
		{ ownerId: "aireq-native-root", agentId: "first-child" },
	);
	let returned = false;
	let cancelling: Promise<boolean> | undefined;
	try {
		await started.promise;
		cancelling = cancelSpecDescendantJobs(jobs, "aireq-native-root", registry).then(value => {
			returned = true;
			return value;
		});
		await aborted.promise;
		await Promise.resolve();
		expect(returned).toBe(false);
		expect(jobs.getJob(descendant)?.endTime).toBeUndefined();
		cleanup.resolve();
		expect(await cancelling).toBe(true);
		expect(jobs.getUnsettledJobs().filter(job => job.ownerId !== "another-project")).toHaveLength(0);
		expect(jobs.getJob(unrelatedId)?.status).toBe("running");
	} finally {
		cleanup.resolve();
		unrelated.resolve();
		await cancelling;
		await jobs.dispose({ timeoutMs: 1000 });
	}
});
