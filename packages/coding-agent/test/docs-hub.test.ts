import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";
import type { Settings } from "../src/config/settings";
import { DocsSearchEngine } from "../src/docs/engine";
import { DocsService } from "../src/docs/service";
import type { DocsIndexSummary, DocsSearchResult } from "../src/docs/types";
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
	return openHub(root, agentDir);
}

async function openHub(root: string, agentDir: string, waitForIndexes = true) {
	const state: { hub?: DocsHubComponent } = {};
	const renderedFrames: string[] = [];
	const waiters = new Set<{ matches: (rendered: string) => boolean; resolve: () => void }>();
	const terminal = { rows: 30 };
	const tui = {
		terminal,
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
	if (waitForIndexes) await waitFor(rendered => rendered.includes("docs="));
	return { hub: component, waitFor, renderedFrames, terminal };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const grepExpression = String.raw` raw\.Token\[42\] `;

async function grepFixture(count = 25) {
	const root = await tempDir("docs-hub-regex-");
	const agentDir = await tempDir("docs-hub-regex-agent-");
	const docsDir = path.join(root, "docs");
	const otherDir = path.join(root, "other");
	await fs.mkdir(docsDir);
	await fs.mkdir(otherDir);
	for (let index = 0; index < count; index++)
		await fs.writeFile(
			path.join(docsDir, `p${String(index).padStart(2, "0")}.md`),
			`# Evidence\n raw.Token[42] marker ${index}\nStored final line ${index}.\n`,
		);
	for (const [name, text] of [
		["normalized", " raw Token 42 marker"],
		["uppercase", " RAW.Token[42] marker"],
		["unspaced", "raw.Token[42] marker"],
		["suffix", " raw.Token[42]suffix"],
		["decomposed", "cafe\u0301"],
		["precomposed", "café"],
		["tab", "left\tright"],
		["spaces", `left${" ".repeat(DEFAULT_TAB_WIDTH)}right`],
	])
		await fs.writeFile(path.join(docsDir, `${name}.md`), `# Decoy\n${text}\n`);
	await fs.writeFile(path.join(otherDir, "outside.md"), "# Outside\n raw.Token[42] outside selected index\n");
	const service = new DocsService({ agentDir, cwd: root });
	let expected: DocsSearchResult;
	try {
		await service.init(docsDir, "a-manual");
		await service.init(otherDir, "z-other");
		expected = await service.search(grepExpression, { index: "a-manual", mode: "grep", case: true, limit: 100 });
	} finally {
		await service.close();
	}
	await fs.rm(docsDir, { recursive: true });
	await fs.rm(otherDir, { recursive: true });
	return { ...(await openHub(root, agentDir)), root, agentDir, docsDir, expected };
}

describe("DocsHub selected-index boundary", () => {
	it.each(["/", "g"])("%s cannot cancel index loading or search without a selected index", async key => {
		const root = await tempDir("docs-hub-empty-");
		const agentDir = await tempDir("docs-hub-empty-agent-");
		const loading = Promise.withResolvers<DocsIndexSummary[]>();
		let listSignal: AbortSignal | undefined;
		const list = spyOn(DocsService.prototype, "list").mockImplementationOnce(options => {
			listSignal = options?.signal;
			return loading.promise;
		});
		const search = spyOn(DocsService.prototype, "search");
		let hub: DocsHubComponent | undefined;
		try {
			const opened = await openHub(root, agentDir, false);
			hub = opened.hub;
			for (const input of [key, "needle", "\r"]) hub.handleInput(input);
			expect(listSignal?.aborted).toBe(false);
			expect(search).not.toHaveBeenCalled();
			expect(hub.render(200).join("\n")).toContain("Loading document indexes");
			loading.resolve([]);
			await opened.waitFor(rendered => rendered.includes("No document indexes"));
			for (const input of [key, "needle", "\r"]) hub.handleInput(input);
			expect(search).not.toHaveBeenCalled();
			expect(hub.render(200).join("\n")).toContain("No document indexes");
		} finally {
			loading.resolve([]);
			await hub?.dispose();
			list.mockRestore();
			search.mockRestore();
		}
	});
});

describe("DocsHub list viewport", () => {
	async function indexFixture() {
		const root = await tempDir("docs-hub-viewport-");
		const agentDir = await tempDir("docs-hub-viewport-agent-");
		await fs.writeFile(path.join(root, "guide.md"), "# Guide\nviewport evidence\n");
		const service = new DocsService({ agentDir, cwd: root });
		let names: string[];
		try {
			for (let index = 0; index < 13; index++) await service.init(root, `manual-${String(index).padStart(2, "0")}`);
			names = (await service.list()).map(index => index.name);
		} finally {
			await service.close();
		}
		return { ...(await openHub(root, agentDir)), names };
	}

	it.each([24, 12, 3, 2, 1])(
		"keeps all 13 indexes selectable and visible in a %i-row terminal",
		async rows => {
			const { hub, terminal, names } = await indexFixture();
			terminal.rows = rows;
			const expectSelected = (index: number) => {
				const lines = hub.render(200).map(line => Bun.stripANSI(line));
				const visible = lines.slice(-terminal.rows);
				expect(visible.filter(line => line.startsWith("> "))).toEqual([
					expect.stringContaining(`${names[index]} `),
				]);
				expect(lines.length).toBeLessThanOrEqual(terminal.rows);
			};
			try {
				expectSelected(0);
				for (let index = 1; index < names.length; index++) {
					hub.handleInput("\x1b[B");
					expectSelected(index);
				}
				for (let index = names.length - 2; index >= 0; index--) {
					hub.handleInput("\x1b[A");
					expectSelected(index);
				}
			} finally {
				await hub.dispose();
			}
		},
		15_000,
	);

	it("keeps the selected index visible when the terminal shrinks and grows", async () => {
		const { hub, terminal, names } = await indexFixture();
		const expectSelected = (index: number) => {
			const lines = hub.render(200).map(line => Bun.stripANSI(line));
			expect(lines.slice(-terminal.rows).filter(line => line.startsWith("> "))).toEqual([
				expect.stringContaining(`${names[index]} `),
			]);
			expect(lines.length).toBeLessThanOrEqual(terminal.rows);
		};
		try {
			terminal.rows = 40;
			for (let index = 0; index < 6; index++) hub.handleInput("\x1b[B");
			expectSelected(6);
			for (const rows of [24, 10, 32, 8, 1, 2, 3]) {
				terminal.rows = rows;
				hub.invalidate();
				expectSelected(6);
				hub.handleInput("\x1b[A");
				expectSelected(5);
				hub.handleInput("\x1b[B");
				expectSelected(6);
			}
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it.each([20, 12])(
		"keeps all 20 search hits selectable and visible in a %i-row terminal",
		async rows => {
			const { hub, terminal, waitFor, expected } = await grepFixture(20);
			const expectSelected = (index: number) => {
				const lines = hub.render(200).map(line => Bun.stripANSI(line));
				expect(lines.slice(-terminal.rows).filter(line => line.startsWith("> "))).toEqual([
					expect.stringContaining(`${expected.sections[index]!.path}:`),
				]);
				expect(lines.length).toBeLessThanOrEqual(terminal.rows);
			};
			try {
				for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
				await waitFor(rendered => rendered.includes(`${expected.sections[0]!.path}:`));
				terminal.rows = rows;
				expectSelected(0);
				for (let index = 1; index < 20; index++) {
					hub.handleInput("\x1b[B");
					expectSelected(index);
				}
				hub.handleInput("\r");
				expect(hub.render(200).join("\n")).toContain(expected.sections[19]!.text.trimEnd());
				hub.handleInput("b");
				for (let index = 18; index >= 0; index--) {
					hub.handleInput("\x1b[A");
					expectSelected(index);
				}
				hub.handleInput("\r");
				expect(hub.render(200).join("\n")).toContain(expected.sections[0]!.text.trimEnd());
			} finally {
				await hub.dispose();
			}
		},
		15_000,
	);

	it("keeps the selected search hit visible when the terminal shrinks and grows", async () => {
		const { hub, terminal, waitFor, expected } = await grepFixture(20);
		const expectSelected = (index: number) => {
			const lines = hub.render(200).map(line => Bun.stripANSI(line));
			expect(lines.slice(-terminal.rows).filter(line => line.startsWith("> "))).toEqual([
				expect.stringContaining(`${expected.sections[index]!.path}:`),
			]);
			expect(lines.length).toBeLessThanOrEqual(terminal.rows);
		};
		try {
			terminal.rows = 40;
			for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
			await waitFor(rendered => rendered.includes(`${expected.sections[0]!.path}:`));
			for (let index = 0; index < 9; index++) hub.handleInput("\x1b[B");
			expectSelected(9);
			for (const rows of [24, 12, 32, 8, 1, 2, 3]) {
				terminal.rows = rows;
				hub.invalidate();
				expectSelected(9);
				hub.handleInput("\x1b[A");
				expectSelected(8);
				hub.handleInput("\x1b[B");
				expectSelected(9);
			}
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it("keeps search hits, opening, search input and deletion usable in a one-row terminal", async () => {
		const { hub, terminal, waitFor, expected } = await grepFixture(2);
		try {
			for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
			await waitFor(rendered => rendered.includes(`${expected.sections[0]!.path}:`));
			terminal.rows = 1;
			hub.handleInput("\x1b[B");
			const selected = hub.render(200).map(line => Bun.stripANSI(line));
			expect(selected).toEqual([expect.stringContaining(`> [regex] [a-manual] ${expected.sections[1]!.path}:`)]);
			hub.handleInput("\r");
			expect(hub.render(200)).toHaveLength(1);
			expect(hub.render(200).join("\n")).toContain(`${expected.sections[1]!.path}:`);
			hub.handleInput("b");
			expect(hub.render(200).map(line => Bun.stripANSI(line))).toEqual(selected);
			hub.handleInput("g");
			hub.handleInput("needle");
			expect(hub.render(200)).toHaveLength(1);
			expect(hub.render(200).join("\n")).toContain("needle");
			hub.handleInput("\x1b");
			hub.handleInput("d");
			expect(hub.render(200)).toHaveLength(1);
			expect(hub.render(200).join("\n")).toContain("Delete a-manual? y/N");
			hub.handleInput("n");
			expect(hub.render(200).map(line => Bun.stripANSI(line))).toEqual([expect.stringContaining("> a-manual ")]);
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it("reserves busy, progress and error rows without hiding the selected index", async () => {
		const { hub, terminal, waitFor, renderedFrames, names } = await indexFixture();
		const removal = Promise.withResolvers<void>();
		const remove = spyOn(DocsService.prototype, "remove").mockImplementationOnce(() => removal.promise);
		try {
			terminal.rows = 12;
			hub.handleInput("n");
			for (const input of ["new", "\r", ".", "\r"]) hub.handleInput(input);
			const start = renderedFrames.length;
			hub.handleInput("\r");
			await waitFor(() => true);
			const busyFrames = renderedFrames
				.slice(start)
				.filter(rendered => rendered.includes("Indexing document index"));
			expect(busyFrames.some(rendered => /(?:section|fts|complete) \d+\/\d+/.test(rendered))).toBe(true);
			for (const rendered of busyFrames) {
				const lines = rendered.split("\n").map(line => Bun.stripANSI(line));
				expect(lines.length).toBeLessThanOrEqual(terminal.rows);
				expect(lines.filter(line => line.startsWith("> "))).toEqual([expect.stringContaining(`${names[0]} `)]);
			}
			hub.handleInput("d");
			hub.handleInput("y");
			for (let index = 1; index < names.length; index++) hub.handleInput("\x1b[B");
			const busy = hub.render(200).map(line => Bun.stripANSI(line));
			expect(busy.length).toBeLessThanOrEqual(terminal.rows);
			expect(busy.join("\n")).toContain("Deleting document index");
			expect(busy.filter(line => line.startsWith("> "))).toEqual([expect.stringContaining(`${names.at(-1)} `)]);
			// Let the operation receive the deferred result before rejecting it.
			await Promise.resolve();
			removal.reject(new Error("viewport removal failure"));
			await waitFor(rendered => rendered.includes("viewport removal failure"));
			const failed = hub.render(200).map(line => Bun.stripANSI(line));
			expect(failed.length).toBeLessThanOrEqual(terminal.rows);
			expect(failed.filter(line => line.startsWith("> "))).toEqual([expect.stringContaining(`${names.at(-1)} `)]);
			terminal.rows = 1;
			expect(hub.render(200).map(line => Bun.stripANSI(line))).toEqual([
				expect.stringContaining(`${names.at(-1)} `),
			]);
		} finally {
			removal.resolve();
			remove.mockRestore();
			await hub.dispose();
		}
	}, 15_000);
});

describe("DocsHub explicit grep with real native snapshots", () => {
	it("g preserves regex spaces, selected-index scope and mode across DB-only pages", async () => {
		const { hub, waitFor, expected } = await grepFixture();
		try {
			expect(expected.total).toBe(25);
			hub.handleInput("g");
			hub.handleInput(grepExpression);
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("Section hits: 25"));
			const firstPage = hub.render(200).join("\n");
			expect(firstPage).toContain("showing 1-20");
			for (const section of expected.sections.slice(0, 20))
				expect(firstPage).toContain(`[regex] [a-manual] ${section.path}:${section.lineStart}-${section.lineEnd}`);
			for (const decoy of ["normalized.md", "uppercase.md", "unspaced.md", "suffix.md", "outside.md"])
				expect(firstPage).not.toContain(decoy);
			hub.handleInput("\r");
			expect(hub.render(200).join("\n")).toContain(expected.sections[0]!.text.trimEnd());
			hub.handleInput("n");
			await waitFor(rendered => rendered.includes("showing 21-25"));
			const finalPage = hub.render(200).join("\n");
			for (const section of expected.sections.slice(20))
				expect(finalPage).toContain(`[regex] [a-manual] ${section.path}:${section.lineStart}-${section.lineEnd}`);
			for (const section of expected.sections.slice(0, 20)) expect(finalPage).not.toContain(`${section.path}:`);
			expect(finalPage).toContain("Results exhausted.");
			hub.handleInput("\r");
			expect(hub.render(200).join("\n")).toContain(expected.sections[20]!.text.trimEnd());
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it("slash retains technical-name search while g uses literal raw regex and inline case flags", async () => {
		const { hub, waitFor } = await grepFixture(1);
		try {
			hub.handleInput("/");
			hub.handleInput(" raw.Token[42] ");
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("exact-name matches:"));
			const normal = hub.render(200).join("\n");
			expect(normal).toContain("[exact-name]");
			expect(normal).toContain("uppercase.md");
			expect(normal).toContain("unspaced.md");
			expect(normal).not.toContain("[regex]");
			hub.handleInput("\x1b");
			hub.handleInput("g");
			hub.handleInput("raw.Token[42]");
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("Section hits: 0"));
			expect(hub.render(200).join("\n")).not.toContain("Full name:");
			hub.handleInput("\x1b");
			hub.handleInput("g");
			hub.handleInput(`(?i)${grepExpression}`);
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("Section hits: 2"));
			const insensitive = hub.render(200).join("\n");
			expect(insensitive).toContain("[regex]");
			expect(insensitive).toContain("uppercase.md");
			expect(insensitive).not.toContain("unspaced.md");
			expect(insensitive).not.toContain("outside.md");
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it.each([
		{ query: "^cafe\u0301$", match: "decomposed.md", decoy: "precomposed.md" },
		{ query: "^left\tright$", match: "tab.md", decoy: "spaces.md" },
	])(
		"pasted raw regex selects $match rather than $decoy",
		async ({ query, match, decoy }) => {
			const { hub, waitFor } = await grepFixture(1);
			try {
				hub.handleInput("g");
				hub.handleInput(`\x1b[200~${query}\x1b[201~`);
				expect(hub.render(200).join("\n")).not.toContain("\t");
				hub.handleInput("\r");
				await waitFor(rendered => rendered.includes("Section hits: 1"));
				const results = hub.render(200).join("\n");
				expect(results).toContain(`[regex] [a-manual] ${match}:`);
				expect(results).not.toContain(decoy);
			} finally {
				await hub.dispose();
			}
		},
		15_000,
	);

	it.each([
		{ key: "/", query: "left", paths: ["tab.md", "spaces.md"] },
		{ key: "g", query: "^left\\tright$", paths: ["tab.md"] },
	])(
		"$key starts a fresh query after returning from a hit to the result list",
		async ({ key, query, paths }) => {
			const { hub, waitFor, expected } = await grepFixture(2);
			try {
				for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
				await waitFor(rendered => rendered.includes("Section hits: 2"));
				hub.handleInput("\x1b[B");
				hub.handleInput("\r");
				expect(hub.render(200).join("\n")).toContain(expected.sections[1]!.text.trimEnd());
				hub.handleInput("b");
				hub.handleInput("\x1b[A");
				hub.handleInput("\r");
				expect(hub.render(200).join("\n")).toContain(expected.sections[0]!.text.trimEnd());
				hub.handleInput("b");
				for (const input of [key, query, "\r"]) hub.handleInput(input);
				await waitFor(rendered => paths.every(file => rendered.includes(`${file}:`)));
				const results = hub.render(200).join("\n");
				expect(results).toContain(`Section hits: ${paths.length}`);
				expect(results).not.toContain("p00.md:");
				if (key === "g") expect(results).not.toContain("spaces.md:");
				hub.handleInput("\r");
				expect(hub.render(200).join("\n")).toContain("left");
			} finally {
				await hub.dispose();
			}
		},
		15_000,
	);

	it.each(["hit", "results"])(
		"d confirms deletion from the %s view",
		async view => {
			const { hub, waitFor, root, agentDir } = await grepFixture(2);
			const service = new DocsService({ agentDir, cwd: root });
			try {
				for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
				await waitFor(rendered => rendered.includes("Section hits: 2"));
				hub.handleInput("\r");
				if (view === "results") hub.handleInput("b");
				hub.handleInput("d");
				expect((await service.list()).map(index => index.name)).toEqual(["a-manual", "z-other"]);
				hub.handleInput("n");
				expect(hub.render(200).join("\n")).toContain("a-manual  docs=");
				expect((await service.list()).map(index => index.name)).toEqual(["a-manual", "z-other"]);
				for (const input of ["g", grepExpression, "\r"]) hub.handleInput(input);
				await waitFor(rendered => rendered.includes("Section hits: 2"));
				hub.handleInput("\r");
				if (view === "results") hub.handleInput("b");
				hub.handleInput("d");
				hub.handleInput("y");
				await waitFor(rendered => rendered.includes("z-other  docs="));
				expect((await service.list()).map(index => index.name)).toEqual(["z-other"]);
			} finally {
				await hub.dispose();
				await service.close();
			}
		},
		15_000,
	);

	it.each(["g", "/"])(
		"keeps a fresh %s input editable after an older stale continuation",
		async key => {
			const { hub, waitFor, root, agentDir, docsDir } = await grepFixture();
			try {
				hub.handleInput("g");
				hub.handleInput(grepExpression);
				hub.handleInput("\r");
				await waitFor(rendered => rendered.includes("Section hits: 25"));
				hub.handleInput("\r");
				const service = new DocsService({ agentDir, cwd: root });
				try {
					await service.remove("a-manual");
					await fs.mkdir(docsDir);
					await fs.writeFile(path.join(docsDir, "replacement.md"), "# New snapshot\nreplacement\n");
					await service.init(docsDir, "a-manual");
				} finally {
					await service.close();
				}
				hub.handleInput("n");
				// Let the real service receive the continuation before replacing its input/view.
				await Promise.resolve();
				hub.handleInput(key);
				hub.handleInput(key === "g" ? "^replace" : "replace");
				// With the old behavior this waits for the stale error, which hid the fresh input.
				await waitFor(() => true);
				const input = hub.render(200).join("\n");
				expect(input).toContain(key === "g" ? "Grep (regex, case-sensitive):" : "Search (relevance):");
				expect(input).toContain("replace");
				hub.handleInput(key === "g" ? "ment$" : "ment");
				hub.handleInput("\r");
				await waitFor(rendered => rendered.includes("Section hits: 1"));
				const results = hub.render(200).join("\n");
				expect(results).toContain("replacement.md:");
				expect(results).toContain(
					key === "g" ? "Search type: Grep (regex, case-sensitive)" : "Search type: Search (relevance)",
				);
				expect(results).not.toContain("Stale documentation search cursor");
			} finally {
				await hub.dispose();
			}
		},
		15_000,
	);

	it("invalid input, cancelled continuation and stale continuation retain the opened snapshot", async () => {
		const { hub, waitFor, expected, root, agentDir, docsDir } = await grepFixture();
		try {
			hub.handleInput("g");
			hub.handleInput(grepExpression);
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("Section hits: 25"));
			hub.handleInput("\r");
			const evidence = expected.sections[0]!;
			hub.handleInput("g");
			hub.handleInput("[");
			hub.handleInput("\r");
			await waitFor(rendered => /invalid.*regex/i.test(rendered));
			expect(hub.render(200).join("\n")).toContain(evidence.text.trimEnd());
			hub.handleInput("g");
			hub.handleInput("x".repeat(501));
			hub.handleInput("\r");
			await waitFor(rendered => rendered.includes("500"));
			expect(hub.render(200).join("\n")).toContain(evidence.text.trimEnd());
			hub.handleInput("g");
			hub.handleInput(grepExpression);
			hub.handleInput("\x1b");
			expect(hub.render(200).join("\n")).toContain(evidence.text.trimEnd());
			hub.handleInput("n");
			hub.handleInput("c");
			expect(hub.render(200).join("\n")).toContain(evidence.text.trimEnd());
			const service = new DocsService({ agentDir, cwd: root });
			try {
				await service.remove("a-manual");
				await fs.mkdir(docsDir);
				await fs.writeFile(path.join(docsDir, "replacement.md"), "# New snapshot\n raw.Token[42] replacement\n");
				await service.init(docsDir, "a-manual");
			} finally {
				await service.close();
			}
			hub.handleInput("n");
			await waitFor(rendered => rendered.includes("Stale documentation search cursor"));
			const stale = hub.render(200).join("\n");
			expect(stale).toContain(evidence.text.trimEnd());
			expect(stale).toContain(`sha256=${evidence.documentHash} · sectionId=${evidence.sectionId}`);
			expect(stale).not.toContain("replacement.md");
			hub.handleInput("b");
			expect(hub.render(200).join("\n")).toContain("showing 1-20");
		} finally {
			await hub.dispose();
		}
	}, 15_000);
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
