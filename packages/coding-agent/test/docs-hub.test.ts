import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { Settings } from "../src/config/settings";
import { DocsSearchEngine } from "../src/docs/engine";
import { DocsHubComponent } from "../src/modes/components/docs-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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

async function fixture() {
	const root = await tempDir("docs-hub-root-");
	const agentDir = await tempDir("docs-hub-agent-");
	await fs.writeFile(path.join(root, `guide-${attack}.md`), `# Guide\nneedle ${attack}\n`);
	const seed = new DocsSearchEngine({ agentDir, cwd: root });
	try {
		const result = await seed.init(".", "safe");
		const db = new Database(seed.databasePath, { strict: true });
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.query("UPDATE doc_indexes SET name=?,root_path=? WHERE id=?").run(
				`index-${attack}`,
				`root-${attack}`,
				result.index.id,
			);
		} finally {
			db.close();
		}
	} finally {
		seed.close();
	}

	const state: { hub?: DocsHubComponent } = {};
	const renderedFrames: string[] = [];
	const waiters = new Set<{ matches: (rendered: string) => boolean; resolve: () => void }>();
	const tui = {
		requestRender: () => {
			const hub = state.hub;
			if (!hub) return;
			const rendered = hub.render(200).join("\n");
			renderedFrames.push(rendered);
			for (const waiter of waiters) {
				if (waiter.matches(rendered)) {
					waiters.delete(waiter);
					waiter.resolve();
				}
			}
		},
	} as unknown as TUI;
	const settings = { getAgentDir: () => agentDir } as unknown as Settings;
	const component = await DocsHubComponent.create(tui, root, settings, { onCancel: () => {} });
	state.hub = component;
	const waitFor = (matches: (rendered: string) => boolean): Promise<void> => {
		const ready = (rendered: string) =>
			!/(?:Loading|Searching|Deleting|Indexing) document index/.test(rendered) && matches(rendered);
		if (ready(component.render(200).join("\n"))) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.add({ matches: ready, resolve });
		return promise;
	};
	await waitFor(rendered => rendered.includes("docs=1 sections=1"));
	return { hub: component, waitFor, renderedFrames };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Windows filenames cannot contain control characters (\r, \t, ESC…), so the
// attack-path fixture cannot be created there; the sanitization surface is POSIX-only.
describe.skipIf(process.platform === "win32")("DocsHub terminal text safety", () => {
	it("sanitizes listed indexes, search details, stored Markdown, and real error text", async () => {
		const { hub, waitFor } = await fixture();
		try {
			const list = hub.render(200).join("\n");
			expectControlSequencesNeutralized(list);
			expect(list).not.toContain("\nFORGED");
			expect(list).toContain("docs=1 sections=1");
			expect(list).toContain("root-");

			hub.handleInput("/");
			hub.handleInput("needle");
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("Section hits: 1"));
			expectControlSequencesNeutralized(hub.render(200).join("\n"));
			hub.handleInput("\r");
			const stored = hub.render(200).join("\n");
			expect(stored).toContain("needle");
			expectControlSequencesNeutralized(stored);

			hub.handleInput("\x1b");
			hub.handleInput("n");
			// The wizard's Input parses keystrokes: escape sequences and control
			// bytes are key events, never value text, so the attack string cannot
			// be typed into the directory field. The error path is driven with a
			// plain missing directory instead.
			for (const input of ["failure", "\r", "missing-root", "\r", "\r"]) hub.handleInput(input);
			await waitFor(rendered => rendered.includes("Markdown root is not a directory"));
			const error = hub.render(200).join("\n");
			expect(error).toContain("FORGED");
			expectControlSequencesNeutralized(error);
			expect(error).not.toContain("\nFORGED");
		} finally {
			await hub.dispose();
		}
	});

	it("sanitizes actual import progress paths and messages", async () => {
		const { hub, waitFor, renderedFrames } = await fixture();
		try {
			hub.handleInput("n");
			for (const input of ["new", "\r", ".", "\r", "\r"]) hub.handleInput(input);
			await waitFor(rendered => rendered.includes("new  docs=1 sections=1"));
			const progressFrames = renderedFrames.filter(rendered =>
				/(?:section|fts|complete) \d+\/\d+/.test(Bun.stripANSI(rendered)),
			);
			expect(progressFrames.length).toBeGreaterThan(0);
			expect(progressFrames.some(rendered => rendered.includes("guide-") && rendered.includes("FORGED"))).toBe(true);
			for (const progress of progressFrames) {
				expectControlSequencesNeutralized(progress);
				expect(progress).not.toContain("\nFORGED");
			}
		} finally {
			await hub.dispose();
		}
	});
});
