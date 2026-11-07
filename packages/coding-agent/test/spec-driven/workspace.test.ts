import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DevWorkspace } from "../../src/spec-driven/workspace";

const roots: string[] = [];
const owners: DevWorkspace[] = [];
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.release();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workbench-workspace-"));
	roots.push(root);
	return root;
}
async function repository(): Promise<string> {
	const root = await directory();
	await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
	await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
	return root;
}
async function acquire(cwd: string): Promise<DevWorkspace> {
	const owner = await DevWorkspace.acquire(cwd);
	owners.push(owner);
	return owner;
}
function isConfiguration(value: unknown): { useTeam: boolean } {
	if (typeof value !== "object" || value === null || !("useTeam" in value) || typeof value.useTeam !== "boolean")
		throw new Error("Invalid team configuration");
	return { useTeam: value.useTeam };
}
const moduleUrl = new URL("../../src/spec-driven/workspace.ts", import.meta.url).href;
function childScript(root: string): string {
	return `import { DevWorkspace } from ${JSON.stringify(moduleUrl)};
const owner = await DevWorkspace.acquire(${JSON.stringify(root)});
console.log("owned");
await new Response(Bun.stdin.stream()).text();
owner.release();`;
}

describe("canonical workspace lease", () => {
	test("resolves nested directories and junctions to the same existing branch without taking a lease", async () => {
		const root = await repository();
		const nested = path.join(root, "src", "nested");
		await fs.mkdir(nested, { recursive: true });
		const parent = await directory();
		const alias = path.join(parent, "alias");
		await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		const identity = await DevWorkspace.resolve(nested);
		expect(identity).toEqual({ root: await fs.realpath(root), branch: "main" });
		expect(await DevWorkspace.resolve(alias)).toEqual(identity);
		const owner = await acquire(nested);
		expect(owner.root).toBe(identity.root);
		expect(owner.branch).toBe("main");
		expect(await DevWorkspace.resolve(alias)).toEqual(identity);
		await expect(DevWorkspace.acquire(alias)).rejects.toThrow();
		await expect(DevWorkspace.acquire(root)).rejects.toThrow();
	});

	test("does not conflate independent directories and never consumes legacy state", async () => {
		const root = await directory();
		const other = await directory();
		const legacy = path.join(root, ".omp", "dev", "state.json");
		await fs.mkdir(path.dirname(legacy), { recursive: true });
		await fs.writeFile(legacy, '{"run":{"phase":"executing"},"team":true}\n');
		const owner = await acquire(root);
		const independent = await acquire(other);
		expect(owner.root).not.toBe(independent.root);
		expect(owner.branch).toBeNull();
		expect(await owner.readLocal("team-config", isConfiguration)).toBeNull();
		expect(await fs.readFile(legacy, "utf8")).toBe('{"run":{"phase":"executing"},"team":true}\n');
	});

	test("holds its lease until release and rejects stale owners without disturbing a successor", async () => {
		const root = await directory();
		const owner = await acquire(root);
		await owner.saveLocal("team-config", { useTeam: true });
		expect(await owner.readLocal("team-config", isConfiguration)).toEqual({ useTeam: true });
		owner.release();
		const successor = await acquire(root);
		owner.release();
		await expect(DevWorkspace.acquire(root)).rejects.toThrow();
		await expect(owner.saveLocal("team-config", { useTeam: false })).rejects.toThrow();
		await expect(owner.readLocal("team-config", isConfiguration)).rejects.toThrow();
		expect(await successor.readLocal("team-config", isConfiguration)).toEqual({ useTeam: true });
	});

	test("excludes another process and transfers only after the real holder releases", async () => {
		const root = await directory();
		const owner = await acquire(root);
		const contender = Bun.spawn([process.execPath, "--eval", childScript(root)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, diagnostic] = await Promise.all([contender.exited, new Response(contender.stderr).text()]);
		expect(code).not.toBe(0);
		expect(diagnostic.length).toBeGreaterThan(0);
		owner.release();
		const holder = Bun.spawn([process.execPath, "--eval", childScript(root)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = holder.stdout.getReader();
			try {
				const ready = await reader.read();
				expect(new TextDecoder().decode(ready.value)).toContain("owned");
			} finally {
				reader.releaseLock();
			}
			await expect(DevWorkspace.acquire(root)).rejects.toThrow();
			holder.stdin.end();
			expect(await holder.exited).toBe(0);
			await acquire(root);
		} finally {
			if (holder.exitCode === null) {
				holder.kill();
				await holder.exited;
			}
		}
	}, 15_000);
});

describe("native references are local, not business records", () => {
	test("persists configuration independently of legacy files and releases cleanly", async () => {
		const root = await directory();
		const owner = await acquire(root);
		expect(owner.localDirectory).toBe(path.join(owner.root, ".omp", "dev-workbench"));
		expect(await owner.readLocal("team-config", isConfiguration)).toBeNull();
		await owner.saveLocal("team-config", { useTeam: true });
		owner.release();
		const reopened = await acquire(root);
		expect(await reopened.readLocal("team-config", isConfiguration)).toEqual({ useTeam: true });
		await expect(fs.stat(path.join(root, "docs", "dev-requirements"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("preserves malformed local data and rejects unsafe names", async () => {
		const owner = await acquire(await directory());
		await owner.saveLocal("team-config", { useTeam: true });
		const files = await fs.readdir(owner.localDirectory);
		const config = files.find(file => file.startsWith("team-config"));
		if (!config) throw new Error("Expected persisted team configuration");
		const target = path.join(owner.localDirectory, config);
		await fs.writeFile(target, "{broken");
		await expect(owner.readLocal("team-config", isConfiguration)).rejects.toThrow();
		expect(await fs.readFile(target, "utf8")).toBe("{broken");
		for (const name of ["../escape", "a/b", "a\\b"]) {
			await expect(owner.saveLocal(name, { useTeam: false })).rejects.toThrow();
			await expect(owner.readLocal(name, isConfiguration)).rejects.toThrow();
		}
	});

	test("serialization failure retains the last valid local configuration", async () => {
		const owner = await acquire(await directory());
		await owner.saveLocal("team-config", { useTeam: true });
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		await expect(owner.saveLocal("team-config", cyclic)).rejects.toBeInstanceOf(TypeError);
		expect(await owner.readLocal("team-config", isConfiguration)).toEqual({ useTeam: true });
	});
});
