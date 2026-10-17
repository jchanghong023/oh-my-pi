import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { DocsService } from "../../../src/docs/service";
import { DocsHubComponent } from "../../../src/modes/components/docs-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function text(component: { render(width: number): string[] }, width = 120): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function typeText(component: { handleInput(data: string): void }, value: string): void {
	for (const character of value) component.handleInput(character);
}

async function observedHub(sourceDir: string, profileDir: string, onCancel = vi.fn()) {
	const state: { hub?: DocsHubComponent } = {};
	const waiters = new Set<{ matches: (rendered: string) => boolean; resolve: () => void }>();
	const renderedFrames: string[] = [];
	const terminal = { rows: 40, columns: 120 };
	const tui = {
		terminal,
		requestRender: () => {
			const hub = state.hub;
			if (!hub) return;
			const rendered = text(hub, terminal.columns);
			renderedFrames.push(rendered);
			for (const waiter of waiters) {
				if (waiter.matches(rendered)) {
					waiters.delete(waiter);
					waiter.resolve();
				}
			}
		},
	} as unknown as TUI;
	const settings = await Settings.loadIsolated({ cwd: sourceDir, agentDir: profileDir, inMemory: true });
	const component = await DocsHubComponent.create(tui, sourceDir, settings, { onCancel });
	state.hub = component;
	const waitFor = (matches: (rendered: string) => boolean): Promise<void> => {
		const ready = (rendered: string) =>
			!/(?:Loading|Searching|Deleting|Indexing) document index/.test(rendered) && matches(rendered);
		if (ready(text(component, terminal.columns))) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.add({ matches: ready, resolve });
		return promise;
	};
	await waitFor(rendered => !rendered.includes("Loading document indexes…"));
	return { hub: component, waitFor, renderedFrames, terminal };
}

function submitSearch(hub: DocsHubComponent, query: string): void {
	hub.handleInput("/");
	typeText(hub, query);
	hub.handleInput("\n");
}

