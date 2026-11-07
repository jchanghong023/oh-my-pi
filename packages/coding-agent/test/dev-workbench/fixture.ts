import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { Browser, Page } from "puppeteer-core";
import { startIntranetRelay } from "../../src/collab/relay-server";
import "../../src/dev-workbench/host";
import "../../src/dev-workbench/assets";
import "../../src/tools";
import type {
	DevActionIntent,
	DevActionPreview,
	DevActionResult,
	DevGitTarget,
	DevRequirementSnapshot,
	DevStage,
} from "../../src/spec-driven/types";
import {
	chromiumExecutableProbeForTest,
	closeLaunchedBrowser,
	loadPuppeteer,
	systemChromiumCandidatesForTest,
} from "../../src/tools/browser/launch";
import {
	contentText,
	continuationText,
	createProviderFixture,
	rolePayload,
	type ModelRequest,
	type ProviderFixture,
	type ProviderScenario,
	type Reply,
} from "../spec-driven/provider-fixture";
import { compileFakeExecutable } from "../helpers/fake-executable";

export const SOURCE_ENTRY = path.resolve(import.meta.dir, "../../src/cli.ts");
export const BUSINESS = `# 业务需求：Greeting\n\n${["基本信息", "业务背景与目标", "实际使用场景与现状", "期望结果", "业务规则与边界", "典型例子", "业务验收预期", "待确认事项", "资料来源", "业务确认与交接"].map(title => `## ${title}\n\nProvide greet(name), trim outer whitespace, default empty names to world and preserve internal whitespace.\n`).join("\n")}`;

export interface WorkbenchScenario extends ProviderScenario {
	model?: { provider: string; id: string };
	reply?: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
	setup?: (cwd: string, agentDir: string) => Promise<void>;
}

export async function resolveInstalledDevChromium(): Promise<string> {
	const explicit = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
	const candidates = explicit ? [explicit] : systemChromiumCandidatesForTest();
	for (const candidate of candidates) {
		if (
			(await fs.stat(candidate).then(
				stat => stat.isFile(),
				() => false,
			)) &&
			(await chromiumExecutableProbeForTest(candidate))
		)
			return candidate;
	}
	throw new Error(
		explicit
			? `PUPPETEER_EXECUTABLE_PATH is not executable Chromium: ${explicit}`
			: "Dev workbench acceptance requires an already installed Chromium; no browser will be downloaded",
	);
}

export async function initializeRepository(directory: string, bare = false, branch = "main"): Promise<void> {
	const gitDir = bare ? directory : path.join(directory, ".git");
	for (const child of ["objects", "refs/heads", "refs/tags"])
		await fs.mkdir(path.join(gitDir, child), { recursive: true });
	await fs.writeFile(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	await fs.writeFile(
		path.join(gitDir, "config"),
		`[core]\nrepositoryformatversion = 0\nbare = ${bare}\nautocrlf = false\nhooksPath = ${JSON.stringify(path.join(gitDir, "hooks").replaceAll("\\", "/"))}\n[user]\nname = OMP Acceptance\nemail = omp-acceptance@example.invalid\n[commit]\ngpgsign = false\n`,
	);
}

export async function eventually<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeout = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (predicate(value)) return value;
		if (Date.now() >= deadline) throw new Error(`Public workbench state did not settle: ${JSON.stringify(value)}`);
		await Bun.sleep(25);
	}
}

