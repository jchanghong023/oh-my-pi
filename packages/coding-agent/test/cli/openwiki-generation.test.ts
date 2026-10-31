import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
type Message = { role: string; content?: unknown; tool_call_id?: string };
type Request = { model: string; stream?: boolean; messages: Message[]; tools?: Array<{ function?: { name: string } }> };
type Reply = { name: string; args: object } | { text: string };

function submittedPage(message: Message): boolean {
	if (message.role !== "tool" || message.tool_call_id !== "call_submit_page" || typeof message.content !== "string") {
		return false;
	}
	try {
		const result = JSON.parse(message.content);
		return result?.status === "complete" && result.page === "/openwiki/quickstart.md";
	} catch {
		return false;
	}
}

function response(reply: Reply, stream: boolean): Response {
	const tool = "name" in reply;
	const message = tool
		? {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: `call_${reply.name}`,
						type: "function",
						function: { name: reply.name, arguments: JSON.stringify(reply.args) },
					},
				],
			}
		: { role: "assistant", content: reply.text };
	const finish = tool ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if (!stream)
		return Response.json({
			id: "local",
			object: "chat.completion",
			created: 0,
			model: "fixture-model",
			choices: [{ index: 0, message, finish_reason: finish }],
			usage,
		});
	const delta =
		"name" in reply
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.name}`,
							type: "function",
							function: { name: reply.name, arguments: JSON.stringify(reply.args) },
						},
					],
				}
			: { role: "assistant", content: reply.text };
	const base = { id: "local", object: "chat.completion.chunk", created: 0, model: "fixture-model" };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		{ ...base, choices: [], usage },
	];
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function git(cwd: string, ...args: string[]) {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
	});
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

async function scenario(mode: "partial" | "drift") {
	using dir = TempDir.createSync("@omp-openwiki-generation-");
	const root = dir.join("repo");
	const home = dir.join("home");
	const configRoot = dir.join("config");
	const agentDir = path.join(configRoot, "profiles", "fixture", "agent");
	await Promise.all([root, home, agentDir].map(p => mkdir(p, { recursive: true })));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Fixture");
	await git(root, "config", "user.email", "fixture@example.invalid");
	await writeFile(path.join(root, "README.md"), "# Fixture\n\nStable source.\n");
	await git(root, "add", "README.md");
	await git(root, "commit", "--quiet", "-m", "fixture");
	const requests: Request[] = [];
	let changed = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname.endsWith("/models"))
				return Response.json({
					object: "list",
					data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }],
				});
			const body = (await request.json()) as Request;
			requests.push(body);
			const offered = new Set((body.tools ?? []).map(tool => tool.function?.name));
			const results = new Set(
				body.messages.filter(message => message.role === "tool").map(message => message.tool_call_id),
			);
			let reply: Reply = { text: "Finished." };
			if (offered.has("submit_plan") && !results.has("call_submit_plan")) {
				reply = {
					name: "submit_plan",
					args: {
						pages: [
							{
								path: "/openwiki/quickstart.md",
								title: "Quickstart",
								purpose: "Explain the fixture",
								seedPaths: ["README.md"],
							},
						],
					},
				};
			} else if (offered.has("submit_page") && mode === "drift") {
				if (!results.has("call_write_file")) {
					reply = {
						name: "write_file",
						args: {
							file_path: "/openwiki/quickstart.md",
							content:
								"---\ntype: Guide\ntitle: Quickstart\n---\n\n# Quickstart\n\nFixture documentation. The repository README describes stable source.\n",
						},
					};
				} else if (!results.has("call_submit_page")) {
					reply = {
						name: "submit_page",
						args: {
							claims: [
								{
									statement: "The repository README describes stable source.",
									evidence: [{ resource: "repo://README.md" }],
								},
							],
						},
					};
				} else if (!changed && body.messages.some(submittedPage)) {
					await writeFile(path.join(root, "README.md"), "# Fixture\n\nSource changed during generation.\n");
					changed = true;
				}
			}
			return response(reply, body.stream === true);
		},
	});
	try {
		await writeFile(
			path.join(agentDir, "models.yml"),
			Bun.YAML.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						api: "openai-completions",
						auth: "none",
						models: [
							{
								id: "fixture-model",
								name: "Fixture",
								reasoning: false,
								input: ["text"],
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
		const config = `modelRoles:\n  default: ${mode === "partial" ? "fixture/not-the-selected-model" : "fixture/fixture-model"}\nstartup:\n  setupWizard: false\n  checkUpdate: false\n`;
		await writeFile(path.join(agentDir, "config.yml"), config);
		const selector = mode === "partial" ? ["--model-id", "fixture/fixture-model"] : [];
		const telemetry = mode === "partial" ? "nested/telemetry/record.json" : "README.md/telemetry.json";
		const proc = Bun.spawn(
			[
				process.execPath,
				cli,
				"--profile",
				"fixture",
				"openwiki",
				"code",
				"--init",
				"--language",
				"en",
				"--print",
				"--telemetry-file",
				telemetry,
				...selector,
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					TMP: process.env.TMP,
					TEMP: process.env.TEMP,
					TMPDIR: process.env.TMPDIR,
					HOME: home,
					USERPROFILE: home,
					OMP_CONFIG_ROOT: configRoot,
					OMP_PROFILE: "fixture",
					OMP_OFFLINE: "1",
					OPENWIKI_CONFIG_DIR: dir.join("standalone"),
					NO_COLOR: "1",
					AWS_EC2_METADATA_DISABLED: "true",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => proc.kill(), 100_000);
		let code: number, stdout: string, stderr: string;
		try {
			[code, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
		} finally {
			clearTimeout(timer);
		}
		const output = stdout + stderr;
		expect(requests.length, output).toBeGreaterThan(1);
		expect(requests.every(req => req.model === "fixture-model")).toBe(true);
		expect(
			requests.some(req =>
				req.messages.some(message => message.role === "tool" && message.tool_call_id === "call_submit_plan"),
			),
		).toBe(true);
		expect(existsSync(path.join(root, ".github", "workflows"))).toBe(false);
		expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
		expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
		expect(existsSync(dir.join("standalone"))).toBe(false);
		if (mode === "partial") {
			expect(JSON.parse(await readFile(path.join(root, telemetry), "utf8"))).toMatchObject({
				disabled: true,
				sent: false,
			});
		} else {
			expect(output).toMatch(/telemetry.*(?:error|fail|could not)|(?:error|fail|could not).*telemetry/i);
		}
		expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
		if (mode === "partial") {
			expect(
				requests.some(req => req.tools?.some(tool => tool.function?.name === "submit_page")),
				output,
			).toBe(true);
			expect(code, output).not.toBe(0);
			expect(output).toMatch(/fail|skip|incomplete/i);
			const metadata = path.join(root, "openwiki", ".last-update.json");
			if (existsSync(metadata)) expect(JSON.parse(await readFile(metadata, "utf8")).status).not.toBe("complete");
		} else {
			const toolResults = requests.flatMap(req => req.messages.filter(message => message.role === "tool"));
			const diagnostic = `${output}\nModel tool results: ${JSON.stringify(toolResults, null, 2)}`;
			expect(toolResults.some(submittedPage), diagnostic).toBe(true);
			expect(changed, diagnostic).toBe(true);
			expect(code, diagnostic).toBe(0);
			expect(output, diagnostic).toMatch(/source changed|source.*change/i);
			expect(output, diagnostic).toMatch(/update/i);
			expect(
				JSON.parse(await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8")).status,
				diagnostic,
			).not.toBe("complete");
			expect(await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"), diagnostic).toContain(
				"Fixture documentation",
			);
		}
	} finally {
		server.stop(true);
	}
}

describe("omp openwiki generation with a local scripted model", () => {
	it(
		"reports an uncommitted page as partial failure after a real planner tool round trip",
		async () => scenario("partial"),
		120_000,
	);
	it("warns but succeeds when source changes after a committed page", async () => scenario("drift"), 120_000);
});
