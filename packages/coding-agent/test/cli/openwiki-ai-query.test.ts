import { describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const beacon = "OPENWIKI_SESSION_BEACON";
const evidence = "The service requires exactly seven verification cycles.";
type Message = { role: string; content?: unknown; tool_call_id?: string };
type Request = { model: string; stream?: boolean; messages: Message[]; tools?: Array<{ function?: { name: string } }> };
type Reply = { id: string; name: string; args: object } | { text: string };

// This scripted endpoint exercises the local model/tool protocol, not model intelligence.
function response(reply: Reply, stream: boolean): Response {
	const tool = "name" in reply;
	const calls = tool
		? [{ id: reply.id, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }]
		: undefined;
	const finish = tool ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if (!stream) {
		return Response.json({
			id: "local",
			object: "chat.completion",
			created: 0,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					message: tool
						? { role: "assistant", content: null, tool_calls: calls }
						: { role: "assistant", content: reply.text },
					finish_reason: finish,
				},
			],
			usage,
		});
	}
	const delta = tool
		? { role: "assistant", tool_calls: calls?.map(call => ({ index: 0, ...call })) }
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

async function snapshot(directory: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(current: string, relative: string) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const name = path.join(relative, entry.name);
			if (entry.isDirectory()) await visit(path.join(current, entry.name), name);
			else if (entry.isFile()) files[name] = (await readFile(path.join(current, entry.name))).toString("base64");
		}
	}
	await visit(directory, "");
	return files;
}

