import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Real CLI and tool dispatch; only the model's Anthropic stream is scripted. */
describe("wiki CLI without source files", () => {
	let directory: string | undefined;
	let root: string;
	let configRoot: string;
	const profile = "wiki-e2e";
	const observed: Array<{ text: string; isError: boolean; elapsedMs: number }> = [];
	let query: string;
	let mode: "search" | "grep" | undefined;
	let caseSensitive: boolean | undefined;
	let callNumber = 0;
	const observedCalls = new Set<string>();
	const issuedCalls = new Map<string, number>();
	const children = new Set<Bun.Subprocess>();
	let stopServer: (() => void) | undefined;
	const sections = Array.from(
		{ length: 12 },
		(_, index) =>
			`## Procedure ${index}\nWIKIE2EBEACON ${index} ${"evidence ".repeat(260)}\nEND_PROCEDURE_${index}\n`,
	);
	const toolArgs = [
		"--print",
		"--no-session",
		"--model",
		"smoke/glm-5.2",
		"--tools",
		"wiki",
		"Retrieve all matching evidence from wiki, continuing until exhausted.",
	];

	beforeAll(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wiki-cli-"));
		root = path.join(directory, "project");
		const documents = path.join(directory, "documents");
		configRoot = path.join(directory, "config");
		const agentDir = path.join(configRoot, "profiles", profile, "agent");
		await Promise.all([root, documents, agentDir].map(dir => fs.mkdir(dir, { recursive: true })));
		await Bun.write(
			path.join(documents, "guide.md"),
			"# Workflow\nWIKIE2EBEACON\nThe workflow requires exactly seven cycles.\nInspect MBIST_CHECK.RPT for the pass criterion.\nUse C++ and docs/src/main.rs.\nPAIR=echo echo\n",
		);
		await Bun.write(path.join(documents, "procedures.md"), sections.join("\n"));
		await Bun.write(path.join(documents, "related.md"), "# Reports\nInspect another_check.rpt for report syntax.\n");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"marketplace:\n  autoUpdate: off\nstartup:\n  setupWizard: false\n  checkUpdate: false\n",
		);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model: string; messages?: Array<{ content: unknown }> };
				const blocks = (body.messages ?? []).flatMap(message =>
					Array.isArray(message.content) ? message.content : [],
				);
				const result = blocks.findLast(block => block.type === "tool_result");
				let nextInput: { query: string; cursor?: string; mode?: "search" | "grep"; case?: boolean } | undefined =
					result
						? undefined
						: {
								query,
								...(mode === undefined ? {} : { mode }),
								...(caseSensitive === undefined ? {} : { case: caseSensitive }),
							};
				if (result) {
					const text =
						typeof result.content === "string"
							? result.content
							: (result.content ?? [])
									.filter((part: { type: string; text?: string }) => part.type === "text")
									.map((part: { text: string }) => part.text)
									.join("\n");
					if (!observedCalls.has(result.tool_use_id)) {
						observedCalls.add(result.tool_use_id);
						const issuedAt = issuedCalls.get(result.tool_use_id);
						if (issuedAt === undefined) throw new Error(`Unexpected wiki result: ${result.tool_use_id}`);
						observed.push({ text, isError: Boolean(result.is_error), elapsedMs: performance.now() - issuedAt });
					}
					const continuation = text.match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
					if (continuation && !result.is_error) nextInput = JSON.parse(continuation);
				}
				const callId = `wiki_e2e_call_${callNumber++}`;
				const frames = [
					[
						"message_start",
						{
							type: "message_start",
							message: {
								id: `msg_${crypto.randomUUID()}`,
								type: "message",
								role: "assistant",
								model: body.model,
								content: [],
								stop_reason: null,
								usage: { input_tokens: 16, output_tokens: 8 },
							},
						},
					],
					[
						"content_block_start",
						{
							type: "content_block_start",
							index: 0,
							content_block: nextInput
								? { type: "tool_use", id: callId, name: "wiki", input: {} }
								: { type: "text", text: "" },
						},
					],
					[
						"content_block_delta",
						{
							type: "content_block_delta",
							index: 0,
							delta: nextInput
								? { type: "input_json_delta", partial_json: JSON.stringify(nextInput) }
								: { type: "text_delta", text: "WIKI_E2E_DONE" },
						},
					],
					["content_block_stop", { type: "content_block_stop", index: 0 }],
					[
						"message_delta",
						{
							type: "message_delta",
							delta: { stop_reason: nextInput ? "tool_use" : "end_turn" },
							usage: { output_tokens: 32 },
						},
					],
					["message_stop", { type: "message_stop" }],
				];
				if (nextInput) issuedCalls.set(callId, performance.now());
				return new Response(
					frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		stopServer = () => server.stop(true);
		await Bun.write(
			path.join(agentDir, "models.yml"),
			Bun.YAML.stringify({
				providers: {
					smoke: {
						api: "anthropic-messages",
						baseUrl: `http://127.0.0.1:${server.port}`,
						apiKey: "smoke-fixture-key",
						auth: "apiKey",
						compat: { requiresToolResultId: true },
						models: [
							{
								id: "glm-5.2",
								reasoning: true,
								thinking: { mode: "anthropic-budget-effort", efforts: ["high", "max"] },
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 32768,
							},
						],
					},
				},
			}),
		);
		expect(JSON.parse(await cli(["docs", "init", documents, "--name", "manual", "--json"])).index.documentCount).toBe(
			3,
		);
		await fs.rm(documents, { recursive: true });
	}, 120_000);

	beforeEach(() => {
		observed.length = 0;
		observedCalls.clear();
		issuedCalls.clear();
		query = "WIKIE2EBEACON";
		mode = undefined;
		caseSensitive = undefined;
	});

	afterAll(async () => {
		try {
			for (const child of children) {
				if (child.exitCode === null) child.kill();
			}
			await Promise.allSettled([...children].map(child => child.exited));
		} finally {
			try {
				stopServer?.();
			} finally {
				if (directory) await fs.rm(directory, { recursive: true, force: true });
			}
		}
	}, 120_000);
	async function cli(args: string[], scenarioConfigRoot = configRoot): Promise<string> {
		const child = Bun.spawn([process.execPath, "run", "dev", "--profile", profile, "--cwd", root, ...args], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				OMP_CONFIG_ROOT: scenarioConfigRoot,
				OMP_PROFILE: profile,
				PI_PROFILE: "",
				PI_CODING_AGENT_DIR: "",
				OMP_OFFLINE: "",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.add(child);
		const timer = setTimeout(() => child.kill(), 20_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(`Wiki CLI exited ${code}: ${stderr}`);
			return stdout;
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) {
				child.kill();
				await child.exited;
			}
			children.delete(child);
		}
	}

	it("returns complete search pages with unique sections, full bodies and the outward delay", async () => {
		expect(await cli(toolArgs)).toContain("WIKI_E2E_DONE");
		expect(
			observed.some(
				result =>
					!result.isError &&
					result.text.includes("exactly seven cycles") &&
					result.text.includes("index=manual") &&
					/sha256=[a-f0-9]{64}/.test(result.text),
			),
		).toBe(true);
		const pages = observed.filter(result => !result.isError).map(result => result.text);
		expect(pages.length).toBeGreaterThan(1);
		expect(observed.every(result => !result.isError)).toBe(true);
		for (const result of observed) expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
		const shown: number[] = [];
		const ids: string[] = [];
		for (const page of pages) {
			expect(page.length).toBeLessThanOrEqual(8_000);
			for (const match of page.matchAll(/^## Procedure (\d+)$/gm)) {
				const index = Number(match[1]);
				shown.push(index);
				expect(page).toContain(sections[index]!);
			}
			for (const match of page.matchAll(/sectionId=(\d+)/g)) ids.push(match[1]!);
		}
		expect(shown.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index));
		expect(new Set(ids).size).toBe(ids.length);
		expect(pages.at(-1)).toContain("All matching results exhausted");
	}, 120_000);

	it.each(["mbist_check.rpt", "Explain mbist_check.rpt."])(
		"ranks the exact name before related matches for %s",
		async nameQuery => {
			query = nameQuery;
			await cli(toolArgs);
			const names = observed.map(result => result.text).join("\n");
			expect(observed.length).toBeGreaterThan(0);
			expect(observed.every(result => !result.isError)).toBe(true);
			expect(names).toMatch(/guide\.md:[^\n]+match=exact-name/);
			expect(names).toMatch(/related\.md:[^\n]+match=related/);
			expect(names.indexOf("guide.md:")).toBeLessThan(names.indexOf("related.md:"));
			expect(names).toContain("Inspect MBIST_CHECK.RPT for the pass criterion.");
			expect(names).not.toContain("未找到完整名称命中");
		},
		120_000,
	);

	it.each(["missing_check.rpt", "mbist_check.rpt."])(
		"preserves related matches without inventing an exact name for %s",
		async nameQuery => {
			query = nameQuery;
			await cli(toolArgs);
			const names = observed.map(result => result.text).join("\n");
			expect(observed.length).toBeGreaterThan(0);
			expect(observed.every(result => !result.isError)).toBe(true);
			expect(names).toContain("未找到完整名称命中");
			expect(names).toMatch(/guide\.md:[^\n]+match=related/);
			expect(names).not.toContain("match=exact-name");
		},
		120_000,
	);

	it("reports an exhausted zero-match search without an error", async () => {
		query = "NO_MATCH_WIKI_E2E_ZZXQ";
		await cli(toolArgs);
		expect(observed).toHaveLength(1);
		expect(observed[0]?.isError).toBe(false);
		expect(observed[0]?.text).toContain("0 matching section(s) in the searched imported corpus");
		expect(observed[0]?.text).toContain("All matching results exhausted");
	}, 120_000);

	it("searches the literal C++ name rather than treating it as a regular expression", async () => {
		query = "C++";
		await cli(toolArgs);
		expect(observed.every(result => !result.isError)).toBe(true);
		expect(observed.map(result => result.text).join("\n")).toMatch(/guide\.md:[^\n]+match=exact-name/);
	}, 120_000);

	it("continues explicit grep pages with stable arguments, ordered full bodies and the outward delay", async () => {
		mode = "grep";
		caseSensitive = false;
		query = "^WIKIE2EBEACON(?: [0-9]+)?";
		await cli(toolArgs);
		expect(observed.length).toBeGreaterThan(1);
		const grepIds: string[] = [];
		const grepProcedures: number[] = [];
		for (const result of observed) {
			expect(result.isError).toBe(false);
			expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
			expect(result.text).toContain("13 matching section(s)");
			expect(result.text).toContain("match=regex");
			expect(result.text).not.toContain("match=exact-name");
			expect(result.text).not.toContain("match=related");
			expect(result.text).not.toContain("未找到完整名称命中");
			const next = result.text.match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
			if (next)
				expect(JSON.parse(next)).toMatchObject({ query, mode: "grep", case: false, cursor: expect.any(String) });
			for (const match of result.text.matchAll(/^## Procedure (\d+)$/gm)) {
				const index = Number(match[1]);
				grepProcedures.push(index);
				expect(result.text).toContain(sections[index]!);
			}
			for (const match of result.text.matchAll(/sectionId=(\d+)/g)) grepIds.push(match[1]!);
		}
		expect(grepProcedures).toEqual(Array.from({ length: 12 }, (_, index) => index));
		expect(grepIds).toHaveLength(13);
		expect(new Set(grepIds).size).toBe(13);
		expect(observed.at(-1)?.text).toContain("All matching results exhausted");
	}, 120_000);

	it.each(["C\\+\\+", "docs/src/main\\.rs", "(?<=PAIR=)(echo) \\1"])(
		"uses explicit grep semantics for %s",
		async regex => {
			mode = "grep";
			caseSensitive = false;
			query = regex;
			await cli(toolArgs);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.isError).toBe(false);
			expect(observed[0]?.text).toMatch(/guide\.md:[^\n]+match=regex/);
			expect(observed[0]?.text).toContain("PAIR=echo echo");
			expect(observed[0]?.text).not.toContain("related.md:");
		},
		120_000,
	);

	it.each([true, false])(
		"honors explicit grep case sensitivity (case=%s)",
		async sensitive => {
			query = "mbist_check\\.rpt";
			mode = "grep";
			caseSensitive = sensitive;
			await cli(toolArgs);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.isError).toBe(false);
			if (sensitive) {
				expect(observed[0]?.text).toContain("0 matching section(s) in the searched imported corpus");
				expect(observed[0]?.text).not.toContain("guide.md:");
			} else {
				expect(observed[0]?.text).toMatch(/guide\.md:[^\n]+match=regex/);
				expect(observed[0]?.text).toContain("Inspect MBIST_CHECK.RPT for the pass criterion.");
			}
			expect(observed[0]?.text).toContain("All matching results exhausted");
		},
		120_000,
	);

	it.each(["NO_MATCH_WIKI_E2E_ZZXQ", "  WIKIE2EBEACON  "])(
		"keeps a zero-match grep successful without trimming its expression: %s",
		async regex => {
			mode = "grep";
			caseSensitive = false;
			query = regex;
			await cli(toolArgs);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.isError).toBe(false);
			expect(observed[0]?.text).toContain("0 matching section(s) in the searched imported corpus");
			expect(observed[0]?.text).toContain("All matching results exhausted");
		},
		120_000,
	);

	it.each([
		{ name: "invalid syntax", regex: "[" },
		{ name: "501-character expression", regex: "x".repeat(501) },
	])(
		"reports $name as a grep error rather than zero matches",
		async ({ regex }) => {
			mode = "grep";
			caseSensitive = false;
			query = regex;
			await cli(toolArgs);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.isError).toBe(true);
			expect(observed[0]?.text).toMatch(regex === "[" ? /regex/i : /500/);
			expect(observed[0]?.text).not.toContain("0 matching section(s)");
		},
		120_000,
	);

	it("removes an imported index through the CLI and reports the missing index as an error", async () => {
		// Keep this destructive scenario independent of the shared, source-free index.
		const removedConfigRoot = path.join(directory!, "removed-config");
		await fs.cp(
			path.join(configRoot, "profiles", profile, "agent"),
			path.join(removedConfigRoot, "profiles", profile, "agent"),
			{ recursive: true },
		);
		try {
			expect(JSON.parse(await cli(["docs", "remove", "manual", "--force", "--json"], removedConfigRoot))).toEqual({
				removed: "manual",
			});
			await cli(toolArgs, removedConfigRoot);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.isError).toBe(true);
			expect(observed[0]?.text).toContain("No document indexes");
		} finally {
			await fs.rm(removedConfigRoot, { recursive: true, force: true });
		}
	}, 120_000);
});
