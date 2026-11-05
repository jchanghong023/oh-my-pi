import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Declare the implementation loaded by the spawned CLI for Bun's native --changed graph.
import "../src/tools";

/** Real CLI and tool dispatch; only the model's Anthropic stream is scripted. */
describe("knowledge_search CLI without source files", () => {
	let directory: string | undefined;
	let preparedIndex: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
	const profile = "wiki-e2e";
	// Start each real-process watchdog with its scenario, not while it waits in a private queue.
	const scenarioTest = it.serial;
	const sections = Array.from(
		{ length: 12 },
		(_, index) =>
			`## Procedure ${index}\nWIKIE2EBEACON ${index} ${"evidence ".repeat(260)}\nEND_PROCEDURE_${index}\n`,
	);
	const toolArgs = [
		"--print",
		"--no-session",
		"--model",
		"deepseek/glm-5.2",
		"--tools",
		"knowledge_search",
		"Retrieve all matching evidence from knowledge_search, continuing until exhausted.",
	];

	beforeAll(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-knowledge-search-cli-"));
		// Consumers receive only these immutable index bytes, never shared app state.
		const documents = path.join(directory, "documents");
		await fs.mkdir(documents, { recursive: true });
		await Bun.write(
			path.join(documents, "guide.md"),
			"# Workflow\nWIKIE2EBEACON\nThe workflow requires exactly seven cycles.\nInspect MBIST_CHECK.RPT for the pass criterion.\nUse C++ and docs/src/main.rs.\nPAIR=echo echo\n",
		);
		await Bun.write(path.join(documents, "procedures.md"), sections.join("\n"));
		await Bun.write(path.join(documents, "related.md"), "# Reports\nInspect another_check.rpt for report syntax.\n");
		const preparation = await createScenario();
		try {
			expect(
				JSON.parse(await preparation.cli(["knowledge", "init", documents, "--name", "manual", "--json"])).index
					.documentCount,
			).toBe(3);
			const indexDirectory = path.dirname(preparation.knowledgePath);
			// Retain a committed WAL if present; every consumer rebuilds its own shared-memory state.
			const indexFiles = (await fs.readdir(indexDirectory)).filter(
				name => name === "knowledge.db" || name === "knowledge.db-wal",
			);
			preparedIndex = await Promise.all(
				indexFiles.map(async name => ({ name, bytes: await fs.readFile(path.join(indexDirectory, name)) })),
			);
			await fs.rm(documents, { recursive: true });
		} finally {
			await preparation.dispose();
		}
	}, 120_000);

	afterAll(async () => {
		if (directory) await fs.rm(directory, { recursive: true, force: true });
	}, 120_000);

	type ScenarioInput = { query?: string; mode?: "search" | "grep"; caseSensitive?: boolean };
	interface Scenario {
		knowledgePath: string;
		observed: Array<{ text: string; isError: boolean; elapsedMs: number }>;
		cli(args: string[]): Promise<string>;
		dispose(): Promise<void>;
	}

	async function withScenario(input: ScenarioInput, body: (scenario: Scenario) => Promise<void>): Promise<void> {
		const scenario = await createScenario(input, preparedIndex);
		try {
			await body(scenario);
		} finally {
			await scenario.dispose();
		}
	}

	async function createScenario(
		{ query = "WIKIE2EBEACON", mode, caseSensitive }: ScenarioInput = {},
		prepared?: typeof preparedIndex,
	) {
		const scenarioDirectory = await fs.mkdtemp(path.join(directory!, "scenario-"));
		const root = path.join(scenarioDirectory, "project");
		const configRoot = path.join(scenarioDirectory, "config");
		const agentDir = path.join(configRoot, "profiles", profile, "agent");
		// OMP_CACHE_DIR is cleared in each child so the index lives with its isolated agent.
		const knowledgePath = path.join(agentDir, "knowledge.db");
		const observed: Array<{ text: string; isError: boolean; elapsedMs: number }> = [];
		const observedCalls = new Set<string>();
		const issuedCalls = new Map<string, number>();
		const children = new Set<Bun.Subprocess>();
		let callNumber = 0;
		let stopServer: (() => void | Promise<void>) | undefined;

		async function dispose() {
			try {
				for (const child of children) {
					if (child.exitCode === null) child.kill();
				}
				await Promise.allSettled([...children].map(child => child.exited));
			} finally {
				try {
					await stopServer?.();
				} finally {
					await fs.rm(scenarioDirectory, { recursive: true, force: true });
				}
			}
		}

		try {
			await Promise.all([root, agentDir].map(dir => fs.mkdir(dir, { recursive: true })));
			if (prepared) {
				await Promise.all(prepared.map(file => Bun.write(path.join(agentDir, file.name), file.bytes)));
			}
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"startup:\n  setupWizard: false\nmnemopi:\n  noEmbeddings: true\n",
			);
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models")) {
						return Response.json({
							object: "list",
							data: [{ id: "glm-5.2", object: "model", owned_by: "deepseek" }],
						});
					}
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
							if (issuedAt === undefined)
								throw new Error(`Unexpected knowledge_search result: ${result.tool_use_id}`);
							observed.push({
								text,
								isError: Boolean(result.is_error),
								elapsedMs: performance.now() - issuedAt,
							});
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
									? { type: "tool_use", id: callId, name: "knowledge_search", input: {} }
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
						deepseek: {
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
			return { knowledgePath, observed, cli, dispose };
		} catch (error) {
			await dispose();
			throw error;
		}

		async function cli(args: string[]): Promise<string> {
			const child = Bun.spawn([process.execPath, "run", "dev", "--profile", profile, "--cwd", root, ...args], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					OMP_CONFIG_ROOT: configRoot,
					OMP_CACHE_DIR: "",
					OMP_PROFILE: profile,
					PI_PROFILE: "",
					PI_CODING_AGENT_DIR: "",
					OMP_OFFLINE: "",
					PI_CONFIG_FILES: "",
					MNEMOPI_NO_EMBEDDINGS: "true",
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
	}

	scenarioTest(
		"returns complete search pages with unique sections, full bodies and the outward delay",
		async () => {
			return withScenario({}, async ({ cli, observed }) => {
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
					expect(page.length).toBeLessThanOrEqual(4_000);
					for (const match of page.matchAll(/^## Procedure (\d+)$/gm)) {
						const index = Number(match[1]);
						shown.push(index);
						expect(page).toContain(sections[index]!);
					}
					for (const match of page.matchAll(/sectionId=(\d+)/g)) ids.push(match[1]!);
				}
				expect(shown.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index));
				expect(new Set(ids).size).toBe(ids.length);
				expect(pages.at(-1)).toMatch(/exhaust|no (?:more|further) results/i);
			});
		},
		120_000,
	);

	scenarioTest.each(["mbist_check.rpt", "Explain mbist_check.rpt."])(
		"ranks the exact name before related matches for %s",
		async nameQuery => {
			return withScenario({ query: nameQuery }, async ({ cli, observed }) => {
				await cli(toolArgs);
				const names = observed.map(result => result.text).join("\n");
				expect(observed.length).toBeGreaterThan(0);
				expect(observed.every(result => !result.isError)).toBe(true);
				expect(names).toMatch(/guide\.md:[^\n]+match=exact-name/);
				expect(names).toMatch(/related\.md:[^\n]+match=related/);
				expect(names.indexOf("guide.md:")).toBeLessThan(names.indexOf("related.md:"));
				expect(names).toContain("Inspect MBIST_CHECK.RPT for the pass criterion.");
				expect(names).not.toContain("未找到完整名称命中");
			});
		},
		120_000,
	);

	scenarioTest.each(["missing_check.rpt", "mbist_check.rpt."])(
		"preserves related matches without inventing an exact name for %s",
		async nameQuery => {
			return withScenario({ query: nameQuery }, async ({ cli, observed }) => {
				await cli(toolArgs);
				const names = observed.map(result => result.text).join("\n");
				expect(observed.length).toBeGreaterThan(0);
				expect(observed.every(result => !result.isError)).toBe(true);
				expect(names).toContain("未找到完整名称命中");
				expect(names).toMatch(/guide\.md:[^\n]+match=related/);
				expect(names).not.toContain("match=exact-name");
			});
		},
		120_000,
	);

	scenarioTest(
		"reports an exhausted zero-match search without an error",
		async () => {
			return withScenario({ query: "NO_MATCH_WIKI_E2E_ZZXQ" }, async ({ cli, observed }) => {
				await cli(toolArgs);
				expect(observed).toHaveLength(1);
				expect(observed[0]?.isError).toBe(false);
				expect(observed[0]?.text).toMatch(/(?:0\s+match|no matches)/i);
				expect(observed[0]?.text).toMatch(/exhaust|no (?:more|further) results/i);
				expect(observed[0]?.text).toMatch(/corpus|indexes|documents/i);
				expect(observed[0]?.text).toMatch(/(?:not|doesn't|cannot|can't).*(?:elsewhere|exist|absence)/i);
			});
		},
		120_000,
	);

	scenarioTest(
		"searches the literal C++ name rather than treating it as a regular expression",
		async () => {
			return withScenario({ query: "C++" }, async ({ cli, observed }) => {
				await cli(toolArgs);
				expect(observed.every(result => !result.isError)).toBe(true);
				expect(observed.map(result => result.text).join("\n")).toMatch(/guide\.md:[^\n]+match=exact-name/);
			});
		},
		120_000,
	);

	scenarioTest(
		"continues explicit grep pages with stable arguments, ordered full bodies and the outward delay",
		async () => {
			const query = "^WIKIE2EBEACON(?: [0-9]+)?";
			return withScenario({ query, mode: "grep", caseSensitive: false }, async ({ cli, observed }) => {
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
						expect(JSON.parse(next)).toMatchObject({
							query,
							mode: "grep",
							case: false,
							cursor: expect.any(String),
						});
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
				expect(observed.at(-1)?.text).toMatch(/exhaust|no (?:more|further) results/i);
				expect(observed.at(-1)?.text).toMatch(/corpus|indexes|documents/i);
			});
		},
		120_000,
	);

	scenarioTest.each([0x7f, 0x80, 0x85, 0x9b, 0x9f])(
		"continues literal DEL/C1 grep expressions unchanged through sanitized tool results (U+%s)",
		async codePoint => {
			const control = String.fromCharCode(codePoint);
			const query = `WIKIE2EBEACON|${control}`;
			return withScenario({ query, mode: "grep", caseSensitive: true }, async ({ cli, observed }) => {
				expect(await cli(toolArgs)).toContain("WIKI_E2E_DONE");
				expect(observed.length).toBeGreaterThan(1);
				const ids: string[] = [];
				const procedures: number[] = [];
				for (const result of observed) {
					expect(result.isError).toBe(false);
					expect(result.text).toContain("13 matching section(s)");
					expect(result.text).not.toContain("related.md:");
					const next = result.text.match(/^More results remain\. Continue with the same query: (.+)$/m)?.[1];
					if (next) {
						expect(next).not.toContain(control);
						expect(JSON.parse(next)).toMatchObject({
							query,
							mode: "grep",
							case: true,
							cursor: expect.any(String),
						});
					}
					for (const match of result.text.matchAll(/^## Procedure (\d+)$/gm)) {
						const index = Number(match[1]);
						procedures.push(index);
						expect(result.text).toContain(sections[index]!);
					}
					for (const match of result.text.matchAll(/sectionId=(\d+)/g)) ids.push(match[1]!);
				}
				expect(procedures).toEqual(Array.from({ length: 12 }, (_, index) => index));
				expect(ids).toHaveLength(13);
				expect(new Set(ids).size).toBe(13);
			});
		},
		120_000,
	);

	scenarioTest.each(["C\\+\\+", "docs/src/main\\.rs", "(?<=PAIR=)(echo) \\1"])(
		"uses explicit grep semantics for %s",
		async regex => {
			return withScenario({ query: regex, mode: "grep", caseSensitive: false }, async ({ cli, observed }) => {
				await cli(toolArgs);
				expect(observed).toHaveLength(1);
				expect(observed[0]?.isError).toBe(false);
				expect(observed[0]?.text).toMatch(/guide\.md:[^\n]+match=regex/);
				expect(observed[0]?.text).toContain("PAIR=echo echo");
				expect(observed[0]?.text).not.toContain("related.md:");
			});
		},
		120_000,
	);

	scenarioTest.each([true, false])(
		"honors explicit grep case sensitivity (case=%s)",
		async sensitive => {
			return withScenario(
				{ query: "mbist_check\\.rpt", mode: "grep", caseSensitive: sensitive },
				async ({ cli, observed }) => {
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
				},
			);
		},
		120_000,
	);

	scenarioTest.each(["NO_MATCH_WIKI_E2E_ZZXQ", "  WIKIE2EBEACON  "])(
		"keeps a zero-match grep successful without trimming its expression: %s",
		async regex => {
			return withScenario({ query: regex, mode: "grep", caseSensitive: false }, async ({ cli, observed }) => {
				await cli(toolArgs);
				expect(observed).toHaveLength(1);
				expect(observed[0]?.isError).toBe(false);
				expect(observed[0]?.text).toContain("0 matching section(s) in the searched imported corpus");
			});
		},
		120_000,
	);

	scenarioTest.each([
		{ name: "invalid syntax", regex: "[" },
		{ name: "501-character expression", regex: "x".repeat(501) },
	])(
		"reports $name as a grep error rather than zero matches",
		async ({ regex }) => {
			return withScenario({ query: regex, mode: "grep", caseSensitive: false }, async ({ cli, observed }) => {
				await cli(toolArgs);
				expect(observed).toHaveLength(1);
				expect(observed[0]?.isError).toBe(true);
				expect(observed[0]?.text).toMatch(regex === "[" ? /regex/i : /500/);
				expect(observed[0]?.text).not.toContain("0 matching section(s)");
			});
		},
		120_000,
	);

	scenarioTest(
		"removes an imported index through the CLI and reports the missing index as an error",
		async () => {
			// This scenario removes only its own copy of the prepared, source-free index.
			return withScenario({}, async ({ cli, observed }) => {
				expect(JSON.parse(await cli(["knowledge", "remove", "manual", "--force", "--json"]))).toEqual({
					removed: "manual",
				});
				await cli(toolArgs);
				expect(observed).toHaveLength(1);
				expect(observed[0]?.isError).toBe(true);
				expect(observed[0]?.text).toContain("No document indexes");
			});
		},
		120_000,
	);
});
