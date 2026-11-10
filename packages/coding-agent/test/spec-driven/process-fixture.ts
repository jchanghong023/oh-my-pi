import { test as bunTest } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord, ptree, TempDir } from "@oh-my-pi/pi-utils";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { initializeRepository } from "../dev-workbench/fixture";
import { RpcClient } from "../../src/modes/rpc/rpc-client";
import type { SkillsCommandResult } from "../../src/cli/skill-list";
import "../../src/tools"; // Runtime input of the spawned CLI for Bun --changed.
import { contentText, createProviderFixture, type ModelRequest, rolePayload } from "./provider-fixture";

const executable = Bun.env.OMP_SPEC_TEST_EXECUTABLE?.trim();
if (executable && !path.isAbsolute(executable))
	throw new Error("OMP_SPEC_TEST_EXECUTABLE must be an absolute executable path");
const launch = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts")];
// One budget covers real CLI startup, native tools and the isolated local provider.
const GATE_BUDGET = 600_000;
type Frame = Record<string, unknown>;
const caseDiagnostics = new AsyncLocalStorage<Array<() => unknown>>();
function bounded(value: unknown): string {
	return JSON.stringify(
		value,
		(key, item: unknown) => {
			if (/authorization|apiKey|token|secret|password/iu.test(key)) return "[redacted]";
			if (typeof item === "string") return item.length > 2_000 ? `${item.slice(0, 2_000)}…[truncated]` : item;
			return item;
		},
		2,
	).slice(0, 24_000);
}
function test(name: string, body: () => Promise<void>, budget: number): void {
	bunTest(
		name,
		() =>
			caseDiagnostics.run([], async () => {
				const diagnostics = caseDiagnostics.getStore()!;
				let reported = false;
				const report = () => {
					if (reported) return;
					reported = true;
					const observations = diagnostics.map(snapshot => snapshot());
					console.error(
						`Public acceptance final status: ${JSON.stringify({
							case: name,
							observations: observations.map(observation =>
								isRecord(observation)
									? {
											command: observation.command,
											phase: observation.phase,
											phaseText: observation.phaseText,
										}
									: observation,
							),
						})}`,
					);
					console.error(
						`Public acceptance diagnostics: ${bounded({
							case: name,
							observations: observations.map(observation =>
								isRecord(observation)
									? {
											...observation,
											phase: isRecord(observation.phase)
												? {
														...observation.phase,
														statusMaterial: undefined,
														publishedText: undefined,
													}
												: observation.phase,
										}
									: observation,
							),
						})}`,
					);
				};
				// Diagnostic-only timer at the existing gate boundary, not a new execution deadline.
				const timer = setTimeout(report, budget);
				try {
					await body();
				} catch (error) {
					report();
					throw error;
				} finally {
					clearTimeout(timer);
				}
			}),
		budget,
	);
}
function executorToolDiagnostics(request: ModelRequest | undefined): unknown[] {
	if (!request) return [];
	return request.messages
		.filter(message => message.role === "tool")
		.slice(-8)
		.map(message => ({
			toolCallId: message.tool_call_id,
			result: contentText(message.content),
		}));
}

