import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DevWorkspace } from "../../src/spec-driven/workspace";

const io = fs.promises;
const roots: string[] = [];
const owners: DevWorkspace[] = [];

afterEach(async () => {
	for (const owner of owners.splice(0)) owner.release();
	for (const root of roots.splice(0)) await io.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await io.mkdtemp(path.join(os.tmpdir(), "omp-dev-workspace-"));
	roots.push(root);
	return root;
}

async function acquire(cwd: string): Promise<DevWorkspace> {
	const owner = await DevWorkspace.acquire(cwd);
	owners.push(owner);
	return owner;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const child = Bun.spawn(["git", "-c", "user.name=Dev Test", "-c", "user.email=dev@example.invalid", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
}

async function repository(): Promise<string> {
	const root = await fixture();
	await git(root, "init", "--initial-branch=main");
	await git(root, "commit", "--allow-empty", "-m", "fixture");
	return root;
}

const workspaceModule = new URL("../../src/spec-driven/workspace.ts", import.meta.url).href;
function childScript(cwd: string): string {
	return `import { DevWorkspace } from ${JSON.stringify(workspaceModule)};
const owner = await DevWorkspace.acquire(${JSON.stringify(cwd)});
console.log("owned");
await new Response(Bun.stdin.stream()).text();
owner.release();`;
}

describe("Dev workspace identity and ownership", () => {
	test("uses one Git worktree identity across subdirectories, aliases and branches", async () => {
		const root = await repository();
		const nested = path.join(root, "src", "nested");
		await io.mkdir(nested, { recursive: true });
		const aliasParent = await fixture();
		const alias = path.join(aliasParent, "alias");
		await io.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		const owner = await acquire(nested);
		expect(owner.root).toBe(await io.realpath(root));
		expect(owner.statePath).toBe(path.join(owner.root, ".omp", "dev", "state.json"));
		await owner.save({ team: true });
		await expect(DevWorkspace.acquire(root)).rejects.toThrow("已被占用");
		await expect(DevWorkspace.acquire(path.join(alias, "src", "nested"))).rejects.toThrow("已被占用");
		await git(root, "switch", "-c", "other-branch");
		owner.release();
		const successor = await acquire(alias);
		expect(successor.root).toBe(owner.root);
		expect(await successor.read()).toEqual({ team: true });
	});

	test("isolates existing linked worktrees, including ownership and clearing", async () => {
		const root = await repository();
		const parent = await fixture();
		const linked = path.join(parent, "linked");
		await git(root, "worktree", "add", "-b", "linked-branch", linked);
		const primary = await acquire(root);
		const secondary = await acquire(linked);
		expect(secondary.root).toBe(await io.realpath(linked));
		expect(secondary.statePath).not.toBe(primary.statePath);
		await primary.save({ team: true });
		await secondary.save({ team: false });
		await primary.clear();
		expect(await primary.read()).toBeUndefined();
		expect(await secondary.read()).toEqual({ team: false });
		await expect(DevWorkspace.acquire(linked)).rejects.toThrow("已被占用");
	});

	test("non-Git directories keep the entered scope and canonicalize aliases", async () => {
		const root = await fixture();
		const nested = path.join(root, "nested");
		await io.mkdir(nested);
		const parent = await fixture();
		const alias = path.join(parent, "alias");
		await io.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		const owner = await acquire(root);
		const nestedOwner = await acquire(nested);
		expect(nestedOwner.root).toBe(await io.realpath(nested));
		await expect(DevWorkspace.acquire(alias)).rejects.toThrow("已被占用");
		expect(await owner.read()).toBeUndefined();
	});

	test("holds its lease through all I/O until explicit release, rejecting stale access", async () => {
		const root = await fixture();
		const owner = await acquire(root);
		await owner.save({ team: true });
		expect(await owner.read()).toEqual({ team: true });
		await owner.clear();
		await expect(DevWorkspace.acquire(root)).rejects.toThrow("已被占用");
		owner.release();
		const successor = await acquire(root);
		owner.release();
		await expect(DevWorkspace.acquire(root)).rejects.toThrow("已被占用");
		await expect(owner.read()).rejects.toThrow("已释放");
		await expect(owner.save({ team: false })).rejects.toThrow("已释放");
		await expect(owner.clear()).rejects.toThrow("已释放");
		await successor.save({ team: true });
		expect(await successor.read()).toEqual({ team: true });
	});

	test("excludes another process and hands ownership over after explicit release", async () => {
		const root = await fixture();
		const owner = await acquire(root);
		const contender = Bun.spawn([process.execPath, "--eval", childScript(root)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([contender.exited, new Response(contender.stderr).text()]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("已被占用");
		owner.release();
		const holder = Bun.spawn([process.execPath, "--eval", childScript(root)], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = holder.stdout.getReader();
			const ready = await reader.read();
			expect(new TextDecoder().decode(ready.value)).toContain("owned");
			reader.releaseLock();
			await expect(DevWorkspace.acquire(root)).rejects.toThrow("已被占用");
			holder.stdin.end();
			expect(await holder.exited).toBe(0);
			const successor = await acquire(root);
			expect(await successor.read()).toBeUndefined();
		} finally {
			if (holder.exitCode === null) {
				holder.kill();
				await holder.exited;
			}
		}
	}, 15_000);
});

describe("Dev state persistence", () => {
	test("missing state stays undefined and configuration-only JSON survives reopening", async () => {
		const root = await fixture();
		const owner = await acquire(root);
		expect(await owner.read()).toBeUndefined();
		await expect(io.stat(owner.statePath)).rejects.toMatchObject({ code: "ENOENT" });
		await owner.save({ team: true });
		owner.release();
		const successor = await acquire(root);
		expect(await successor.read()).toEqual({ team: true });
	});

	test("malformed JSON is identifiable and cleanup removes only the Dev state file", async () => {
		const root = await fixture();
		const owner = await acquire(root);
		const preserved = [
			"source.ts",
			".omp/settings.json",
			".omp/dev/other.json",
			".omp/sessions/native.jsonl",
			"openspec/changes/example/proposal.md",
			"docs/superpowers/plans/example-completion.md",
		];
		for (const file of preserved) {
			await io.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await io.writeFile(path.join(root, file), `preserve ${file}`);
		}
		await io.writeFile(owner.statePath, "{broken");
		await expect(owner.read()).rejects.toBeInstanceOf(SyntaxError);
		expect(await io.readFile(owner.statePath, "utf8")).toBe("{broken");
		await owner.clear();
		await owner.clear();
		expect(await owner.read()).toBeUndefined();
		for (const file of preserved) expect(await io.readFile(path.join(root, file), "utf8")).toBe(`preserve ${file}`);
	});

	test("propagates read and cleanup I/O failures without clearing valid state", async () => {
		const owner = await acquire(await fixture());
		await owner.save({ team: true });
		const before = await io.readFile(owner.statePath, "utf8");
		const backup = `${owner.statePath}.backup`;
		await io.rename(owner.statePath, backup);
		try {
			// A directory at the file path causes real read/unlink failures on Windows and Linux.
			await io.mkdir(owner.statePath);
			const readError = await owner.read().catch((error: unknown) => error);
			expect(readError).toBeInstanceOf(Error);
			expect(readError).not.toBeInstanceOf(SyntaxError);
			expect(readError).toMatchObject({ code: expect.any(String) });
			await expect(owner.clear()).rejects.toMatchObject({ code: expect.any(String) });
			expect((await io.stat(owner.statePath)).isDirectory()).toBe(true);
			expect(await io.readFile(backup, "utf8")).toBe(before);
		} finally {
			await io.rm(owner.statePath, { recursive: true, force: true });
			await io.rename(backup, owner.statePath);
		}
		expect(await io.readFile(owner.statePath, "utf8")).toBe(before);
		expect(await owner.read()).toEqual({ team: true });
	});

	test("failed atomic publication preserves old bytes and removes the staging file", async () => {
		const owner = await acquire(await fixture());
		await owner.save({ team: true });
		const before = await io.readFile(owner.statePath, "utf8");
		const failure = Object.assign(new Error("publish failed"), { code: "EIO" });
		const rename = io.rename.bind(io);
		const spy = spyOn(io, "rename").mockImplementation((source, target) =>
			target === owner.statePath ? Promise.reject(failure) : rename(source, target),
		);
		try {
			await expect(owner.save({ team: false })).rejects.toBe(failure);
		} finally {
			spy.mockRestore();
		}
		expect(await io.readFile(owner.statePath, "utf8")).toBe(before);
		expect((await io.readdir(path.dirname(owner.statePath))).filter(file => file.endsWith(".tmp"))).toEqual([]);
		expect(await owner.read()).toEqual({ team: true });
		await owner.save({ team: false });
		expect(await owner.read()).toEqual({ team: false });
	});

	test("readers see the previous complete state until atomic publication", async () => {
		const owner = await acquire(await fixture());
		await owner.save({ team: true });
		const staged = Promise.withResolvers<void>();
		const publish = Promise.withResolvers<void>();
		const rename = io.rename.bind(io);
		const spy = spyOn(io, "rename").mockImplementation(async (source, target) => {
			if (target === owner.statePath) {
				staged.resolve();
				await publish.promise;
			}
			await rename(source, target);
		});
		const saving = owner.save({ team: false, run: { phase: "requirements" } });
		try {
			await Promise.race([
				staged.promise,
				saving.then(() => {
					throw new Error("publication was not staged");
				}),
			]);
			expect(await owner.read()).toEqual({ team: true });
		} finally {
			publish.resolve();
			try {
				await saving;
			} finally {
				spy.mockRestore();
			}
		}
		expect(await owner.read()).toEqual({ team: false, run: { phase: "requirements" } });
	});

	test("serialization failure cannot replace the last valid state", async () => {
		const owner = await acquire(await fixture());
		await owner.save({ team: true });
		await expect(owner.save(undefined)).rejects.toBeInstanceOf(TypeError);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		await expect(owner.save(cyclic)).rejects.toBeInstanceOf(TypeError);
		expect(await owner.read()).toEqual({ team: true });
	});
});
