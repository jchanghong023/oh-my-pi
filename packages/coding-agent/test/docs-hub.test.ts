import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../src/config/model-registry";
import type { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import type { DocsBuildResult, DocsProgress } from "../src/docs/types";
import { DocsHubComponent } from "../src/modes/components/docs-hub";
import { initTheme } from "../src/modes/theme/theme";

const tempDirs: string[] = [];
const attack = "\x1b]0;OSC\x07\x1b[31mCSI\x1b[0m\rRETURN\nFORGED\tTAB\u0085";

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function expectControlSequencesNeutralized(rendered: string): void {
	expect(rendered).not.toContain("\x1b]0;OSC");
	expect(rendered).not.toContain("\x1b[31mCSI");
	expect(rendered).not.toContain("\r");
	expect(rendered).not.toContain("\t");
	expect(rendered).not.toContain("\u0085");
}

async function fixture(): Promise<{
	hub: DocsHubComponent;
	result: DocsBuildResult;
}> {
	const root = await tempDir("docs-hub-root-");
	const agentDir = await tempDir("docs-hub-agent-");
	await fs.writeFile(path.join(root, `guide-${attack}.md`), `# Guide\nneedle ${attack}\n`);
	const seed = new DocsService({ agentDir, cwd: root, extractor: null });
	const result = await seed.init(".", "safe", "dft");
	seed.storage.db
		.query("UPDATE doc_indexes SET name=?,root_path=?,last_error=? WHERE id=?")
		.run(`index-${attack}`, `root-${attack}`, `error-${attack}`, result.index.id);
	seed.close();

	const tui = { requestRender: () => {} } as unknown as TUI;
	const settings = {
		getAgentDir: () => agentDir,
		get: (key: string) => (key === "task.maxConcurrency" ? 1 : undefined),
	} as unknown as Settings;
	const hub = await DocsHubComponent.create(tui, root, settings, {} as ModelRegistry, { onCancel: () => {} });
	return { hub, result };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DocsHub terminal text safety", () => {
	it("sanitizes list, detail, stored Markdown, and error text", async () => {
		const { hub } = await fixture();
		try {
			const list = hub.render(200).join("\n");
			expectControlSequencesNeutralized(list);
			expect(list).not.toContain("\nFORGED");

			hub.handleInput("i");
			const info = hub.render(200).join("\n");
			expectControlSequencesNeutralized(info);
			expect(info).not.toContain("\nFORGED");

			hub.handleInput("\x1b");
			hub.handleInput("/");
			hub.handleInput("needle");
			hub.handleInput("\r");
			hub.handleInput("\r");
			expectControlSequencesNeutralized(hub.render(200).join("\n"));

			hub.handleInput("\x1b");
			vi.spyOn(DocsService.prototype, "search").mockImplementation(() => {
				throw new Error(`search-${attack}`);
			});
			hub.handleInput("/");
			hub.handleInput("failure");
			hub.handleInput("\r");
			const error = hub.render(200).join("\n");
			expectControlSequencesNeutralized(error);
			expect(error).not.toContain("\nFORGED");
		} finally {
			hub.dispose();
		}
	});

	it("sanitizes progress paths and messages", async () => {
		const { hub, result } = await fixture();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		vi.spyOn(DocsService.prototype, "reinit").mockImplementation(
			async (_name: string, options?: { onProgress?: (progress: DocsProgress) => void }) => {
				options?.onProgress?.({
					phase: "extract",
					total: 1,
					completed: 0,
					failed: 0,
					currentPath: `path-${attack}`,
					message: `message-${attack}`,
				});
				await gate;
				return result;
			},
		);
		try {
			hub.handleInput("r");
			const progress = hub.render(200).join("\n");
			expectControlSequencesNeutralized(progress);
			expect(progress).not.toContain("\nFORGED");
		} finally {
			release();
			await gate;
			await Promise.resolve();
			hub.dispose();
		}
	});
});
