import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { DocsService } from "../../../src/docs/service";
import { DocsHubComponent } from "../../../src/modes/components/docs-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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

	it("opens the searched snapshot after another client removes and reimports the same index name", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-snapshot-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-snapshot-source-"));
		const writer = new DocsService({ agentDir: profileDir, cwd: sourceDir });
		let hub: DocsHubComponent | undefined;
		try {
			await fs.writeFile(path.join(sourceDir, "old.md"), "# Original\noriginal snapshot needle\n");
			await writer.init(".", "handbook");
			const originalId = writer.search("needle").sections[0].sectionId;
			const settings = await Settings.loadIsolated({ cwd: sourceDir, agentDir: profileDir, inMemory: true });
			hub = await DocsHubComponent.create({ requestRender: () => {} } as unknown as TUI, sourceDir, settings, {
				onCancel: vi.fn(),
			});
			hub.handleInput("/");
			typeText(hub, "needle");
			hub.handleInput("\n");
			expect(text(hub)).toContain("old.md:1-2");

			writer.remove("handbook");
			await fs.rm(path.join(sourceDir, "old.md"));
			await fs.writeFile(path.join(sourceDir, "new.md"), "# Replacement\nunrelated replacement policy\n");
			await writer.init(".", "handbook");
			expect(writer.search("replacement").sections[0].sectionId).toBe(originalId);

			hub.handleInput("\n");
			expect(text(hub)).toContain("old.md:1-2");
			expect(text(hub)).toContain("original snapshot needle");
			expect(text(hub)).not.toContain("unrelated replacement policy");
		} finally {
			hub?.dispose();
			writer.close();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	});
});