const pendingRelays = new Set<IsolatedRelay>();
class IsolatedRelay {
	readonly child: Subprocess<"ignore", "pipe", "pipe">;
	readonly ready: Promise<void>;
	url = "";
	#pump: Promise<void>;
	#stderr: Promise<void>;
	#diagnostics = "";
	#stopping?: Promise<void>;
	#failure?: Error;
	constructor(cwd: string, env: NodeJS.ProcessEnv) {
		const ready = Promise.withResolvers<void>();
		this.ready = ready.promise;
		const child = Bun.spawn([process.execPath, import.meta.path, "--relay-fixture"], {
			cwd,
			env: { ...env, OMP_OFFLINE: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child = child;
		pendingRelays.add(this);
		const stderr = (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of child.stderr) this.#diagnostics += decoder.decode(bytes, { stream: true });
			this.#diagnostics += decoder.decode();
		})();
		this.#stderr = stderr;
		this.#pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame) || frame.kind !== "relay-ready" || typeof frame.url !== "string")
						throw new Error("Invalid isolated Relay readiness frame");
					const url = new URL(frame.url);
					if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1")
						throw new Error("Relay did not bind its isolated loopback endpoint");
					this.url = frame.url;
					ready.resolve();
				}
				if (!this.url) {
					await stderr;
					throw new Error(`Isolated offline Relay exited before readiness: ${this.#diagnostics}`);
				}
			} catch (error) {
				this.#failure = error instanceof Error ? error : new Error(String(error));
				ready.reject(this.#failure);
			}
		})();
	}
	stop(): Promise<void> {
		return (this.#stopping ??= (async () => {
			if (this.child.exitCode === null) this.child.kill("SIGTERM");
			await this.child.exited;
			try {
				await Promise.all([this.#pump, this.#stderr]);
				if (this.#failure) throw this.#failure;
			} finally {
				pendingRelays.delete(this);
			}
		})());
	}
}

export class WorkbenchProcess {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	#output = "";
	#changed = Promise.withResolvers<void>();
	#pumps: Promise<void>[];
	#closed = false;
	cookie = "";
	constructor(
		readonly cwd: string,
		readonly env: NodeJS.ProcessEnv,
		launch: string[] = [process.execPath, SOURCE_ENTRY],
		args: string[] = [],
	) {
		this.child = Bun.spawn([...launch, "dev", ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.#pumps = [this.child.stdout, this.child.stderr].map(async stream => {
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				this.#output += decoder.decode(chunk, { stream: true });
				const pending = this.#changed;
				this.#changed = Promise.withResolvers<void>();
				pending.resolve();
			}
		});
		void this.child.exited.then(() => this.#changed.resolve());
	}
	get output(): string {
		return this.#output;
	}
	async ready(): Promise<string> {
		const deadline = AbortSignal.timeout(60_000);
		for (;;) {
			const url = /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s\x1b<>"']*/u.exec(Bun.stripANSI(this.#output))?.[0];
			if (url) {
				const base = url.endsWith("/") ? url : `${url}/`;
				const browser = await fetch(new URL("api/browser", base), { signal: deadline });
				if (!browser.ok) throw new Error(`Workbench browser bootstrap failed: ${browser.status}`);
				this.cookie = browser.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
				if (!this.cookie) throw new Error("Workbench did not allocate its native browser identity");
				const response = await fetch(new URL("api/requirements", base), {
					headers: { cookie: this.cookie },
					signal: deadline,
				});
				if (!response.ok)
					throw new Error(`Printed workbench URL is not ready (${response.status}): ${this.#output}`);
				return base;
			}
			if (this.child.exitCode !== null)
				throw new Error(`OMP dev exited ${this.child.exitCode} before readiness: ${this.#output}`);
			await Promise.race([
				this.#changed.promise,
				new Promise<never>((_, reject) =>
					deadline.addEventListener("abort", () => reject(new Error(`OMP dev ready timeout: ${this.#output}`)), {
						once: true,
					}),
				),
			]);
		}
	}
	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
		await this.child.exited;
		await Promise.all(this.#pumps);
	}
}

const ownedWorkbenches = new Set<WorkbenchFixture>();
export async function closePublicWorkbenches(): Promise<void> {
	const results = await Promise.allSettled([
		...[...ownedWorkbenches].map(fixture => fixture.close()),
		...[...pendingRelays].map(relay => relay.stop()),
	]);
	const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
	if (failures.length) throw new AggregateError(failures, "Public fixture cleanup failed");
}

