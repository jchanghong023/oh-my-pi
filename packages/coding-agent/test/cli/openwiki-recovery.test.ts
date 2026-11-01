import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const alpha = "/openwiki/alpha.md";
const beta = "/openwiki/beta.md";
const quickstart = "/openwiki/quickstart.md";
type Message = { role: string; content?: unknown; tool_call_id?: string };
type Request = { model: string; stream?: boolean; messages: Message[]; tools?: Array<{ function?: { name: string } }> };
type Reply = { name: string; args: object } | { text: string };
type Manifest = {
	pages: Record<
		string,
		{ pageVersion: string; sourceFingerprint?: string; gitHead?: string; completedRunId?: string }
	>;
};
type Run = { proc: Bun.Subprocess<"ignore", "pipe", "pipe">; output: Promise<[number, string, string]> };

function response(reply: Reply, stream: boolean): Response {
	const finish = "name" in reply ? "tool_calls" : "stop";
	const toolCalls =
		"name" in reply
			? [
					{
						id: `call_${reply.name}`,
						type: "function",
						function: { name: reply.name, arguments: JSON.stringify(reply.args) },
					},
				]
			: undefined;
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if (!stream)
		return Response.json({
			id: "local",
			object: "chat.completion",
			created: 0,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					message: toolCalls
						? { role: "assistant", content: null, tool_calls: toolCalls }
						: { role: "assistant", content: "text" in reply ? reply.text : "" },
					finish_reason: finish,
				},
			],
			usage,
		});
	const delta = toolCalls
		? { role: "assistant", tool_calls: [{ index: 0, ...toolCalls[0] }] }
		: { role: "assistant", content: "text" in reply ? reply.text : "" };
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

