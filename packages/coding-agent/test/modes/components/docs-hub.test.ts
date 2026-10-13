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

	it("pages all DB evidence, preserves full citations, and surfaces stale continuation without restarting", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-paging-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-paging-source-"));
		const writer = new DocsService({ agentDir: profileDir, cwd: sourceDir });
		let hub: DocsHubComponent | undefined;
		try {
			for (let index = 0; index < 45; index++)
				await fs.writeFile(
					path.join(sourceDir, `p${String(index).padStart(2, "0")}.md`),
					`# Evidence\nmbist_check.rpt evidence ${index}\nStored final line ${index}.\n`,
				);
			await writer.init(".", "handbook");
			const expected = writer.search("mbist_check.rpt", { limit: 100 });
			expect(expected.total).toBe(45);
			expect(expected.sections).toHaveLength(45);
			await fs.rm(sourceDir, { recursive: true });
			await fs.mkdir(sourceDir);
			const settings = await Settings.loadIsolated({ cwd: sourceDir, agentDir: profileDir, inMemory: true });
			hub = await DocsHubComponent.create({ requestRender: () => {} } as unknown as TUI, sourceDir, settings, {
				onCancel: vi.fn(),
			});
			hub.handleInput("/");
			typeText(hub, "mbist_check.rpt");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Section hits: 45 · showing 1-20");
			expect(text(hub)).toContain("exact-name matches: 45");
			expect(text(hub)).toContain("n next page");
			const seen: number[] = [];
			const collectPage = () => {
				seen.push(...Array.from(text(hub!).matchAll(/sectionId=(\d+)/g), match => Number(match[1])));
			};
			collectPage();
			hub.handleInput("n");
			expect(text(hub)).toContain("showing 21-40");
			collectPage();
			hub.handleInput("\n");
			const section = expected.sections[20]!;
			expect(text(hub)).toContain("[exact-name]");
			expect(text(hub)).toContain(`[${section.index}] ${section.path}:${section.lineStart}-${section.lineEnd}`);
			expect(text(hub)).toContain(`sha256=${section.documentHash} · sectionId=${section.sectionId}`);
			expect(text(hub)).toContain(section.text.trim());
			hub.handleInput("b");
			expect(text(hub)).toContain("showing 21-40");
			hub.handleInput("n");
			expect(text(hub)).toContain("showing 41-45");
			expect(text(hub)).toContain("Results exhausted.");
			expect(text(hub)).not.toContain("n next page");
			collectPage();
			expect(seen).toEqual(expected.sections.map(hit => hit.sectionId));
			expect(new Set(seen).size).toBe(45);
			hub.handleInput("n");
			expect(text(hub)).toContain("showing 41-45");

			hub.handleInput("\x1b");
			hub.handleInput("/");
			typeText(hub, "mbist_check.rpt");
			hub.handleInput("\n");
			writer.remove("handbook");
			await fs.writeFile(path.join(sourceDir, "replacement.md"), "# Replacement\nmbist_check.rpt new snapshot\n");
			await writer.init(".", "handbook");
			hub.handleInput("n");
			expect(text(hub)).toContain("showing 1-20");
			expect(text(hub)).not.toContain("replacement.md");
			expect(text(hub)).toMatch(/cursor|continuation/i);
			hub.handleInput("\n");
			expect(text(hub)).toContain(expected.sections[0]!.text.trim());

			hub.handleInput("\x1b");
			hub.handleInput("/");
			typeText(hub, "zxqv_missing.noexist");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Section hits: 0 · showing 0-0");
			expect(text(hub)).toContain("未找到完整名称命中");
			expect(text(hub)).toContain("Results exhausted.");
			hub.handleInput("n");
			expect(text(hub)).toContain("Section hits: 0");
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
