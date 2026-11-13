import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AIReqWorkflowCommand,
	AIReqWorkflowResult,
	AIReqWorkflowView,
} from "../../src/aireq-workbench/workflow-types";
import {
	createProviderFixture,
	contentText,
	type ModelRequest,
	type Reply,
	type ProviderFixture,
} from "../spec-driven/provider-fixture";
import type { Browser } from "puppeteer-core";
import { launchHeadlessBrowser, closeLaunchedBrowser, removeUserDataDir } from "../../src/tools/browser/launch";

export const WORKFLOW_ENTRY = path.resolve(import.meta.dir, "../../src/cli.ts");
export const WORKFLOW_MODEL = "deepseek/deepseek-v4-flash";
// Keep the synthetic image model in an admitted provider without overriding a bundled model's capabilities.
export const WORKFLOW_VISION_MODEL = "deepseek/omp-native-vision-fixture";
export const WORKFLOW_ROLES = ["default", "smol", "slow", "plan", "vision", "task", "advisor"] as const;
export const WORKFLOW_BUSINESS =
	"Implement acceptanceGreeting(name) in a new isolated acceptance directory. Trim outer whitespace; empty input means world; preserve internal whitespace. Return Hello, <name>!. Include a real unit test and a separate CLI system test, with commands, actual exit codes and output in separate UT and ST reports. No networking or unrelated application changes. One IR and exactly one complete SR. The title must describe greeting behavior. These are confirmed business decisions; do not infer extra scope. Stop interviewing and write the complete requirements; stopping is not approval.";