async function scenario(xdev: boolean) {
	using dir = TempDir.createSync("@omp-openwiki-ai-query-");
	const home = dir.join("home");
	const configRoot = dir.join("config");
	const agent = path.join(configRoot, "profiles", "fixture", "agent");
	const registryDir = path.join(agent, "openwiki");
	const repo = dir.join("current");
	const other = dir.join("service");
	const temp = dir.join("temp");
	await Promise.all([home, agent, registryDir, repo, other, temp].map(p => mkdir(p, { recursive: true })));
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		COMSPEC: process.env.COMSPEC,
		PATHEXT: process.env.PATHEXT,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		TMP: temp,
		TEMP: temp,
		TMPDIR: temp,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		XDG_DATA_HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		OMP_CONFIG_ROOT: configRoot,
		OMP_PROFILE: "fixture",
		OMP_OFFLINE: "1",
		OPENWIKI_CONFIG_DIR: dir.join("standalone"),
		NO_COLOR: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	for (const root of [repo, other]) {
		const git = Bun.spawn(["git", "init", "--quiet"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		const [code, stderr] = await Promise.all([git.exited, new Response(git.stderr).text()]);
		if (code !== 0) throw new Error(`git init failed: ${stderr}`);
		await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
		await writeFile(path.join(root, "openwiki", ".last-update.json"), "{}\n");
		await writeFile(path.join(root, "openwiki", "quickstart.md"), "# Quickstart\n");
		await writeFile(path.join(root, "openwiki", ".claims", "sentinel.json"), '{"untouched":true}\n');
	}
	await mkdir(path.join(other, "openwiki", "architecture"), { recursive: true });
	await writeFile(
		path.join(other, "openwiki", "architecture", "service.md"),
		`---\ntype: guide\ntitle: Service\ndescription: Service operation guide\nsources:\n  - id: source\n    resource: repo://src/service.ts\n---\n\n# Service\n\n## Operation\n\n${beacon} identifies this procedure. ${evidence}\n`,
	);
	const registry = path.join(registryDir, "wiki-workspaces.json");
	await writeFile(
		registry,
		JSON.stringify({
			version: 1,
			wikis: [
				{ id: "current", name: "Current", root: await realpath(repo) },
				{ id: "service", name: "Service", root: await realpath(other) },
			],
			workspaces: [{ id: "shared", name: "Shared", wikis: ["current", "service"] }],
			active: [],
		}),
	);
	const before = await Promise.all([snapshot(repo), snapshot(other), snapshot(registryDir)]);
	const requests: Request[] = [];
	const results: Record<string, string> = {};
	let readArgs: { wiki: string; page: string; sections: string[] } | undefined;
	let scriptError = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname.endsWith("/models")) {
				return Response.json({
					object: "list",
					data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }],
				});
			}
			const body = (await request.json()) as Request;
			requests.push(body);
			for (const message of body.messages) {
				if (message.role === "tool" && message.tool_call_id && typeof message.content === "string") {
					results[message.tool_call_id] = message.content;
				}
			}
			let reply: Reply;
			try {
				if (xdev && results.discover === undefined) {
					reply = { id: "discover", name: "read", args: { path: "xd://" } };
				} else if (results.search === undefined) {
					const args = { query: beacon };
					reply = xdev
						? {
								id: "search",
								name: "write",
								args: { path: "xd://openwiki_search", content: JSON.stringify(args) },
							}
						: { id: "search", name: "openwiki_search", args };
				} else if (results.read === undefined) {
					const found = JSON.parse(results.search) as { results: Array<{ wiki?: string; ref: string[] }> };
					const hit = found.results.find(
						item => item.wiki === "service" && item.ref.some(ref => ref.includes("#")),
					);
					if (!hit) throw new Error(`No service section in search result: ${results.search}`);
					const ref = hit.ref.find(item => item.includes("#"))!;
					const separator = ref.indexOf("#");
					readArgs = { wiki: hit.wiki!, page: ref.slice(0, separator), sections: [ref.slice(separator + 1)] };
					reply = xdev
						? {
								id: "read",
								name: "write",
								args: { path: "xd://openwiki_read", content: JSON.stringify(readArgs) },
							}
						: { id: "read", name: "openwiki_read", args: readArgs };
				} else {
					const found = JSON.parse(results.read) as { sections: Array<{ content: string }> };
					if (!found.sections?.[0]?.content) throw new Error(`No section content: ${results.read}`);
					reply = { text: found.sections[0].content };
				}
			} catch (error) {
				scriptError = String(error);
				reply = { text: `SCRIPT_ERROR: ${scriptError}` };
			}
			return response(reply, body.stream === true);
		},
	});
	try {
		await writeFile(
			path.join(agent, "models.yml"),
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
		await writeFile(
			path.join(agent, "config.yml"),
			`modelRoles:\n  default: fixture/fixture-model\n  smol: fixture/fixture-model\nstartup:\n  setupWizard: false\ntools:\n  xdev: ${xdev}\n`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				cli,
				"--profile",
				"fixture",
				"--print",
				"--no-session",
				"--model",
				"fixture/fixture-model",
				...(xdev ? [] : ["--tools", "read,write"]),
				`Find ${beacon} in the linked workspace and read the matching section.`,
			],
			{
				cwd: repo,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill(), 100_000);
		let code: number, stdout: string, stderr: string;
		try {
			[code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
		} finally {
			clearTimeout(timer);
		}
		const output = stdout + stderr;
		expect(code, output).toBe(0);
		expect(scriptError, output).toBe("");
		expect(requests.length, output).toBeGreaterThanOrEqual(xdev ? 4 : 3);
		const offered = requests.flatMap(request =>
			(request.tools ?? []).map(tool => tool.function?.name).filter(Boolean),
		);
		for (const name of [
			"openwiki_begin",
			"openwiki_submit_plan",
			"openwiki_next_page",
			"openwiki_inspect_page_claims",
			"openwiki_submit_page",
			"openwiki_finish",
		]) {
			expect(offered).not.toContain(name);
			if (xdev) expect(results.discover).not.toContain(`xd://${name}`);
		}
		if (xdev) {
			expect(offered).toContain("read");
			expect(offered).toContain("write");
			expect(results.discover).toContain("openwiki_search");
			expect(results.discover).toContain("openwiki_read");
		} else {
			expect(offered).toContain("openwiki_search");
			expect(offered).toContain("openwiki_read");
		}
		expect(readArgs?.wiki).toBe("service");
		expect(readArgs?.page).toBe("openwiki/architecture/service.md");
		expect(readArgs?.sections).toEqual(["operation"]);
		const search = JSON.parse(results.search) as { results: Array<{ wiki?: string; ref: string[] }> };
		expect(search.results).toContainEqual(
			expect.objectContaining({
				wiki: "service",
				ref: expect.arrayContaining(["openwiki/architecture/service.md#operation"]),
			}),
		);
		const read = JSON.parse(results.read) as { sections: Array<{ content: string }> };
		expect(read.sections[0].content).toContain(`${beacon} identifies this procedure. ${evidence}`);
		expect(stdout).toContain(evidence);
		expect(await Promise.all([snapshot(repo), snapshot(other), snapshot(registryDir)])).toEqual(before);
	} finally {
		server.stop(true);
	}
}

describe("OMP CLI OpenWiki query with a scripted local model", () => {
	it(
		"searches a linked workspace and reads the referenced section in a real conversation",
		async () => scenario(false),
		120_000,
	);
	it("discovers and dispatches the same queries through xdev", async () => scenario(true), 120_000);
});
