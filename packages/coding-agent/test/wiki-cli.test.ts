import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Real CLI and tool dispatch; only the model's Anthropic stream is scripted. */
it("imports wiki evidence through the CLI, reads it without source files, and reports deletion through real tool dispatch", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wiki-cli-"));
	const root = path.join(directory, "project");
	const documents = path.join(directory, "documents");
	const configRoot = path.join(directory, "config");
	const profile = "wiki-e2e";
	const agentDir = path.join(configRoot, "profiles", profile, "agent");
	const observed: Array<{ text: string; isError: boolean }> = [];
	await Promise.all([root, documents, agentDir].map(dir => fs.mkdir(dir, { recursive: true })));
	await Bun.write(
		path.join(documents, "guide.md"),
		"# Workflow\n``` `WIKIE2EBEACON`\nThe workflow requires exactly seven cycles.\n",
	);
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
			const result = blocks.find(block => block.type === "tool_result" && block.tool_use_id === "wiki_e2e_call");
			if (result) {
				const text =
					typeof result.content === "string"
						? result.content
						: (result.content ?? [])
								.filter((part: { type: string; text?: string }) => part.type === "text")
								.map((part: { text: string }) => part.text)
								.join("\n");
				observed.push({ text, isError: Boolean(result.is_error) });
			}
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
						content_block: result
							? { type: "text", text: "" }
							: { type: "tool_use", id: "wiki_e2e_call", name: "wiki", input: {} },
					},
				],
				[
					"content_block_delta",
					{
						type: "content_block_delta",
						index: 0,
						delta: result
							? { type: "text_delta", text: "WIKI_E2E_DONE" }
							: { type: "input_json_delta", partial_json: JSON.stringify({ query: "WIKIE2EBEACON" }) },
					},
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{
						type: "message_delta",
						delta: { stop_reason: result ? "end_turn" : "tool_use" },
						usage: { output_tokens: 32 },
					},
				],
				["message_stop", { type: "message_stop" }],
			];
			return new Response(
				frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const env = {
		...process.env,
		OMP_CONFIG_ROOT: configRoot,
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: "",
		OMP_OFFLINE: "",
		ZCODE_API_BASE_URL: `http://127.0.0.1:${server.port}`,
	};
	async function cli(args: string[]): Promise<string> {
		const child = Bun.spawn([process.execPath, "run", "dev", "--profile", profile, "--cwd", root, ...args], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
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
		}
	}
	try {
		expect(JSON.parse(await cli(["docs", "init", documents, "--name", "manual", "--json"])).index.documentCount).toBe(
			1,
		);
		await fs.rename(documents, path.join(directory, "documents-unavailable"));
		const query = [
			"--print",
			"--no-session",
			"--model",
			"zcode-api/glm-5.2",
			"--tools",
			"wiki",
			"Retrieve WIKIE2EBEACON from wiki.",
		];
		expect(await cli(query)).toContain("WIKI_E2E_DONE");
		expect(
			observed.some(
				result =>
					!result.isError &&
					result.text.includes("exactly seven cycles") &&
					result.text.includes("index=manual") &&
					/sha256=[a-f0-9]{64}/.test(result.text),
			),
		).toBe(true);
		expect(JSON.parse(await cli(["docs", "remove", "manual", "--force", "--json"]))).toEqual({ removed: "manual" });
		observed.length = 0;
		await cli(query);
		expect(observed.some(result => result.isError && result.text.includes("No document indexes"))).toBe(true);
		expect(await Bun.file(path.join(directory, "documents-unavailable", "guide.md")).text()).toContain(
			"exactly seven cycles",
		);
	} finally {
		server.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 30_000);