export function workflowRedactor(secrets: string[] = []): (text: string) => string {
	return text => {
		let result = text;
		for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
			result = result.replaceAll(secret, "[REDACTED]");
		return result
			.replace(/(https?:\/\/(?:127\.0\.0\.1|localhost):\d+)\/[^\s<>"']+/gu, "$1/[CAPABILITY]")
			.replace(/((?:authorization|api[-_]?key|cookie|token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"}]+/giu, "$1[REDACTED]");
	};
}

export function isolatedWorkflowEnvironment(root: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of [
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"LANG",
		"LC_ALL",
		"TERM",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	])
		if (process.env[name]) env[name] = process.env[name]!;
	return {
		...env,
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		APPDATA: path.join(root, "appdata"),
		LOCALAPPDATA: path.join(root, "localappdata"),
		TEMP: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TMPDIR: path.join(root, "tmp"),
		OMP_CONFIG_ROOT: path.join(root, "config"),
		OMP_PROFILE: "acceptance",
		OMP_AIREQ_NO_OPEN: "1",
		GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		NO_PROXY: "127.0.0.1,localhost",
		DO_NOT_TRACK: "1",
		OPENSPEC_TELEMETRY: "0",
		PUPPETEER_SKIP_DOWNLOAD: "true",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
	};
}

export async function writeWorkflowProfile(
	root: string,
	model: string,
	baseUrl?: string,
	input: ("text" | "image")[] = ["text"],
): Promise<void> {
	const agent = path.join(root, "config/profiles/acceptance/agent");
	const separator = model.indexOf("/");
	const providerId = model.slice(0, separator);
	const modelId = model.slice(separator + 1);
	await Promise.all(
		[agent, ...["home", "appdata", "localappdata", "tmp"].map(name => path.join(root, name))].map(directory =>
			fs.mkdir(directory, { recursive: true }),
		),
	);
	await fs.writeFile(path.join(root, "gitconfig"), "");
	await fs.writeFile(
		path.join(agent, "config.yml"),
		`enabledProviders:\n  - ${providerId}\nenabledModels:\n  - ${model}\nmodelRoles:\n${WORKFLOW_ROLES.map(role => `  ${role}: ${model}\n`).join("")}retry:\n  modelFallback: false\nstartup:\n  setupWizard: false\ncomposer:\n  predictions: false\ntools:\n  approval:\n    write: allow\n`,
	);
	if (baseUrl)
		await fs.writeFile(
			path.join(agent, "models.yml"),
			`providers:\n  ${JSON.stringify(providerId)}:\n    baseUrl: ${JSON.stringify(baseUrl)}\n    auth: none\n    api: openai-completions\n    models:\n      - id: ${JSON.stringify(modelId)}\n        reasoning: false\n        input: ${JSON.stringify(input)}\n        contextWindow: 200000\n`,
		);
}

/** No shell, no credentials in arguments, and no command output discarded. */
export async function workflowGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const child = Bun.spawn(
		[
			"git",
			"-c",
			"user.name=OMP AIReq Acceptance",
			"-c",
			"user.email=aireq-acceptance@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Git ${args[0]} exited ${code}\n${stdout}\n${stderr}`);
	return stdout.trim();
}

export async function pollWorkflow<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
	label: string,
	timeout = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await read();
		if (accept(last)) return last;
		await Bun.sleep(100);
	}
	throw new Error(`${label} timed out; last observation=${workflowRedactor()(JSON.stringify(last))}`);
}

export class WorkflowConsumerProcess {
	readonly child: Subprocess<"pipe", "pipe", "pipe">;
	readonly pumps: Promise<void>[];
	#stdout = "";
	#stderr = "";
	url = "";
	cookie = "";
	readonly clientId = crypto.randomUUID();
	constructor(
		readonly cwd: string,
		readonly env: Record<string, string>,
		readonly redact = workflowRedactor(),
		launch: string[] = [process.execPath, WORKFLOW_ENTRY],
		args: string[] = ["--profile", "acceptance", "aireq", "--cwd", cwd],
	) {
		this.child = Bun.spawn([...launch, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.pumps = [this.child.stdout, this.child.stderr].map((stream, index) =>
			(async () => {
				const decoder = new TextDecoder();
				for await (const chunk of stream) {
					const text = decoder.decode(chunk, { stream: true });
					if (index === 0) this.#stdout += text;
					else this.#stderr += text;
				}
			})(),
		);
	}
	get logs(): { stdout: string; stderr: string } {
		return { stdout: this.redact(this.#stdout), stderr: this.redact(this.#stderr) };
	}
	async ready(): Promise<string> {
		this.url = await pollWorkflow(
			async () => {
				if (this.child.exitCode !== null)
					throw new Error(`AIReq exited ${this.child.exitCode}: ${JSON.stringify(this.logs)}`);
				return (
					Bun.stripANSI(this.#stdout).match(
						/AIReq workbench ready:\s*(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s\x1b<>"']+)\r?\n/u,
					)?.[1] ?? ""
				);
			},
			Boolean,
			"Public AIReq capability URL",
		);
		if (!this.url.endsWith("/")) this.url += "/";
		const bootstrap = await fetch(new URL("api/browser", this.url), { headers: { "X-AIReq-Client": this.clientId } });
		if (!bootstrap.ok) throw new Error(`Public browser bootstrap failed: ${bootstrap.status}`);
		this.cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		await this.view();
		return this.url;
	}
	async request(endpoint: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers({ cookie: this.cookie, "X-AIReq-Client": this.clientId });
		for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
		return fetch(new URL(endpoint, this.url), {
			...init,
			headers,
			signal: init.signal ?? AbortSignal.timeout(60_000),
		});
	}
	async view(projectId?: string): Promise<AIReqWorkflowView> {
		const response = await this.request(`workflow${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
		if (!response.ok) throw new Error(`Public workflow view failed: ${response.status} ${await response.text()}`);
		return (await response.json()) as AIReqWorkflowView;
	}
	async bind(projectId: string, irId: string, srId?: string): Promise<void> {
		const response = await this.request("workflow/bind", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId, irId, srId }),
		});
		if (!response.ok) throw new Error(`Public object binding failed: ${response.status} ${await response.text()}`);
	}
	async command(command: AIReqWorkflowCommand): Promise<{ response: Response; result: AIReqWorkflowResult }> {
		const response = await this.request("workflow/command", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
		return { response, result: (await response.json()) as AIReqWorkflowResult };
	}
	async stop(): Promise<void> {
		if (this.child.exitCode === null) {
			const stdin = this.child.stdin;
			if (!stdin) throw new Error("AIReq process stdin pipe is unavailable for explicit /aireq exit");
			stdin.write("/aireq\n");
			await stdin.flush();
		}
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() =>
				timeout.reject(
					new Error(
						`Explicit /aireq exit did not settle; ownership and worktrees must remain retained: ${JSON.stringify(this.logs)}`,
					),
				),
			60_000,
		);
		const code = await Promise.race([this.child.exited, timeout.promise]).finally(() => clearTimeout(timer));
		await Promise.all(this.pumps);
		if (code !== 0) throw new Error(`AIReq native exit failed (${code}): ${JSON.stringify(this.logs)}`);
	}
}

export interface WorkflowMockScenario {
	mode?: "reject" | "hold" | "deny-write" | "empty";
	model?: string;
	input?: ("text" | "image")[];
	reply?: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
	setup?: (cwd: string, agentDir: string) => Promise<void>;
}

/** Uses the native provider SSE fixture; never injects a success into the production engine. */
export class WorkflowConsumerFixture {
	readonly processes = new Set<WorkflowConsumerProcess>();
	constructor(
		readonly root: string,
		readonly project: string,
		readonly env: Record<string, string>,
		readonly provider: ProviderFixture,
	) {}
	static async create(scenario: WorkflowMockScenario = {}): Promise<WorkflowConsumerFixture> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-workflow-consumer-"));
		await fs.writeFile(path.join(root, ".owned-aireq-fixture"), root);
		// Git for Windows maps MSYS /tmp through TMP/TMPDIR; the env below points both at root/tmp.
		// Create it before any child process so bash.exe does not emit a startup warning that the
		// workflow treats as a failed operation.
		await fs.mkdir(path.join(root, "tmp"), { recursive: true });
		const env = isolatedWorkflowEnvironment(root);
		env.OMP_OFFLINE = "1";
		const provider = createProviderFixture({
			reply:
				scenario.reply ??
				(async request => {
					if (scenario.mode === "hold")
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode(": held native stream\n\n"));
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					if (scenario.mode === "empty") return { text: "" };
					if (scenario.mode === "deny-write") {
						const write = request.tools?.find(item => item.function?.name === "write");
						if (!write) throw new Error("Native write tool was not exposed");
						return {
							tool: {
								name: "write",
								args: {
									path: path.join(root, "outside-project.txt"),
									content: "must be denied by the real native boundary",
								},
							},
						};
					}
					return Response.json(
						{ error: { message: "DETERMINISTIC_DEV_PROVIDER_REJECTION", type: "fixture_failure" } },
						{ status: 400 },
					);
				}),
		});
		const project = path.join(root, "project");
		const fixture = new WorkflowConsumerFixture(root, project, env, provider);
		try {
			await writeWorkflowProfile(root, scenario.model ?? WORKFLOW_MODEL, provider.baseUrl, scenario.input);
			await fs.mkdir(project);
			await workflowGit(project, ["init", "--initial-branch=main"], env);
			await fs.writeFile(path.join(project, "user-file.txt"), "retain user bytes\n");
			await fs.writeFile(path.join(project, ".gitignore"), ".omp/\n");
			await workflowGit(project, ["add", "--", "user-file.txt", ".gitignore"], env);
			await workflowGit(project, ["commit", "-m", "Isolated consumer baseline"], env);
			await workflowGit(root, ["init", "--bare", "--initial-branch=main", path.join(root, "remote.git")], env);
			await workflowGit(project, ["remote", "add", "origin", path.join(root, "remote.git")], env);
			await workflowGit(project, ["push", "-u", "origin", "main"], env);
			await workflowGit(project, ["remote", "set-head", "origin", "main"], env);
			await scenario.setup?.(project, path.join(root, "config/profiles/acceptance/agent"));
			return fixture;
		} catch (error) {
			await fixture.close();
			throw error;
		}
	}
	async start(launch?: string[], args?: string[]): Promise<WorkflowConsumerProcess> {
		const child = new WorkflowConsumerProcess(this.project, this.env, workflowRedactor(), launch, args);
		this.processes.add(child);
		await child.ready();
		return child;
	}
	async close(): Promise<void> {
		const settlements = await Promise.allSettled([...this.processes].map(child => child.stop()));
		await this.provider[Symbol.asyncDispose]();
		const failures = settlements.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if ([...this.processes].some(child => child.child.exitCode === null))
			throw new AggregateError(
				failures.map(result => result.reason),
				`Native process remains live; owned fixture retained: ${this.root}`,
			);
		if (
			!path.basename(this.root).startsWith("omp-aireq-workflow-consumer-") ||
			(await fs.readFile(path.join(this.root, ".owned-aireq-fixture"), "utf8")) !== this.root
		)
			throw new Error("Refusing cleanup of an unowned fixture directory");
		await fs.rm(this.root, { recursive: true });
		if (failures.length)
			throw new AggregateError(
				failures.map(result => result.reason),
				"Native fixture exited with errors",
			);
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

/** Native context extraction for deterministic negative seams and assertions only. */
export function workflowNativeContext(request: ModelRequest): Record<string, unknown> | undefined {
	for (const message of request.messages.toReversed()) {
		const text = contentText(message.content);
		const marker = text.indexOf('"outputContract"');
		if (marker < 0) continue;
		let start = -1;
		let depth = 0;
		let quoted = false;
		let escaped = false;
		for (let index = 0; index < text.length; index++) {
			const character = text[index];
			if (!depth) {
				if (character !== "{") continue;
				start = index;
				depth = 1;
				quoted = false;
				escaped = false;
				continue;
			}
			if (quoted) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') quoted = false;
				continue;
			}
			if (character === '"') quoted = true;
			else if (character === "{") depth++;
			else if (character === "}" && --depth === 0) {
				try {
					const context = JSON.parse(text.slice(start, index + 1));
					if (context.binding && Array.isArray(context.outputPaths) && typeof context.outputContract === "string")
						return context;
				} catch {
					/* Native custom-message framing may include non-context braces. */
				}
			}
		}
	}
	return undefined;
}

/** Installed Chromium only; native launch owns its profile and complete child-only user environment. */
export async function withWorkflowChromium<T>(executable: string, run: (browser: Browser) => Promise<T>): Promise<T> {
	if (!(await fs.stat(executable)).isFile())
		throw new Error("An installed Chromium executable is required; downloads are disabled");
	const env: Record<string, string> = {};
	const inheritedNames = new Set([
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"SYSTEMDRIVE",
		"WINDIR",
		"COMSPEC",
		"PROGRAMFILES",
		"PROGRAMFILES(X86)",
		"PROGRAMW6432",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"LANG",
		"LC_ALL",
	]);
	for (const [name, value] of Object.entries(process.env)) {
		if (value && inheritedNames.has(name.toUpperCase())) env[name] = value;
	}
	const launched = await launchHeadlessBrowser({
		executablePath: executable,
		headless: true,
		env,
		isolateUserEnvironment: true,
		// Preserve Chrome's real startup error even when Puppeteer replaces it
		// with its Windows lockfile heuristic; test workers own these pipes.
		dumpio: true,
	});
	try {
		return await run(launched.browser);
	} finally {
		await closeLaunchedBrowser(launched.browser, { strict: true });
		if (launched.userDataDir) await removeUserDataDir(launched.userDataDir, { strict: true });
	}
}
