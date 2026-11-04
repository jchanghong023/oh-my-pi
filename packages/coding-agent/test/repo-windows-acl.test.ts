import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob } from "@oh-my-pi/pi-natives";
import { RepoService } from "../src/repo/service";

// Windows ACL semantics are exercised on Windows only; POSIX has its existing
// real chmod/unprivileged-child coverage in natives/test/python-symbols.test.ts.
if (process.platform === "win32") {
	it("rejects unreadable Windows ACL subtrees without publishing a partial repository generation", async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-windows-acl-"));
		const root = path.join(temporary, "project");
		const blocked = path.join(root, "blocked-subtree");
		const visible = path.join(root, "visible.py");
		const hidden = path.join(blocked, "hidden.py");
		let service: RepoService | undefined;
		const runWindowsTool = async (name: string, args: string[]) => {
			if (!process.env.SystemRoot) throw new Error("Windows ACL fixture requires SystemRoot");
			const child = Bun.spawn([path.join(process.env.SystemRoot, "System32", name), ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0) throw new Error(`${name} failed (${code}): ${stdout}\n${stderr}`);
			return stdout;
		};
		try {
			await fs.mkdir(blocked, { recursive: true });
			await fs.writeFile(visible, "def published_river(): pass\n");
			await fs.writeFile(hidden, "def protected_forest(): pass\n");
			service = new RepoService({ cwd: root, agentDir: path.join(temporary, "profile") });
			await service.build();
			const before = await service.status();
			expect(before).toMatchObject({ fileCount: 2, unchecked: false, incomplete: false });
			await fs.writeFile(visible, "def unpublished_desert(): pass\n");
			const identity = await runWindowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
			const sid = identity.match(/S-1-(?:\d+-)+\d+/)?.[0];
			if (!sid) throw new Error("Could not determine current Windows user SID");
			try {
				// RD is FILE_LIST_DIRECTORY on a directory. No inheritance flags:
				// only this fixture directory is denied; its child source is untouched.
				await runWindowsTool("icacls.exe", [blocked, "/deny", `*${sid}:(RD)`]);
				await expect(fs.readdir(blocked)).rejects.toMatchObject({
					code: expect.stringMatching(/^(?:EACCES|EPERM)$/),
					path: blocked,
				});
				const ordinary = await glob({ pattern: "**/*.py", path: root, cache: false });
				expect(ordinary.matches.map(match => match.path)).toEqual(["visible.py"]);
				for (const mode of ["reconcile", "rebuild"] as const) {
					const failed = await service[mode]().then(
						() => {
							throw new Error(`${mode} must reject an unreadable directory`);
						},
						(error: unknown) => error,
					);
					expect(failed).toBeInstanceOf(Error);
					expect((failed as Error).message).toContain("blocked-subtree");
					expect((failed as Error).message).toContain("os error 5");
					expect(await service.status()).toMatchObject({
						generation: before.generation,
						fileCount: 2,
						unchecked: true,
						needsReconcile: true,
						lastFullCheck: before.lastFullCheck,
					});
					expect((await service.status()).uncertainReasons.join("\n")).toContain("blocked-subtree");
					expect((await service.symbol("published_river")).hits).toMatchObject([{ path: "visible.py" }]);
					expect((await service.symbol("protected_forest")).hits).toMatchObject([
						{ path: "blocked-subtree/hidden.py" },
					]);
					expect((await service.symbol("unpublished_desert")).hits).toEqual([]);
				}
			} finally {
				// Also restore when deny/application/assertions fail; never leave an ACL
				// behind that prevents deleting the exclusively owned temporary tree.
				await runWindowsTool("icacls.exe", [blocked, "/remove:d", `*${sid}`]);
			}
			expect(await fs.readFile(hidden, "utf8")).toBe("def protected_forest(): pass\n");
			expect(await fs.readFile(visible, "utf8")).toBe("def unpublished_desert(): pass\n");
			await service.reconcile();
			expect((await service.status()).unchecked).toBe(false);
			expect((await service.symbol("unpublished_desert")).hits).toMatchObject([{ path: "visible.py" }]);
			expect((await service.symbol("published_river")).hits).toEqual([]);
		} finally {
			service?.close();
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
}