describe("DocsHubComponent shared interaction contract", () => {
	it("imports, reads without source files, and requires confirmation before deletion", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-source-"));
		const docsDir = path.join(sourceDir, "handbook");
		await fs.mkdir(docsDir);
		await fs.writeFile(path.join(docsDir, "runbook.md"), "# Runbook\nScanFlow executes scan jobs.\n", "utf8");
		let hub: DocsHubComponent | undefined;
		const onCancel = vi.fn();
		try {
			const observed = await observedHub(sourceDir, profileDir, onCancel);
			hub = observed.hub;
			hub.handleInput("n");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			hub.handleInput("\n");
			await observed.waitFor(rendered => rendered.includes("handbook  docs="));
			await fs.rm(docsDir, { recursive: true });
			submitSearch(hub, "ScanFlow");
			await observed.waitFor(rendered => rendered.includes("runbook.md:1-2"));
			hub.handleInput("\n");
			expect(text(hub)).toContain("ScanFlow executes scan jobs.");
			hub.handleInput("\x1b");
			hub.handleInput("d");
			hub.handleInput("n");
			const stored = new DocsService({ agentDir: profileDir });
			try {
				expect((await stored.list()).map(index => index.name)).toEqual(["handbook"]);
				hub.handleInput("d");
				hub.handleInput("y");
				await observed.waitFor(rendered => rendered.includes("No document indexes."));
				expect(await stored.list()).toEqual([]);
			} finally {
				await stored.close();
			}
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			await hub?.dispose();
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
			const originalId = (await writer.search("needle")).sections[0]!.sectionId;
			const observed = await observedHub(sourceDir, profileDir);
			hub = observed.hub;
			submitSearch(hub, "needle");
			await observed.waitFor(rendered => rendered.includes("old.md:1-2"));

			await writer.remove("handbook");
			await fs.rm(path.join(sourceDir, "old.md"));
			await fs.writeFile(path.join(sourceDir, "new.md"), "# Replacement\nunrelated replacement policy\n");
			await writer.init(".", "handbook");
			expect((await writer.search("replacement")).sections[0]!.sectionId).toBe(originalId);

			hub.handleInput("\n");
			expect(text(hub)).toContain("old.md:1-2");
			expect(text(hub)).toContain("original snapshot needle");
			expect(text(hub)).not.toContain("unrelated replacement policy");
		} finally {
			await hub?.dispose();
			await writer.close();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	});

	it("keeps every stored long-line character reachable across width and height changes", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-wrap-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-wrap-source-"));
		const writer = new DocsService({ agentDir: profileDir, cwd: sourceDir });
		let hub: DocsHubComponent | undefined;
		try {
			const longLine =
				"wrapneedle " +
				Array.from({ length: 90 }, (_, index) => `${index}:汉字😀e\u0301👩‍💻  `).join("") +
				"REQUIRED_EVIDENCE_TAIL";
			await fs.writeFile(path.join(sourceDir, "wrapped.md"), `# Wrapped evidence\n${longLine}\n最后证据🧪\n`);
			await writer.init(".", "handbook");
			const stored = (await writer.search("wrapneedle")).sections[0]!;
			await fs.rm(path.join(sourceDir, "wrapped.md"));
			const observed = await observedHub(sourceDir, profileDir);
			hub = observed.hub;
			observed.terminal.rows = 12;
			submitSearch(hub, "wrapneedle");
			await observed.waitFor(rendered => rendered.includes("wrapped.md:1-"));

			for (const width of [80, 24, 120]) {
				expect(hub.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
			}
			hub.handleInput("\n");
			for (const [width, height] of [
				[80, 12],
				[24, 8],
				[120, 16],
				[36, 10],
				[160, 12],
			] as const) {
				observed.terminal.columns = width;
				observed.terminal.rows = height;
				const frame = () => {
					const lines = hub!.render(width);
					expect(lines.length).toBeLessThanOrEqual(height);
					expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
					return lines.slice(2).map(line => Bun.stripANSI(line));
				};
				// Reflow from the previous viewport, then use the standard scroll keys.
				frame();
				hub.handleInput("\x1b[F");
				expect(frame().join("")).toContain("REQUIRED_EVIDENCE_TAIL");
				expect(frame().join("")).toContain("最后证据🧪");
				hub.handleInput("\x1b[H");
				const initial = frame();
				hub.handleInput("\x1b[6~");
				expect(frame()).not.toEqual(initial);
				hub.handleInput("\x1b[5~");
				expect(frame()).toEqual(initial);

				const reached = [...initial];
				let previous = initial;
				for (let step = 0; step < stored.text.length; step++) {
					hub.handleInput("\x1b[B");
					const next = frame();
					if (JSON.stringify(next) === JSON.stringify(previous)) break;
					reached.push(next[next.length - 1]!);
					previous = next;
				}
				expect(reached.join("")).toContain(stored.text.replaceAll("\n", ""));
				hub.handleInput("\x1b[A");
				expect(frame()).not.toEqual(previous);
			}
			hub.handleInput("b");
			expect(text(hub)).toContain("Section hits: 1");
		} finally {
			await hub?.dispose();
			await writer.close();
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
			const expected = await writer.search("mbist_check.rpt", { limit: 100 });
			expect(expected.total).toBe(45);
			expect(expected.sections).toHaveLength(45);
			await fs.rm(sourceDir, { recursive: true });
			await fs.mkdir(sourceDir);
			const observed = await observedHub(sourceDir, profileDir);
			hub = observed.hub;
			submitSearch(hub, "mbist_check.rpt");
			await observed.waitFor(rendered => rendered.includes("Section hits: 45 · showing 1-20"));
			expect(text(hub)).toContain("exact-name matches: 45");
			expect(text(hub)).toContain("n next page");
			const seen: number[] = [];
			const collectPage = () => {
				seen.push(...Array.from(text(hub!).matchAll(/sectionId=(\d+)/g), match => Number(match[1])));
			};
			collectPage();
			hub.handleInput("n");
			await observed.waitFor(rendered => rendered.includes("showing 21-40"));
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
			await observed.waitFor(rendered => rendered.includes("showing 41-45"));
			expect(text(hub)).toContain("Results exhausted.");
			expect(text(hub)).not.toContain("n next page");
			collectPage();
			expect(seen).toEqual(expected.sections.map(hit => hit.sectionId));
			expect(new Set(seen).size).toBe(45);
			hub.handleInput("n");
			expect(text(hub)).toContain("showing 41-45");

			hub.handleInput("\x1b");
			submitSearch(hub, "mbist_check.rpt");
			await observed.waitFor(rendered => rendered.includes("showing 1-20"));
			await writer.remove("handbook");
			await fs.writeFile(path.join(sourceDir, "replacement.md"), "# Replacement\nmbist_check.rpt new snapshot\n");
			await writer.init(".", "handbook");
			hub.handleInput("\x1b[B");
			hub.handleInput("n");
			await observed.waitFor(rendered => /cursor|continuation/i.test(rendered));
			expect(text(hub)).toContain("showing 1-20");
			expect(text(hub)).not.toContain("replacement.md");
			hub.handleInput("\n");
			expect(text(hub)).toContain(expected.sections[1]!.text.trim());
			expect(text(hub)).toContain(
				`sha256=${expected.sections[1]!.documentHash} · sectionId=${expected.sections[1]!.sectionId}`,
			);

			hub.handleInput("\x1b");
			submitSearch(hub, "zxqv_missing.noexist");
			await observed.waitFor(rendered => rendered.includes("Section hits: 0 · showing 0-0"));
			expect(text(hub)).toContain("未找到完整名称命中");
			expect(text(hub)).toContain("Results exhausted.");
			hub.handleInput("n");
			expect(text(hub)).toContain("Section hits: 0");
		} finally {
			await hub?.dispose();
			await writer.close();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	}, 10_000);

	it("keeps input responsive, cancels real searches, and never replaces newer results with a cancelled page", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-cancel-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-cancel-source-"));
		const writer = new DocsService({ agentDir: profileDir, cwd: sourceDir });
		let hub: DocsHubComponent | undefined;
		try {
			await fs.writeFile(path.join(sourceDir, "cancelled.md"), "# Cancelled\ncancelneedle old evidence\n");
			await fs.writeFile(path.join(sourceDir, "retained.md"), "# Retained\nretainedneedle current evidence\n");
			await writer.init(".", "handbook");
			const observed = await observedHub(sourceDir, profileDir);
			hub = observed.hub;

			submitSearch(hub, "cancelneedle");
			expect(text(hub)).toContain("Searching document indexes…");
			// A real event-loop turn proves responsiveness during the actual worker/floor wait.
			// Fake timers cannot exercise the subprocess and the monotonic public search floor.
			await Bun.sleep(0);
			expect(text(hub)).toContain("Searching document indexes…");
			hub.handleInput("c");
			await observed.waitFor(rendered => !rendered.includes("Searching document indexes…"));
			expect(text(hub)).not.toContain("cancelled.md:1-2");

			submitSearch(hub, "cancelneedle");
			expect(text(hub)).toContain("Searching document indexes…");
			await Bun.sleep(0);
			hub.handleInput("\x1b");
			await observed.waitFor(rendered => !rendered.includes("Searching document indexes…"));
			expect(text(hub)).not.toContain("cancelled.md:1-2");

			submitSearch(hub, "retainedneedle");
			await observed.waitFor(rendered => rendered.includes("retained.md:1-2"));
			expect(text(hub)).not.toContain("cancelled.md:1-2");
			hub.handleInput("\n");
			expect(text(hub)).toContain("retainedneedle current evidence");
			expect(text(hub)).not.toContain("cancelneedle old evidence");

			hub.handleInput("\x1b");
			submitSearch(hub, "cancelneedle");
			expect(text(hub)).toContain("Searching document indexes…");
			await Bun.sleep(0);
			const framesBeforeDispose = observed.renderedFrames.length;
			await hub.dispose();
			await writer.list();
			expect(observed.renderedFrames).toHaveLength(framesBeforeDispose);
		} finally {
			await hub?.dispose();
			await writer.close();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	});
});
