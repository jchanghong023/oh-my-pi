import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import * as docsExtractor from "../../../src/docs/extractor";
import type { DocsExtractor } from "../../../src/docs/types";
import { DocsHubComponent } from "../../../src/modes/components/docs-hub";
import { initTheme } from "../../../src/modes/theme/theme";

type Renderable = { render(width: number): string[] };

function text(component: Renderable): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function typeText(component: { handleInput(data: string): void }, value: string): void {
	for (const character of value) component.handleInput(character);
}

function abortError(): Error {
	const error = new Error("Document indexing cancelled");
	error.name = "AbortError";
	return error;
}

describe("DocsHubComponent shared interaction contract", () => {
	it("creates, atomically reinitializes, searches evidence, and confirms deletion", async () => {
		await initTheme();
		const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-profile-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-source-"));
		const docsDir = path.join(sourceDir, "handbook");
		await fs.mkdir(docsDir);
		await fs.writeFile(path.join(docsDir, "runbook.md"), "# Runbook\nScanFlow executes scan jobs.\n", "utf8");

		let extractorCalls = 0;
		const secondExtractionStarted = Promise.withResolvers<void>();
		const secondExtractionCancelled = Promise.withResolvers<void>();
		const cancelledRender = Promise.withResolvers<void>();
		const rebuiltRender = Promise.withResolvers<void>();
		let cancellationObserved = false;
		const extractor: DocsExtractor = async ({ signal }) => {
			extractorCalls++;
			if (extractorCalls === 2) {
				secondExtractionStarted.resolve();
				return await new Promise<never>((_resolve, reject) => {
					const cancel = () => {
						cancellationObserved = true;
						secondExtractionCancelled.resolve();
						reject(abortError());
					};
					if (signal?.aborted) cancel();
					else signal?.addEventListener("abort", cancel, { once: true });
				});
			}
			return {
				entities: [
					{
						localId: "flow",
						kind: "flow",
						identity: { name: "ScanFlow" },
						displayName: "ScanFlow",
						aliases: ["scan-flow"],
						evidence: { quote: "ScanFlow executes scan jobs.", lineStart: 2, lineEnd: 2, confidence: 1 },
					},
				],
				assertions: [
					{
						subjectLocalId: "flow",
						field: "summary",
						value: "Executes scan jobs",
						evidence: { quote: "ScanFlow executes scan jobs.", lineStart: 2, lineEnd: 2, confidence: 1 },
					},
				],
				relations: [],
			};
		};
		const extractorSpy = vi.spyOn(docsExtractor, "resolveConfiguredDocsExtractor").mockResolvedValue(extractor);

		let hub!: DocsHubComponent;
		const ready = Promise.withResolvers<void>();
		const empty = Promise.withResolvers<void>();
		const tui = {
			requestRender: () => {
				if (!hub) return;
				const rendered = text(hub);
				if (rendered.includes("  ready  ")) ready.resolve();
				if (cancellationObserved && rendered.includes("  ready  ") && !rendered.includes("extract "))
					cancelledRender.resolve();
				if (
					extractorCalls === 3 &&
					rendered.includes("  ready  ") &&
					!/\n(?:scan|extract|fts|cleanup) \d/u.test(rendered)
				)
					rebuiltRender.resolve();
				if (rendered.includes("No document indexes")) empty.resolve();
			},
		} as unknown as TUI;
		const settings = await Settings.loadIsolated({ cwd: sourceDir, agentDir: profileDir, inMemory: true });
		const onCancel = vi.fn();

		try {
			hub = await DocsHubComponent.create(tui, sourceDir, settings, {} as never, { onCancel });
			expect(text(hub)).toContain("No document indexes. Press n to add one.");

			hub.handleInput("n");
			expect(text(hub)).toContain("Step 1/5: name");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Step 2/5: directory");
			typeText(hub, "handbook");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Step 3/5: schema");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Step 4/5: mode");
			typeText(hub, "\x7f\x7f\x7f");
			typeText(hub, "structured");
			hub.handleInput("\n");
			expect(text(hub)).toContain("Step 5/5: confirm");
			expect(text(hub)).toContain("Schema: dft");
			hub.handleInput("\n");

			await ready.promise;
			expect(text(hub)).toContain("handbook  dft@1  structured  ready");
			hub.handleInput("r");
			await secondExtractionStarted.promise;
			expect(text(hub)).toContain("extract 0/1 failed=0 runbook.md");
			hub.handleInput("c");
			await secondExtractionCancelled.promise;
			await cancelledRender.promise;
			expect(text(hub)).toContain("handbook  dft@1  structured  ready");

			hub.handleInput("r");
			await rebuiltRender.promise;
			expect(text(hub)).toContain("handbook  dft@1  structured  ready");

			hub.handleInput("/");
			typeText(hub, "ScanFlow");
			hub.handleInput("\n");
			const searchPreview = text(hub);
			expect(searchPreview).toContain("Entity hits: 1");
			expect(searchPreview).toContain("Section hits: 1");
			expect(searchPreview).toContain("[entity] flow ScanFlow");
			expect(searchPreview).toContain("[section] runbook.md:");
			hub.handleInput("\x1b[B");
			hub.handleInput("\n");
			expect(text(hub)).toContain("ScanFlow executes scan jobs.");
			expect(text(hub)).toContain("[handbook] runbook.md:");

			hub.handleInput("\x1b");
			hub.handleInput("d");
			expect(text(hub)).toContain("Delete handbook? y/N");
			hub.handleInput("n");
			expect(text(hub)).toContain("handbook  dft@1  structured  ready");
			hub.handleInput("d");
			hub.handleInput("y");
			await empty.promise;
			expect(text(hub)).toContain("No document indexes. Press n to add one.");
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			hub?.dispose();
			extractorSpy.mockRestore();
			await Promise.all([
				fs.rm(profileDir, { recursive: true, force: true }),
				fs.rm(sourceDir, { recursive: true, force: true }),
			]);
		}
	});
});