class PublicPeer extends RpcClient {
	constructor(cwd: string, env: NodeJS.ProcessEnv, provider: { requests: ModelRequest[]; failures: string[] }) {
		// Supplying the native process adapter avoids RpcClient's ambient-environment
		// merge: no developer credentials, configuration or sessions enter this CLI.
		super({
			spawn: args => ptree.spawn([...launch, ...args], { cwd, env, stdin: "pipe" }),
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		const events: unknown[] = [];
		this.onSessionEvent(event => {
			events.push(event);
			if (events.length > 12) events.shift();
		});
		caseDiagnostics.getStore()?.push(() => ({
			providerFailures: provider.failures.slice(-12),
			executorTools: executorToolDiagnostics(
				provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor"),
			),
			providerRequests: provider.requests.slice(-8).map(request => ({
				model: request.model,
				role: rolePayload(request)?.specDrivenRole,
				tools: request.tools?.map(tool => tool.function?.name),
				lastUser: contentText(request.messages.findLast(message => message.role === "user")?.content),
				messages: request.messages.slice(-4).map(message => ({
					role: message.role,
					toolCalls: message.tool_calls,
					...(message.role === "tool" ? { content: contentText(message.content) } : {}),
				})),
			})),
			stderr: this.getStderr(),
			events,
		}));
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.stop();
	}
}
async function listSkills(cwd: string, env: NodeJS.ProcessEnv): Promise<SkillsCommandResult> {
	const result = await run(cwd, env, [...launch, "skill", "list", "--json"]);
	if (result.exitCode !== 0) throw new Error(`Native skill discovery failed: ${bounded(result)}`);
	return JSON.parse(result.stdout) as SkillsCommandResult;
}
function textValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(textValues);
	return isRecord(value) ? Object.values(value).flatMap(textValues) : [];
}
async function fixture(root: TempDir, baseUrl: string) {
	const cwd = root.join("project");
	const home = root.join("home");
	const configRoot = root.join("config");
	const agentDir = path.join(configRoot, "agent");
	// 原生隔离保护临时产物的父目录；临时空间与项目必须分开，
	// 否则把 fixture 根作为 TEMP 会连真实项目源码也划入受保护范围。
	const temp = root.join("tmp");
	const appData = root.join("home", "AppData", "Roaming");
	const localData = root.join("home", "AppData", "Local");
	const cache = root.join("cache");
	for (const directory of [cwd, home, agentDir, temp, appData, localData, cache])
		await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: deepseek-v4-flash\n        reasoning: false\n        contextWindow: 200000\n      - id: deepseek-v4-pro\n        reasoning: false\n        contextWindow: 200000\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: deepseek/deepseek-v4-flash\n  smol: deepseek/deepseek-v4-flash\ntools:\n  xdev: false\nasync:\n  enabled: false\n",
	);
	const env: NodeJS.ProcessEnv = {
		PATH: Bun.env.PATH,
		SystemRoot: Bun.env.SystemRoot,
		WINDIR: Bun.env.WINDIR,
		ProgramFiles: Bun.env.ProgramFiles,
		APPDATA: appData,
		LOCALAPPDATA: localData,
		XDG_CONFIG_HOME: configRoot,
		XDG_DATA_HOME: localData,
		XDG_CACHE_HOME: cache,
		TMPDIR: temp,
		TEMP: temp,
		TMP: temp,
		// Keep the gate's compiled-source cache while isolating every runtime fixture.
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: Bun.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: configRoot,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		NO_PROXY: "127.0.0.1,localhost",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "OMP Acceptance",
		GIT_AUTHOR_EMAIL: "omp-acceptance@example.invalid",
		GIT_COMMITTER_NAME: "OMP Acceptance",
		GIT_COMMITTER_EMAIL: "omp-acceptance@example.invalid",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
	};
	await fs.writeFile(env.GIT_CONFIG_GLOBAL!, "");
	await initializeRepository(cwd);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "Baseline belongs to the acceptance fixture.\n");
	const repo = requireGit(cwd);
	await repo.stageFiles(["baseline.txt"]);
	await repo.commitCreate("Fixture baseline", {});
	return { cwd, env, root: root.path() };
}
async function run(cwd: string, env: NodeJS.ProcessEnv, command: string[]) {
	const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}
async function git(cwd: string, _env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
	const repo = requireGit(cwd);
	if (args.join(" ") === "rev-parse HEAD") return (await repo.headSha()) ?? "";
	if (args.join(" ") === "status --porcelain") return (await repo.statusPorcelain({})).trim();
	throw new Error(`Unsupported native fixture query: ${args.join(" ")}`);
}

export { bounded, fixture, GATE_BUDGET, git, launch, listSkills, PublicPeer, run, test, textValues };
