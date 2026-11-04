import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../../../src/config/settings";
import { RepoHubComponent } from "../../../src/modes/components/repo-hub";
import { RepoService } from "../../../src/repo/service";

function text(component: { render(width: number): string[] }): string {
	return component
		.render(140)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

async function until(predicate: () => boolean, deadlineMs = 20_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > deadlineMs) throw new Error("timeout waiting for repo panel state");
		await Bun.sleep(25);
	}
}

describe("RepoHubComponent /repo panel contract (openspec/specs/repo-index/spec.md)", () => {
	it("guards operations behind index state and y/N confirmations, then deletes and closes", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-profile-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-project-"));
		await fs.writeFile(path.join(projectDir, "engine.py"), "def find_engine(): return 1\n", "utf8");
		const tui = { requestRender: () => {} } as unknown as TUI;
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir: profileDir, inMemory: true });
		const onCancel = vi.fn();
		let hub: RepoHubComponent | undefined;
		try {
			hub = await RepoHubComponent.create(tui, projectDir, settings, { onCancel });
			await until(() => text(hub!).includes("No repository index. Press b to build."));

			// u and d are no-ops without an index; Esc closes the idle panel.
			hub.handleInput("u");
			hub.handleInput("d");
			expect(text(hub)).not.toContain("y/N");
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);

			// b asks for confirmation; n declines without building.
			hub.handleInput("b");
			expect(text(hub)).toContain("Build repository index for");
			hub.handleInput("n");
			expect(text(hub)).not.toContain("y/N");

			// b + y builds the index; the panel reflects files and Python symbols.
			hub.handleInput("b");
			hub.handleInput("y");
			await until(() => text(hub!).includes("Files: "));
			expect(text(hub!)).toContain("Files: 1  Symbols: 2");
			const built = new RepoService({ cwd: projectDir, agentDir: profileDir });
			try {
				expect((await built.symbol("find_engine")).hits).toMatchObject([
					{ path: "engine.py", name: "find_engine", kind: "function", signature: "def find_engine():" },
				]);
			} finally {
				built.close();
			}

			// d + y removes the index again.
			hub.handleInput("d");
			expect(text(hub!)).toContain("Delete repository index for");
			hub.handleInput("y");
			await until(() => text(hub!).includes("No repository index. Press b to build."));
			expect(await fs.readFile(path.join(projectDir, "engine.py"), "utf8")).toBe("def find_engine(): return 1\n");
		} finally {
			hub?.dispose();
			await Promise.all([removeWithRetries(profileDir), removeWithRetries(projectDir)]);
		}
	});

	it("r + y rebuilds an existing index and includes externally added sources through the confirmation flow", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-rebuild-profile-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-rebuild-project-"));
		await fs.writeFile(path.join(projectDir, "engine.py"), "def find_engine(): return 2\n", "utf8");
		const tui = { requestRender: () => {} } as unknown as TUI;
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir: profileDir, inMemory: true });
		let hub: RepoHubComponent | undefined;
		try {
			hub = await RepoHubComponent.create(tui, projectDir, settings, { onCancel: vi.fn() });
			hub.handleInput("b");
			hub.handleInput("y");
			await until(() => text(hub!).includes("Files: "));
			await fs.writeFile(path.join(projectDir, "additional.py"), "def additional_engine(): return 3\n", "utf8");

			hub.handleInput("r");
			expect(text(hub!)).toContain("Rebuild repository index for");
			hub.handleInput("y");
			await until(() => text(hub!).includes("Files: 2"));
			expect(text(hub!)).toContain("Files: 2  Symbols: 4");
			const rebuilt = new RepoService({ cwd: projectDir, agentDir: profileDir });
			try {
				expect((await rebuilt.symbol("additional_engine")).hits).toMatchObject([
					{ path: "additional.py", name: "additional_engine", signature: "def additional_engine():" },
				]);
				expect((await rebuilt.symbol("find_engine")).hits).toMatchObject([
					{ path: "engine.py", name: "find_engine" },
				]);
			} finally {
				rebuilt.close();
			}
		} finally {
			hub?.dispose();
			await Promise.all([removeWithRetries(profileDir), removeWithRetries(projectDir)]);
		}
	});

	// Input is delivered from a real read-progress boundary, before maintenance can publish.
	it.each(["c", "escape-close", "delete"] as const)(
		"routes %s during indexing without publishing or deleting source files",
		async route => {
			await initTheme();
			const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-active-profile-"));
			const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-hub-active-project-"));
			const sourcePath = path.join(projectDir, "engine.py");
			const originalSource = "def old_engine(): return 'oldriver'\n";
			const changedSource = "def new_engine(): return 'newdesert'\n";
			await fs.writeFile(sourcePath, originalSource, "utf8");
			const service = new RepoService({ cwd: projectDir, agentDir: profileDir });
			const onCancel = vi.fn();
			let hub: RepoHubComponent | undefined;
			let operation: Promise<unknown> | undefined;
			let routed = false;
			const reconcile = RepoService.prototype.reconcile;
			let restore: (() => void) | undefined;
			try {
				await service.build();
				const generation = (await service.status()).generation;
				const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir: profileDir, inMemory: true });
				hub = await RepoHubComponent.create({ requestRender: () => {} } as unknown as TUI, projectDir, settings, {
					onCancel,
				});
				await fs.writeFile(sourcePath, changedSource, "utf8");
				const intercept = vi.spyOn(RepoService.prototype, "reconcile").mockImplementation(function (
					this: RepoService,
					options = {},
				) {
					const pending = reconcile.call(this, {
						...options,
						onProgress(progress) {
							options.onProgress?.(progress);
							if (routed || progress.phase !== "reading") return;
							routed = true;
							expect(text(hub!)).toContain("Progress: reading");
							if (route === "c") {
								hub!.handleInput("c");
								expect(text(hub!)).not.toContain("y/N");
							} else if (route === "escape-close") {
								for (const decline of ["n", "\x1b"]) {
									hub!.handleInput("\x1b");
									expect(text(hub!)).toContain("Indexing active. Cancel and close? y/N");
									hub!.handleInput(decline);
									expect(text(hub!)).not.toContain("y/N");
									expect(options.signal?.aborted).toBe(false);
								}
								hub!.handleInput("\x1b");
								hub!.handleInput("y");
							} else {
								hub!.handleInput("d");
								expect(text(hub!)).toContain("Delete repository index for");
								hub!.handleInput("n");
								expect(options.signal?.aborted).toBe(false);
								hub!.handleInput("d");
								hub!.handleInput("y");
								expect(text(hub!)).toContain("Deleting repository index");
							}
							expect(options.signal?.aborted).toBe(true);
							// Closing must await rollback, not run synchronously at the input boundary.
							expect(onCancel).not.toHaveBeenCalled();
						},
					});
					operation = pending;
					return pending;
				});
				restore = () => intercept.mockRestore();
				hub.handleInput("u");
				expect(operation).toBeDefined();
				await expect(operation!).rejects.toMatchObject({ name: "AbortError" });
				expect(routed).toBe(true);
				if (route === "delete") {
					await until(() => text(hub!).includes("No repository index. Press b to build."));
					expect((await service.status()).exists).toBe(false);
					expect((await service.search("oldriver")).hits).toEqual([]);
					expect((await service.search("newdesert")).hits).toEqual([]);
				} else {
					if (route === "escape-close") await until(() => onCancel.mock.calls.length === 1);
					else await until(() => !text(hub!).includes("Progress:"));
					const status = await service.status();
					expect(status.generation).toBe(generation);
					expect(status.unchecked).toBe(true);
					expect((await service.symbol("old_engine")).hits).toMatchObject([{ name: "old_engine" }]);
					expect((await service.symbol("new_engine")).hits).toEqual([]);
				}
				expect(onCancel).toHaveBeenCalledTimes(route === "escape-close" ? 1 : 0);
				expect(await fs.readFile(sourcePath, "utf8")).toBe(changedSource);
			} finally {
				restore?.();
				await operation?.catch(() => {});
				if (hub)
					await until(
						() => !text(hub!).includes("Progress:") && !text(hub!).includes("Deleting repository index"),
					);
				hub?.dispose();
				service.close();
				await Promise.all([removeWithRetries(profileDir), removeWithRetries(projectDir)]);
			}
		},
	);
});
