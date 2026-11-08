#!/usr/bin/env bun
/**
 * Explicit release-boundary smoke, intentionally not a *.test.ts daily-gate test.
 * From the repository root:
 *   bun packages/coding-agent/test/fixtures/openwiki-compiled-smoke.ts
 * With no arguments, invokes the existing host binary producer before copying
 * ONLY its fresh executable outside the checkout; never reuses stale dist.
 * For a clean host with no checkout, copy this driver and that executable, then:
 *   bun openwiki-compiled-smoke.ts --binary ./omp.exe --binary-sha256 HASH --skill-sha256 HASH
 * Use the hashes emitted by the fresh build, not hashes from an unrelated binary.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const skillPath = "mermaid-diagrams/SKILL.md";
const validDiagram = "flowchart TD\n  Start --> Finish";
// Unlike the heuristic's reserved-word/label checks, this requires the real parser.
const invalidDiagram = "flowchart TD\n  Start -->";
const page = [
	"---",
	"type: Guide",
	"title: Quickstart",
	"---",
	"",
	"# Quickstart",
	"",
	"The repository README describes stable source.",
	"",
	"```mermaid",
	validDiagram,
	"```",
	"",
	"Deliberately incomplete parser probe:",
	"```mermaid",
	invalidDiagram,
	"```",
	"",
].join("\n");

type Message = { role: string; content?: unknown; tool_call_id?: string };
type Request = {
	model: string;
	stream?: boolean;
	messages: Message[];
	tools?: Array<{ function?: { name: string } }>;
};
type Reply = { name: string; args: object } | { text: string };

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

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 100_000) {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeout);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		assert.equal(timedOut, false, `Timed out: ${command.join(" ")}\n${stdout}${stderr}`);
		return { code, stdout, stderr, output: stdout + stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const args = process.argv.slice(2);
	let produced: string;
	let expectedSkillSha256: string;
	let binarySha256: string;
	const freshBuild = args.length === 0;
	if (freshBuild) {
		// Build explicitly outside the daily gate, including the real resource
		// plugins, stats/viewer generation and native embedding.
		expectedSkillSha256 = new Bun.CryptoHasher("sha256")
			.update(await fsPromises.readFile(path.join(repoRoot, "vendor/openwiki/skills", skillPath)))
			.digest("hex");
		const build = Bun.spawn([process.execPath, path.join(packageDir, "scripts/build-binary.ts")], {
			cwd: repoRoot,
			env: { ...process.env, CROSS_TARGET: "" },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		assert.equal(
			await build.exited,
			0,
			"The current-checkout host binary build must succeed; never reuse stale dist output",
		);
		produced = path.join(packageDir, "dist", process.platform === "win32" ? "omp.exe" : "omp");
		binarySha256 = new Bun.CryptoHasher("sha256").update(await fsPromises.readFile(produced)).digest("hex");
		console.log(
			JSON.stringify({ status: "built-not-yet-smoked", produced, binarySha256, skillSha256: expectedSkillSha256 }),
		);
	} else {
		assert.ok(
			args.length === 6 && args[0] === "--binary" && args[2] === "--binary-sha256" && args[4] === "--skill-sha256",
			"Usage: bun openwiki-compiled-smoke.ts [--binary PATH --binary-sha256 HASH --skill-sha256 HASH]",
		);
		produced = path.resolve(args[1]!);
		binarySha256 = args[3]!;
		expectedSkillSha256 = args[5]!;
		assert.match(binarySha256, /^[0-9a-f]{64}$/);
		assert.match(expectedSkillSha256, /^[0-9a-f]{64}$/);
		assert.equal(
			new Bun.CryptoHasher("sha256").update(await fsPromises.readFile(produced)).digest("hex"),
			binarySha256,
			"Transferred executable must match the fresh producer's recorded digest",
		);
	}
	const temporary = await fsPromises.mkdtemp(path.join(os.tmpdir(), "omp-openwiki-compiled-"));
	let server: Bun.Server<undefined> | undefined;
	try {
		if (freshBuild) {
			const relative = path.relative(repoRoot, temporary);
			assert.ok(
				relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
				"Runtime fixture must live outside the checkout",
			);
		}
		const binary = path.join(temporary, path.basename(produced));
		await fsPromises.copyFile(produced, binary);
		if (process.platform !== "win32") await fsPromises.chmod(binary, 0o755);
		assert.deepEqual(
			await fsPromises.readdir(temporary),
			[path.basename(binary)],
			"Copy no source, dist sidecars, node_modules or standalone OpenWiki installation",
		);
		const root = path.join(temporary, "repo");
		const home = path.join(temporary, "home");
		const configRoot = path.join(temporary, "config");
		const agentDir = path.join(configRoot, "profiles/fixture/agent");
		await Promise.all([root, home, agentDir].map(dir => fsPromises.mkdir(dir, { recursive: true })));
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			TMP: temporary,
			TEMP: temporary,
			TMPDIR: temporary,
			HOME: home,
			USERPROFILE: home,
			XDG_CACHE_HOME: path.join(temporary, "cache"),
			LOCALAPPDATA: path.join(home, "AppData/Local"),
			OMP_CONFIG_ROOT: configRoot,
			OMP_PROFILE: "fixture",
			OMP_OFFLINE: "1",
			OPENWIKI_CONFIG_DIR: path.join(temporary, "standalone"),
			NO_COLOR: "1",
			AWS_EC2_METADATA_DISABLED: "true",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		for (const args of [[], ["--help"]]) {
			const result = await run([binary, "--profile", "fixture", "openwiki", ...args], root, env);
			assert.equal(result.code, 0, result.output);
			assert.ok(result.stdout.includes("OPENWIKI_PAGE_CONCURRENCY to 1–8 (default: 1)"), result.output);
			assert.ok(result.stdout.includes("setenv OPENWIKI_PAGE_CONCURRENCY 4"), result.output);
			assert.ok(
				result.stdout.includes('[Environment]::SetEnvironmentVariable("OPENWIKI_PAGE_CONCURRENCY", "4", "User")'),
				result.output,
			);
			assert.ok(result.stdout.includes("Open a new terminal session"), result.output);
			assert.equal(fs.existsSync(path.join(root, "openwiki")), false, "Help must not start generation");
			assert.equal(fs.existsSync(env.OPENWIKI_CONFIG_DIR!), false, "Help must not initialize standalone OpenWiki");
		}
		for (const args of [
			["init", "--quiet"],
			["config", "user.name", "Fixture"],
			["config", "user.email", "fixture@example.invalid"],
		]) {
			const result = await run(["git", ...args], root, env);
			assert.equal(result.code, 0, result.output);
		}
		await fsPromises.writeFile(path.join(root, "README.md"), "# Fixture\n\nStable source.\n");
		for (const args of [
			["add", "README.md"],
			["commit", "--quiet", "-m", "fixture"],
		]) {
			const result = await run(["git", ...args], root, env);
			assert.equal(result.code, 0, result.output);
		}
		const requests: Request[] = [];
		server = Bun.serve({
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
				if (offered.has("submit_plan") || offered.has("submit_page")) {
					if (!results.has("call_read_file"))
						reply = { name: "read_file", args: { file_path: `/skills/${skillPath}` } };
					else if (offered.has("submit_plan") && !results.has("call_submit_plan"))
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
					else if (offered.has("submit_page") && !results.has("call_write_file"))
						reply = {
							name: "write_file",
							args: { file_path: "/openwiki/quickstart.md", content: page },
						};
					else if (offered.has("submit_page") && !results.has("call_submit_page"))
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
				}
				return response(reply, body.stream === true);
			},
		});
		await fsPromises.writeFile(
			path.join(agentDir, "models.yml"),
			Bun.YAML.stringify({
				providers: {
					deepseek: {
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						api: "openai-completions",
						auth: "none",
						models: [
							{
								id: "fixture-model",
								name: "fixture-model",
								reasoning: false,
								supportsTools: true,
								input: ["text"],
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
		const config = Bun.YAML.stringify({
			modelRoles: { default: "deepseek/fixture-model", plan: "deepseek/fixture-model" },
			startup: { setupWizard: false },
		});
		await fsPromises.writeFile(path.join(agentDir, "config.yml"), config);
		const result = await run(
			[binary, "--profile", "fixture", "openwiki", "code", "--init", "--language", "en", "--print"],
			root,
			env,
		);
		const diagnostic = `${result.output}\nTool results: ${JSON.stringify(
			requests.flatMap(req => req.messages.filter(message => message.role === "tool")),
			null,
			2,
		)}`;
		assert.equal(result.code, 0, diagnostic);
		assert.deepEqual([...new Set(requests.map(req => req.model))], ["fixture-model"], diagnostic);
		for (const stage of ["submit_plan", "submit_page"]) {
			const stageRequests = requests.filter(req => req.tools?.some(tool => tool.function?.name === stage));
			assert.ok(stageRequests.length > 1, `Native ${stage} must make a tool round trip\n${diagnostic}`);
			assert.ok(
				stageRequests.some(req =>
					req.messages.some(
						message =>
							message.role === "tool" &&
							message.tool_call_id === "call_read_file" &&
							typeof message.content === "string" &&
							message.content.includes("# Mermaid Diagrams In Generated Wiki Pages") &&
							message.content.includes("## Syntax safety"),
					),
				),
				`Native ${stage} must read actual bundled Mermaid guidance through its backend\n${diagnostic}`,
			);
			assert.ok(
				stageRequests.some(req =>
					req.messages.some(message => message.role === "tool" && message.tool_call_id === `call_${stage}`),
				),
				diagnostic,
			);
		}
		assert.ok(
			requests.every(req => !req.tools?.some(tool => tool.function?.name === "task")),
			"Use the native planner/page agents, not OMP Task",
		);
		const submitted = requests
			.flatMap(req => req.messages)
			.filter(message => message.role === "tool" && message.tool_call_id === "call_submit_page");
		assert.ok(
			submitted.some(message => {
				if (typeof message.content !== "string") return false;
				try {
					const value = JSON.parse(message.content);
					return value.status === "complete" && value.page === "/openwiki/quickstart.md";
				} catch {
					return false;
				}
			}),
			diagnostic,
		);
		const metadata = JSON.parse(await fsPromises.readFile(path.join(root, "openwiki/.last-update.json"), "utf8"));
		assert.equal(metadata.status, "complete", diagnostic);
		assert.equal(metadata.model, "deepseek/fixture-model", diagnostic);
		const generated = await fsPromises.readFile(path.join(root, "openwiki/quickstart.md"), "utf8");
		assert.ok(generated.includes("The repository README describes stable source."), diagnostic);
		assert.ok(generated.includes(`\`\`\`mermaid\n${validDiagram}\n\`\`\``), generated);
		assert.ok(
			generated.includes(`\`\`\`text\n${invalidDiagram}\n\`\`\``),
			"Real Mermaid parser must reject incomplete edge; heuristic fallback cannot satisfy this assertion\n" +
				generated,
		);
		assert.ok(generated.includes("<!-- openwiki: mermaid parse failed"), generated);
		const resources = path.join(agentDir, "openwiki/resources");
		const versions = (await fsPromises.readdir(resources)).filter(name => !name.startsWith("."));
		assert.equal(versions.length, 1, "One immutable compiled skills bundle must be materialized");
		assert.equal(
			new Bun.CryptoHasher("sha256")
				.update(await fsPromises.readFile(path.join(resources, versions[0]!, "skills", skillPath)))
				.digest("hex"),
			expectedSkillSha256,
			"Compiled skill bytes must equal the fresh producer's real payload",
		);
		assert.equal(await fsPromises.readFile(path.join(agentDir, "config.yml"), "utf8"), config);
		assert.equal(fs.existsSync(env.OPENWIKI_CONFIG_DIR!), false, "No standalone OpenWiki home may be required");
		console.log(
			JSON.stringify(
				{
					status: "passed",
					requirementId: "openwiki:L72",
					input: freshBuild ? "fresh-host-build" : "digest-pinned-transferred-binary",
					producer: "packages/coding-agent/scripts/build-binary.ts",
					binarySha256,
					skillSha256: expectedSkillSha256,
					cases: [
						"compiled help and no-argument help without standalone home",
						"compiled native planner and page read bundled Mermaid skill and persist completion",
						"compiled authoritative Mermaid parser preserves valid diagram and degrades non-heuristic syntax error",
					],
				},
				null,
				2,
			),
		);
	} finally {
		server?.stop(true);
		await fsPromises.rm(temporary, { recursive: true, force: true });
	}
}

await main();
