import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { DocsService } from "../../../src/docs/service";
import { DocsHubComponent } from "../../../src/modes/components/docs-hub";
import { initTheme } from "../../../src/modes/theme/theme";

function text(component: { render(width: number): string[] }): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function typeText(component: { handleInput(data: string): void }, value: string): void {
	for (const character of value) component.handleInput(character);
}

describe("DocsHubComponent shared interaction contract", () => {
	it("imports, reads without source files, and requires confirmation before deletion", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-source-"));
		const docsDir = path.join(sourceDir, "handbook");
		await fs.mkdir(docsDir);
		await fs.writeFile(path.join(docsDir, "runbook.md"), "# Runbook\nScanFlow executes scan jobs.\n", "utf8");
		let hub!: DocsHubComponent;
		const ready = Promise.withResolvers<void>();
		const tui = {
			requestRender: () => {
				if (hub && text(hub).includes("handbook  docs=")) ready.resolve();
			},
		} as unknown as TUI;
		const settings = await Settings.loadIsolated({ cwd: sourceDir, agentDir: profileDir, inMemory: true });
		const onCancel = vi.fn();
		try {
			hub = await DocsHubComponent.create(tui, sourceDir, settings, { onCancel });
			hub.handleInput("n");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			hub.handleInput("\n");
			await ready.promise;
			await fs.rm(docsDir, { recursive: true });
			hub.handleInput("/");
			typeText(hub, "ScanFlow");
			hub.handleInput("\n");
			expect(text(hub)).toContain("runbook.md:1-2");
			hub.handleInput("\n");
			expect(text(hub)).toContain("ScanFlow executes scan jobs.");
			hub.handleInput("\x1b");
			hub.handleInput("d");
			hub.handleInput("n");
			const stored = new DocsService({ agentDir: profileDir });
			try {
				expect(stored.list().map(index => index.name)).toEqual(["handbook"]);
				hub.handleInput("d");
				hub.handleInput("y");
				expect(stored.list()).toEqual([]);
				expect(stored.search("ScanFlow").sections).toEqual([]);
			} finally {
				stored.close();
			}
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			hub?.dispose();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	});
});