export class WorkbenchFixture {
	readonly processes = new Set<WorkbenchProcess>();
	readonly browsers = new Set<Browser>();
	readonly #launches = new Set<AbortController>();
	url = "";
	#closing?: Promise<void>;
	#cookie = "";
	#forgeClose?: () => Promise<void>;
	#mergeForge?: () => Promise<void>;
	readonly forgeRequests: string[][] = [];
	private constructor(
		readonly root: TempDir,
		readonly cwd: string,
		readonly env: NodeJS.ProcessEnv,
		readonly provider: ProviderFixture,
		readonly relay: IsolatedRelay,
	) {}
	static async create(scenario: WorkbenchScenario = {}): Promise<WorkbenchFixture> {
		const root = await TempDir.create("@omp-workbench-public-");
		let provider: ProviderFixture;
		try {
			provider = createProviderFixture(scenario);
		} catch (error) {
			await root[Symbol.asyncDispose]();
			throw error;
		}
		const cwd = root.join("project");
		const home = root.join("home");
		const config = root.join("config");
		const data = root.join("home/AppData/Local");
		const cache = root.join("cache");
		const temp = root.join("tmp");
		const agent = path.join(config, "agent");
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			ProgramFiles: process.env.ProgramFiles,
			HOME: home,
			USERPROFILE: home,
			APPDATA: config,
			LOCALAPPDATA: data,
			XDG_CONFIG_HOME: config,
			XDG_DATA_HOME: data,
			XDG_CACHE_HOME: cache,
			TEMP: temp,
			TMP: temp,
			TMPDIR: temp,
			OMP_CONFIG_ROOT: config,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: ".omp",
			OMP_PROFILE: "default",
			PI_PROFILE: "",
			OMP_OFFLINE: "1",
			OMP_DEV_NO_OPEN: "1",
			PI_NO_TITLE: "1",
			NO_PROXY: "127.0.0.1,localhost",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: root.join("gitconfig"),
			GIT_CONFIG_COUNT: "0",
			GIT_TERMINAL_PROMPT: "0",
			DO_NOT_TRACK: "1",
			OPENSPEC_TELEMETRY: "0",
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
		};
		try {
			await Promise.all(
				[cwd, home, config, data, cache, temp, agent].map(directory => fs.mkdir(directory, { recursive: true })),
			);
		} catch (error) {
			await provider[Symbol.asyncDispose]();
			await root[Symbol.asyncDispose]();
			throw error;
		}
		const relay = new IsolatedRelay(root.path(), env);
		try {
			await relay.ready;
		} catch (error) {
			try {
				await relay.stop();
			} finally {
				await provider[Symbol.asyncDispose]();
				await root[Symbol.asyncDispose]();
			}
			throw error;
		}
		env.OMP_COLLAB_RELAY_URL = relay.url;
		const fixture = new WorkbenchFixture(root, cwd, env, provider, relay);
		ownedWorkbenches.add(fixture);
		try {
			await fs.writeFile(env.GIT_CONFIG_GLOBAL!, "");
			const model = scenario.model ?? { provider: "deepseek", id: "deepseek-v4-flash" };
			const modelRoles = (
				scenario.model ? ["default", "smol", "slow", "plan", "vision", "task", "advisor"] : ["default", "smol"]
			)
				.map(role => `  ${role}: ${model.provider}/${model.id}`)
				.join("\n");
			await fs.writeFile(
				path.join(agent, "models.yml"),
				`providers:\n  ${model.provider}:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: ${model.id}\n        reasoning: false\n        input: [text, image]\n        contextWindow: 200000\n`,
			);
			await fs.writeFile(
				path.join(agent, "config.yml"),
				`startup:\n  setupWizard: false\ncomposer:\n  predictions: false\ncollab:\n  relayUrl: ${relay.url}\nmodelRoles:\n${modelRoles}\nasync:\n  enabled: false\n`,
			);
			await initializeRepository(cwd, false, "development");
			await initializeRepository(root.join("remote.git"), true);
			const repo = requireGit(cwd);
			await fs.writeFile(path.join(cwd, "baseline.txt"), "Original user bytes\n");
			await fs.writeFile(path.join(cwd, ".gitignore"), ".omp/\n");
			await repo.stageFiles(["baseline.txt", ".gitignore"]);
			await repo.commitCreate("Acceptance baseline", {});
			await repo.remoteAdd("origin", root.join("remote.git"));
			await repo.push({ remote: "origin", refspec: "refs/heads/development:refs/heads/main" });
			await repo.push({ remote: "origin", refspec: "refs/heads/development:refs/heads/development" });
			await repo.configSet("branch.development.remote", "origin");
			await repo.configSet("branch.development.merge", "refs/heads/main");
			await scenario.setup?.(cwd, agent);
			return fixture;
		} catch (error) {
			await fixture.close();
			throw error;
		}
	}
	async start(launch?: string[], args?: string[]): Promise<WorkbenchProcess> {
		const process = new WorkbenchProcess(this.cwd, this.env, launch, args);
		this.processes.add(process);
		this.url = await process.ready();
		this.#cookie = process.cookie;
		return process;
	}
	nativeDiagnostics(role?: string): unknown {
		const requests = role
			? this.provider.requests.filter(request => rolePayload(request)?.specDrivenRole === role)
			: this.provider.requests;
		const native = requests.slice(-3).map(request => {
			const payload = rolePayload(request);
			return {
				role: payload?.specDrivenRole,
				entry: payload?.input.entry,
				readOnly: payload?.input.readOnly,
				outputPaths: payload?.input.outputPaths,
				continuation: continuationText(request),
				advertisedTools: request.tools
					?.filter(tool => ["ask", "read", "write"].includes(tool.function?.name.replace(/^_/u, "") ?? ""))
					.map(tool => tool.function),
				toolCalls: request.messages.flatMap(message => message.tool_calls ?? []).slice(-3),
				recentMessages: request.messages.slice(-8).map(message => ({
					role: message.role,
					toolCallId: message.tool_call_id,
					content: contentText(message.content).slice(-4_000),
				})),
			};
		});
		return { failures: this.provider.failures, native };
	}
	async request<T>(route: string, body?: unknown): Promise<T> {
		const response = await this.response(route, body);
		if (!response.ok) {
			throw new Error(
				`${route}: HTTP ${response.status}: ${await response.text()}\nNative fixture facts: ${JSON.stringify(this.nativeDiagnostics())}`,
			);
		}
		return (await response.json()) as T;
	}
	response(route: string, body?: unknown): Promise<Response> {
		return fetch(new URL(`api/${route}`, this.url), {
			method: body === undefined ? "GET" : "POST",
			headers: { cookie: this.#cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
	}
	list(): Promise<DevRequirementSnapshot[]> {
		return this.request("requirements");
	}
	get(id: string): Promise<DevRequirementSnapshot> {
		return this.request(`requirements/${encodeURIComponent(id)}`);
	}
	async create(): Promise<DevRequirementSnapshot> {
		return this.request("requirements", { source: "import" });
	}
	async upload(id: string, content = BUSINESS, name = "business.md"): Promise<Response> {
		const data = new FormData();
		data.append("file", new File([content], name, { type: "text/markdown" }));
		return fetch(new URL(`api/business/${encodeURIComponent(id)}`, this.url), {
			method: "POST",
			headers: { cookie: this.#cookie },
			body: data,
		});
	}
	async preview(
		snapshot: DevRequirementSnapshot,
		intent: DevActionIntent,
		gitTarget: DevGitTarget | null = null,
	): Promise<DevActionPreview> {
		return this.request("action-preview", {
			requirementId: snapshot.record.requirementId,
			expectedRecordVersion: snapshot.recordVersion,
			expectedStage: snapshot.record.stage,
			intent,
			gitTarget,
		});
	}
	confirm(
		preview: DevActionPreview,
		userReply = "I confirm the displayed materials and exact scope",
	): Promise<DevActionResult> {
		return this.request("actions", {
			operationId: preview.action.binding.operationId,
			confirmationToken: preview.confirmationToken,
			userReply,
		});
	}
	async act(
		snapshot: DevRequirementSnapshot,
		intent: DevActionIntent,
		target: DevGitTarget | null = null,
	): Promise<DevActionResult> {
		return this.confirm(await this.preview(snapshot, intent, target));
	}
	async stage(id: string, stage: DevStage): Promise<DevRequirementSnapshot> {
		return eventually(
			() => this.get(id),
			value => {
				if (
					value.record.stage !== stage ||
					(value.runtime && ["running", "waiting", "stopping"].includes(value.runtime.execution))
				)
					return false;
				if (
					stage !== "solution" ||
					value.runtime?.execution === "failed" ||
					value.runtime?.execution === "interrupted"
				)
					return true;
				// Native agent_end can report idle before solution validation and provenance are persisted.
				const solution = value.record.materials.find(material => material.kind === "solution");
				return Boolean(solution && value.record.solutionBasis?.solutionVersion === solution.version);
			},
		);
	}
	async imported(): Promise<DevRequirementSnapshot> {
		const snapshot = await this.create();
		const response = await this.upload(snapshot.record.requirementId);
		if (!response.ok) throw new Error(`Business import failed: ${await response.text()}`);
		return this.get(snapshot.record.requirementId);
	}
	async developUntil(stage: DevStage, initial?: DevRequirementSnapshot): Promise<DevRequirementSnapshot> {
		let snapshot = initial ?? (await this.imported());
		const stages: DevStage[] = ["business", "requirements", "solution", "planning", "executing", "st"];
		while (snapshot.record.stage !== stage) {
			const current = snapshot.record.stage;
			const index = stages.indexOf(current);
			if (index < 0 || index >= stages.length - 1) throw new Error(`Cannot advance ${current} with Next`);
			await this.act(snapshot, current === "solution" ? { kind: "next", candidateId: "pure" } : { kind: "next" });
			snapshot = await this.stage(snapshot.record.requirementId, stages[index + 1]!);
		}
		return snapshot;
	}
	/** A localhost Forge consumer, reached only through the existing real gh runner. */
	async installLocalForge(): Promise<void> {
		if (this.#forgeClose) throw new Error("Local Forge already installed");
		interface Pull {
			number: number;
			body: string;
			repository: string;
			merged: boolean;
			closed: boolean;
			mergeSha: string | null;
		}
		const pulls: Pull[] = [];
		let latest: Pull | null = null;
		const repo = requireGit(this.cwd);
		const git = Bun.which("git");
		if (!git) throw new Error("Local Forge acceptance requires the installed Git executable");
		await fs.appendFile(this.root.join("remote.git/config"), "\n[http]\n\treceivepack = true\n");
		let forgeUrl = "";
		const fact = async (pull: Pull) => {
			const head = pull.merged ? pull.mergeSha : (await repo.remoteRef("origin", "refs/heads/development")).sha;
			const base = (await repo.remoteRef("origin", "refs/heads/main")).sha;
			if (!head || !base) throw new Error("Local Forge refs are unavailable");
			return {
				number: pull.number,
				html_url: `${forgeUrl}pull/${pull.number}`,
				state: pull.closed || pull.merged ? "closed" : "open",
				merged: pull.merged,
				merge_commit_sha: pull.mergeSha,
				body: pull.body,
				head: { ref: "development", sha: head, repo: { full_name: pull.repository } },
				base: { ref: "main", sha: base },
			};
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				try {
					const url = new URL(request.url);
					if (url.pathname.startsWith("/fixture/repo.git/")) {
						const input = new Uint8Array(await request.arrayBuffer());
						const child = Bun.spawn([git, "http-backend"], {
							cwd: this.root.path(),
							env: {
								...this.env,
								GIT_PROJECT_ROOT: this.root.path(),
								GIT_HTTP_EXPORT_ALL: "1",
								PATH_INFO: url.pathname.replace("/fixture/repo.git", "/remote.git"),
								QUERY_STRING: url.search.slice(1),
								REQUEST_METHOD: request.method,
								CONTENT_TYPE: request.headers.get("content-type") ?? "",
								CONTENT_LENGTH: String(input.byteLength),
								HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
								HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
								REMOTE_ADDR: "127.0.0.1",
							},
							stdin: "pipe",
							stdout: "pipe",
							stderr: "pipe",
						});
						child.stdin.write(input);
						child.stdin.end();
						const [bytes, stderr, code] = await Promise.all([
							new Response(child.stdout).arrayBuffer(),
							new Response(child.stderr).text(),
							child.exited,
						]);
						if (code !== 0) throw new Error(`Local Git HTTP backend failed (${code}): ${stderr}`);
						const output = Buffer.from(bytes);
						const separator = output.indexOf("\r\n\r\n");
						if (separator < 0) throw new Error(`Local Git HTTP backend returned invalid CGI headers: ${stderr}`);
						const headers = new Headers();
						let status = 200;
						for (const line of output.subarray(0, separator).toString("utf8").split("\r\n")) {
							const colon = line.indexOf(":");
							if (colon < 0) throw new Error(`Invalid local Git HTTP header: ${line}`);
							const name = line.slice(0, colon);
							const value = line.slice(colon + 1).trim();
							if (name.toLowerCase() === "status") status = Number(value.split(" ", 1)[0]);
							else headers.append(name, value);
						}
						return new Response(output.subarray(separator + 4), { status, headers });
					}
					const args = (await request.json()) as string[];
					if (!Array.isArray(args) || args.some(value => typeof value !== "string") || args[0] !== "api")
						return new Response("Invalid local Forge invocation", { status: 400 });
					this.forgeRequests.push(args);
					const endpoint = args[args.indexOf("--hostname") + 2];
					if (!endpoint?.startsWith("repos/")) return new Response("Unsupported local Forge API", { status: 404 });
					const project = endpoint.slice("repos/".length).split("/pulls", 1)[0]!;
					if (!endpoint.includes("/pulls")) return Response.json({ full_name: project });
					const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
					if (method === "POST") {
						const body = args.find(value => value.startsWith("body="))?.slice("body=".length);
						if (!body?.includes("<!-- omp-requirement:"))
							return new Response("PR requires actual requirement ownership", { status: 400 });
						latest = {
							number: pulls.length + 1,
							body,
							repository: project,
							merged: false,
							closed: false,
							mergeSha: null,
						};
						pulls.push(latest);
						return Response.json(await fact(latest));
					}
					const number = Number(/\/pulls\/(\d+)$/.exec(endpoint)?.[1]);
					const pull = pulls.find(pull => pull.number === number);
					if (method === "PATCH") {
						if (!pull || pull.merged) return new Response("Cannot close merged or missing PR", { status: 409 });
						pull.closed = true;
						return Response.json(await fact(pull));
					}
					if (endpoint.includes("?")) return Response.json(await Promise.all(pulls.map(pull => fact(pull))));
					if (!pull) return new Response("PR not found", { status: 404 });
					return Response.json(await fact(pull));
				} catch (error) {
					return new Response(String(error), { status: 500 });
				}
			},
		});
		forgeUrl = server.url.toString();
		this.#forgeClose = async () => {
			await server.stop(true);
		};
		await repo.configSet("remote.origin.url", new URL("fixture/repo.git", server.url).href);
		this.#mergeForge = async () => {
			if (!latest || latest.closed || latest.merged) throw new Error("There is no open local PR to merge");
			await repo.push({ remote: "origin", refspec: "refs/heads/development:refs/heads/main" });
			latest.merged = true;
			latest.mergeSha = (await repo.remoteRef("origin", "refs/heads/main")).sha;
		};
		const bin = this.root.join("forge-bin");
		await fs.mkdir(bin);
		await compileFakeExecutable(
			bin,
			"gh",
			[
				`const response = await fetch(process.env.OMP_TEST_FORGE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(process.argv.slice(2)) });`,
				`const text = await response.text();`,
				`if (!response.ok) { console.error(text); process.exit(1); }`,
				`process.stdout.write(text);`,
			].join("\n"),
		);
		this.env.PATH = `${bin}${path.delimiter}${this.env.PATH ?? ""}`;
		this.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
		this.env.OMP_TEST_FORGE_URL = server.url.toString();
	}
	async mergeLocalPr(): Promise<void> {
		if (!this.#mergeForge) throw new Error("Local Forge is not installed");
		await this.#mergeForge();
	}
	async browser(): Promise<{ browser: Browser; page: Page }> {
		const executablePath = await resolveInstalledDevChromium();
		const puppeteer = await loadPuppeteer();
		const abort = new AbortController();
		this.#launches.add(abort);
		let browser: Browser;
		try {
			browser = await puppeteer.launch({
				executablePath,
				signal: abort.signal,
				headless: true,
				userDataDir: this.root.join(`chromium-${this.browsers.size}`),
				env: { ...this.env, PUPPETEER_EXECUTABLE_PATH: executablePath },
				pipe: false,
				args: [
					"--remote-debugging-port=0",
					"--remote-debugging-address=127.0.0.1",
					"--no-sandbox",
					"--disable-dev-shm-usage",
					"--disable-background-networking",
					"--no-first-run",
					"--no-default-browser-check",
				],
			});
		} finally {
			this.#launches.delete(abort);
		}
		if (this.#closing) {
			await closeLaunchedBrowser(browser);
			throw new Error("Workbench fixture closed while Chromium launched");
		}
		this.browsers.add(browser);
		const page = await browser.newPage();
		await page.setViewport({ width: 1440, height: 900 });
		await page.goto(this.url, { waitUntil: "domcontentloaded" });
		return { browser, page };
	}
	close(): Promise<void> {
		return (this.#closing ??= (async () => {
			for (const abort of this.#launches) abort.abort();
			const failures: unknown[] = [];
			for (const result of await Promise.allSettled(
				[...this.browsers].map(browser => closeLaunchedBrowser(browser)),
			))
				if (result.status === "rejected") failures.push(result.reason);
			for (const result of await Promise.allSettled(
				[...this.processes].map(process => process[Symbol.asyncDispose]()),
			))
				if (result.status === "rejected") failures.push(result.reason);
			for (const cleanup of [
				() => this.relay.stop(),
				() => this.#forgeClose?.(),
				() => this.provider[Symbol.asyncDispose](),
				() => this.root[Symbol.asyncDispose](),
			]) {
				try {
					await cleanup();
				} catch (error) {
					failures.push(error);
				}
			}
			ownedWorkbenches.delete(this);
			if (failures.length) throw new AggregateError(failures, "Public workbench resources did not close cleanly");
		})());
	}
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

if (import.meta.main) {
	if (Bun.argv[2] !== "--relay-fixture") throw new Error("This fixture entry only starts an isolated offline Relay");
	const stopped = Promise.withResolvers<void>();
	const shutdown = () => stopped.resolve();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	const relay = startIntranetRelay({ hostname: "127.0.0.1", port: 0 });
	try {
		process.stdout.write(`${JSON.stringify({ kind: "relay-ready", url: relay.url })}\n`);
		await stopped.promise;
	} finally {
		relay.stop();
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
	}
}
