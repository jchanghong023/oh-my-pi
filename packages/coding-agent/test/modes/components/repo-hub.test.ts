import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../../../src/config/settings";
import { RepoHubComponent } from "../../../src/modes/components/repo-hub";

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

describe("RepoHubComponent /repo panel contract (requirements/repo-index.md)", () => {
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
			expect(text(hub!)).toMatch(/Symbols: [1-9]\d*/);

			// d + y removes the index again.
			hub.handleInput("d");
			expect(text(hub!)).toContain("Delete repository index for");
			hub.handleInput("y");
			await until(() => text(hub!).includes("No repository index. Press b to build."));
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
			expect(text(hub!)).toMatch(/Symbols: [1-9]\d*/);
		} finally {
			hub?.dispose();
			await Promise.all([removeWithRetries(profileDir), removeWithRetries(projectDir)]);
		}
	});
});