async function waitFor(run: Run, predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	let stopped = false;
	const checkpoint = async () => {
		while (!stopped && !(await predicate())) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
			await Bun.sleep(50);
		}
	};
	const exited = run.output.then(([code, stdout, stderr]) => {
		throw new Error(`CLI exited before ${description} (exit code ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	});
	try {
		await Promise.race([checkpoint(), exited]);
	} finally {
		stopped = true;
	}
}

async function scenario(interrupt: boolean): Promise<void> {
	using dir = TempDir.createSync("@omp-openwiki-recovery-");
	const root = dir.join("repo");
	const home = dir.join("home");
	const temp = dir.join("tmp");
	const configRoot = dir.join("config");
	const agentDir = path.join(configRoot, "profiles", "fixture", "agent");
	await Promise.all([root, home, temp, agentDir].map(p => mkdir(p, { recursive: true })));
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		APPDATA: path.join(home, "appdata"),
		LOCALAPPDATA: path.join(home, "localappdata"),
		TMP: temp,
		TEMP: temp,
		TMPDIR: temp,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: path.join(home, "empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		OMP_CONFIG_ROOT: configRoot,
		OMP_PROFILE: "fixture",
		OMP_OFFLINE: "1",
		OPENWIKI_CONFIG_DIR: dir.join("standalone"),
		OPENWIKI_PAGE_CONCURRENCY: "2",
		NO_COLOR: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
	async function git(...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
		return out.trim();
	}
	await git("init", "--quiet");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.invalid");
	await writeFile(path.join(root, "alpha.txt"), "Alpha original.\n");
	await writeFile(path.join(root, "beta.txt"), "Beta original.\n");
	await git("add", "alpha.txt", "beta.txt");
	await git("commit", "--quiet", "-m", "initial source");
	const firstHead = await git("rev-parse", "HEAD");
	const manifestPath = path.join(root, "openwiki", ".page-manifest.json");
	const statePath = path.join(root, "openwiki", ".run.json");
	const metadataPath = path.join(root, "openwiki", ".last-update.json");
	const manifest = async (): Promise<Manifest> => JSON.parse(await readFile(manifestPath, "utf8"));
	const pageFile = (page: string) => path.join(root, ...page.slice(1).split("/"));
	const sidecar = (page: string) => path.join(root, "openwiki", ".claims", `${path.basename(page, ".md")}.json`);
	const source = (page: string) => (page === alpha ? "alpha" : "beta");
	const claim = (page: string, updated = false) => ({
		statement: `${source(page) === "alpha" ? "Alpha" : "Beta"} ${updated ? "updated" : "original"}.`,
		evidence: [{ resource: `repo://${source(page)}.txt` }],
	});

	let phase: "initial" | "resume" | "update" = "initial";
	const requests: Array<{ phase: string; page?: string; body: Request }> = [];
	const starts: Array<{ phase: string; page: string }> = [];
	const submissions: Array<{ phase: string; page: string }> = [];
	let quickstartCoverage: string[] = [];
	let betaWritten = false;
	let cancelled = false;
	const { promise: bothStarted, resolve: releaseAlpha } = Promise.withResolvers<void>();
	const { promise: blocked, resolve: releaseBlocked } = Promise.withResolvers<void>();
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
			const tools = new Set((body.tools ?? []).map(tool => tool.function?.name));
			const resultIds = new Set(
				body.messages.filter(message => message.role === "tool").map(message => message.tool_call_id),
			);
			const assignment = JSON.stringify(body.messages).match(/You own exactly (\/openwiki\/[^\s]+\.md)\./u);
			const page = assignment?.[1];
			requests.push({ phase, page, body });
			let reply: Reply = { text: "Finished." };
			if (tools.has("submit_plan") && !resultIds.has("call_submit_plan")) {
				const planPages = phase === "update" ? [alpha] : [quickstart, alpha, beta];
				reply = {
					name: "submit_plan",
					args: {
						pages: planPages.map(p => ({
							path: p,
							title: path.basename(p, ".md"),
							purpose: `Document ${path.basename(p)}`,
							seedPaths: [`${source(p)}.txt`],
						})),
					},
				};
			} else if (tools.has("submit_page") && page) {
				if (!resultIds.has("call_write_file") && !resultIds.has("call_edit_file")) {
					starts.push({ phase, page });
					if (phase === "initial" && page === beta) releaseAlpha();
					if (phase === "initial" && page === alpha) await bothStarted;
					if (page === quickstart)
						quickstartCoverage = existsSync(manifestPath) ? Object.keys((await manifest()).pages) : [];
					const title = path.basename(page, ".md");
					const original = `Original ${title} documentation. ${claim(page).statement}`;
					const text = phase === "update" ? `Updated Alpha source. ${claim(page, true).statement}` : original;
					if (existsSync(pageFile(page))) {
						reply = {
							name: "edit_file",
							args: {
								file_path: page,
								old_string: original,
								new_string:
									phase === "update" ? text : `Recovered ${title} documentation. ${claim(page).statement}`,
							},
						};
					} else {
						reply = {
							name: "write_file",
							args: {
								file_path: page,
								content: `---\ntype: Guide\ntitle: ${title}\ndescription: Fixture page\ntags: [fixture]\n---\n\n# ${title}\n\n${text}\n`,
							},
						};
					}
				} else if (!resultIds.has("call_submit_page")) {
					if (interrupt && phase === "initial" && page === beta) {
						betaWritten = true;
						await blocked;
						if (cancelled) return response({ text: "Cancelled." }, body.stream === true);
					}
					submissions.push({ phase, page });
					const id =
						phase === "update" ? JSON.parse(await readFile(sidecar(page), "utf8")).claims[0].id : undefined;
					reply = {
						name: "submit_page",
						args: { claims: [{ ...claim(page, phase === "update"), ...(id && { id }) }] },
					};
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
		const config =
			"modelRoles:\n  default: fixture/fixture-model\nstartup:\n  setupWizard: false\n  checkUpdate: false\n";
		await writeFile(path.join(agentDir, "config.yml"), config);
		function launch(command: "--init" | "--update") {
			const proc = Bun.spawn(
				[process.execPath, cli, "--profile", "fixture", "openwiki", "code", command, "--language", "en", "--print"],
				{
					cwd: root,
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			return { proc, output };
		}
		async function finish(run: Run) {
			const timer = setTimeout(() => run.proc.kill("SIGKILL"), 100_000);
			try {
				const [code, stdout, stderr] = await run.output;
				return { code, output: stdout + stderr };
			} finally {
				clearTimeout(timer);
			}
		}
		const initial = launch("--init");
		if (interrupt) {
			try {
				await waitFor(
					initial,
					async () => {
						if (!betaWritten || !existsSync(manifestPath) || !existsSync(statePath)) return false;
						const state = JSON.parse(await readFile(statePath, "utf8"));
						return (
							Boolean((await manifest()).pages[alpha]) &&
							requests.some(
								({ page, body }) =>
									page === alpha &&
									body.messages.some(
										message =>
											message.role === "tool" &&
											message.tool_call_id === "call_submit_page" &&
											JSON.parse(message.content as string).status === "complete",
									),
							) &&
							state.plan?.pages.some(
								(job: { path: string; status: string }) => job.path === alpha && job.status === "complete",
							)
						);
					},
					"one committed page and one in-flight unsubmitted page",
				);
				cancelled = true;
				initial.proc.kill("SIGKILL");
			} catch (error) {
				cancelled = true;
				if (initial.proc.exitCode === null && initial.proc.signalCode === null) initial.proc.kill("SIGKILL");
				throw error;
			} finally {
				releaseAlpha();
			}
		}
		const first = await finish(initial);
		const instructions = path.join(root, "openwiki", "INSTRUCTIONS.md");
		expect(await readFile(instructions, "utf8")).toBe("");
		if (interrupt) {
			releaseBlocked();
			expect(first.code, first.output).not.toBe(0);
			const interrupted = JSON.parse(await readFile(statePath, "utf8"));
			expect(interrupted.plan.pages.find((job: { path: string }) => job.path === alpha).status).toBe("complete");
			expect(interrupted.plan.pages.find((job: { path: string }) => job.path === beta).status).not.toBe("complete");
			expect(JSON.parse(await readFile(metadataPath, "utf8")).status).toBe("interrupted");
			expect(await readFile(pageFile(alpha), "utf8")).toContain("Original alpha documentation.");
			expect(JSON.parse(await readFile(sidecar(alpha), "utf8")).claims).toMatchObject([claim(alpha)]);
			const committedEntry = (await manifest()).pages[alpha];
			expect((await manifest()).pages[beta]).toBeUndefined();
			await writeFile(instructions, "Keep my instructions.\n");
			phase = "resume";
			const resumed = await finish(launch("--init"));
			expect(resumed.code, resumed.output).toBe(0);
			expect(await readFile(instructions, "utf8")).toBe("Keep my instructions.\n");
			expect(await readFile(pageFile(alpha), "utf8")).toContain("Original alpha documentation.");
			expect(JSON.parse(await readFile(sidecar(alpha), "utf8")).claims).toMatchObject([claim(alpha)]);
			expect((await manifest()).pages[alpha].completedRunId).toBe(committedEntry.completedRunId);
			expect(starts.filter(event => event.phase === "resume").map(event => event.page)).toEqual([beta, quickstart]);
		} else {
			expect(first.code, first.output).toBe(0);
		}
		expect(
			starts
				.filter(event => event.phase === "initial" && event.page !== quickstart)
				.map(event => event.page)
				.sort(),
		).toEqual([alpha, beta]);
		for (const page of [alpha, beta]) expect(quickstartCoverage).toContain(page);
		expect(starts.filter(event => event.page === quickstart)).toHaveLength(1);
		for (const page of [alpha, beta, quickstart]) {
			expect(submissions.filter(event => event.page === page)).toHaveLength(1);
			const result = requests
				.filter(({ page: requestedPage }) => requestedPage === page)
				.flatMap(({ body }) => body.messages)
				.find(message => message.role === "tool" && message.tool_call_id === "call_submit_page");
			expect(result).toBeDefined();
			expect(JSON.parse(result?.content as string)).toMatchObject({ status: "complete", page });
			expect(await readFile(pageFile(page), "utf8")).toContain("documentation.");
			const claims = JSON.parse(await readFile(sidecar(page), "utf8"));
			expect(claims.claims).toMatchObject([claim(page)]);
			expect(claims.pageVersion).toBe((await manifest()).pages[page].pageVersion);
			expect((await manifest()).pages[page].gitHead).toBe(firstHead);
		}
		expect(existsSync(statePath)).toBe(false);
		expect(JSON.parse(await readFile(metadataPath, "utf8")).status).toBe("complete");
		expect(requests.every(({ body }) => body.model === "fixture-model")).toBe(true);
		expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
		expect(existsSync(dir.join("standalone"))).toBe(false);

		if (interrupt) {
			const before = await manifest();
			const betaPage = await readFile(pageFile(beta), "utf8");
			await writeFile(path.join(root, "alpha.txt"), "Alpha updated.\n");
			await git("add", "alpha.txt");
			await git("commit", "--quiet", "-m", "change alpha");
			const secondHead = await git("rev-parse", "HEAD");
			await unlink(instructions);
			phase = "update";
			const updated = await finish(launch("--update"));
			expect(updated.code, updated.output).toBe(0);
			expect(await readFile(instructions, "utf8")).toBe("");
			expect(starts.filter(event => event.phase === "update").map(event => event.page)).toEqual([alpha]);
			expect(submissions.filter(event => event.phase === "update").map(event => event.page)).toEqual([alpha]);
			expect(await readFile(pageFile(alpha), "utf8")).toContain("Updated Alpha source.");
			expect(await readFile(pageFile(beta), "utf8")).toBe(betaPage);
			const after = await manifest();
			expect(after.pages[alpha].gitHead).toBe(secondHead);
			expect(after.pages[alpha].sourceFingerprint).not.toBe(before.pages[alpha].sourceFingerprint);
			expect(after.pages[alpha].pageVersion).not.toBe(before.pages[alpha].pageVersion);
			expect(after.pages[beta]).toEqual(before.pages[beta]);
			expect(JSON.parse(await readFile(sidecar(alpha), "utf8")).pageVersion).toBe(after.pages[alpha].pageVersion);
			expect(JSON.parse(await readFile(sidecar(alpha), "utf8")).claims).toMatchObject([claim(alpha, true)]);
			const updateResult = requests
				.filter(({ phase: requestPhase, page }) => requestPhase === "update" && page === alpha)
				.flatMap(({ body }) => body.messages)
				.find(message => message.role === "tool" && message.tool_call_id === "call_submit_page");
			expect(updateResult).toBeDefined();
			expect(JSON.parse(updateResult?.content as string)).toMatchObject({ status: "complete", page: alpha });
			expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
				status: "complete",
				command: "update",
				gitHead: secondHead,
			});
			expect(existsSync(statePath)).toBe(false);
		}
	} finally {
		releaseAlpha();
		releaseBlocked();
		server.stop(true);
	}
}

describe("omp openwiki isolated page workers", () => {
	it("runs distinct page jobs concurrently and commits quickstart last", async () => scenario(false), 150_000);
	it(
		"resumes an interrupted page without redoing committed work, then updates changed source",
		async () => scenario(true),
		240_000,
	);
});
