import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { chatTextBackend, judgeQuestions, TextJudge, type Questions } from "@oh-my-pi/pi-ai";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import { createAgentSession, discoverAuthStorage, type CustomTool } from "../../src/sdk";
import { ModelRegistry } from "../../src/config/model-registry";
import { resolveCliModel } from "../../src/config/model-resolver";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import {
	createGovernanceCases,
	type CommandResult,
	type SemanticVerdict,
	type TraceEntry,
} from "./governance-model-quality-cases";
import evaluation from "./governance-model-quality.json" with { type: "json" };
import writeToolContract from "./governance-model-quality-write.md" with { type: "text" };
import removeToolContract from "./governance-model-quality-remove.md" with { type: "text" };
import { buildChildEnv } from "../../../../scripts/ci-test-ts";

// Explicit paid/external acceptance: run with `bun .../governance-model-quality.ts`.
// It is deliberately not a .test.ts file and never registers a skipped test.
// Optional OMP_GOVERNANCE_EVAL_MODEL overrides the normal configured @default.
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const deadlineMs = Number(process.env.OMP_GOVERNANCE_EVAL_TIMEOUT_MS ?? 300_000);
assert(Number.isSafeInteger(deadlineMs) && deadlineMs > 0, "OMP_GOVERNANCE_EVAL_TIMEOUT_MS must be a positive integer");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-governance-real-model-"));
const existingAgentDir = getAgentDir();
const settings = await Settings.loadReadOnly({ cwd: repoRoot, agentDir: existingAgentDir });
const selector = process.env.OMP_GOVERNANCE_EVAL_MODEL?.trim() || "@default";
const questionSet = judgeQuestions(evaluation.questions);
const policySource = await Bun.file(path.join(repoRoot, "openspec/specs/fork-maintenance/spec.md")).text();
const titles = ["Fork 维护责任和需求权威", "Fork 文档维护"] as const;
const policy = titles
	.map(title => {
		const marker = `### Requirement: ${title}`;
		const start = policySource.indexOf(marker);
		assert(start >= 0, `Missing authoritative requirement: ${title}`);
		const end = policySource.indexOf("\n### Requirement:", start + marker.length);
		return policySource
			.slice(start, end < 0 ? undefined : end)
			.trim()
			.replaceAll("(../)", "(openspec/specs/)")
			.replaceAll("(../../changes/)", "(openspec/changes/)");
	})
	.join("\n\n");
const manifest = await Bun.file(path.join(repoRoot, "package.json")).json();
assert.equal(typeof manifest.packageManager, "string");
const prefix = `Hello-${crypto.randomUUID().slice(0, 8)}`;
const results: Array<{ id: string; requirement: string; scenarios: string[]; status: string; error?: string }> = [];
let succeeded = false;
let phase = "auth-and-model-preflight";
const auth = await discoverAuthStorage(existingAgentDir, { settings, cwd: repoRoot });

function childEnvironment(root: string): NodeJS.ProcessEnv {
	const runtime = path.join(path.dirname(root), "runtime");
	// Reuse the repository credential scrubber, then retain only executable
	// discovery variables. No actor/judge credential or config selector reaches
	// the fixed CLI, assertion checker or mutation-verification subprocesses.
	const executableEnvironment = Object.fromEntries(
		Object.entries(buildChildEnv()).filter(([name]) => ["PATH", "SYSTEMROOT", "WINDIR"].includes(name.toUpperCase())),
	);
	return {
		...executableEnvironment,
		HOME: runtime,
		USERPROFILE: runtime,
		TMP: runtime,
		TEMP: runtime,
		TMPDIR: runtime,
		OMP_CONFIG_ROOT: path.join(runtime, "config"),
		PI_CODING_AGENT_DIR: path.join(runtime, "config", "agent"),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_CONFIG_DIR: ".omp",
		CLAUDE_CONFIG_DIR: path.join(runtime, "claude"),
		XDG_CONFIG_HOME: path.join(runtime, "xdg", "config"),
		XDG_DATA_HOME: path.join(runtime, "xdg", "data"),
		XDG_STATE_HOME: path.join(runtime, "xdg", "state"),
		XDG_CACHE_HOME: path.join(runtime, "xdg", "cache"),
		APPDATA: path.join(runtime, "appdata"),
		LOCALAPPDATA: path.join(runtime, "localappdata"),
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(runtime, "bun-transpiler"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: path.join(runtime, "empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
	};
}
async function command(root: string, argv: string[]): Promise<CommandResult> {
	const child = Bun.spawn(argv, {
		cwd: root,
		env: childEnvironment(root),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), 30_000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}
async function snapshot(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	async function visit(relative: string): Promise<void> {
		for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const file = relative ? `${relative}/${entry.name}` : entry.name;
			assert(!entry.isSymbolicLink(), "Fixture must not contain symlinks");
			if (entry.isDirectory()) await visit(file);
			else files.set(file, await fs.readFile(path.join(root, file), "utf8"));
		}
	}
	await visit("");
	return files;
}

try {
	// Existing model configuration is consumed by the normal registry, while
	// discovery cache writes belong to this temporary evaluation directory.
	const registry = new ModelRegistry(auth, path.join(existingAgentDir, "models.yml"), {
		settings,
		cacheDbPath: path.join(directory, "model-cache.db"),
	});
	await registry.refresh(process.env.OMP_OFFLINE === "1" ? "offline" : "online-if-uncached");
	const selected = resolveCliModel({ cliModel: selector, modelRegistry: registry, settings });
	if (selected.error) throw new Error(selected.error);
	if (selected.warning) console.error(selected.warning);
	assert(selected.model, `Configured selector ${selector} did not resolve to a model`);
	const model = selected.model;
	assert(registry.hasConfiguredAuth(model), `No configured authentication for ${model.provider}/${model.id}`);
	assert.notEqual(model.supportsTools, false, "The selected real model cannot execute maintenance tools");
	console.log(JSON.stringify({ phase: "model-selected", selector, model: `${model.provider}/${model.id}` }));
	const judge = new TextJudge(chatTextBackend(model, { apiKey: registry.resolver(model) }));
	for (const scenario of createGovernanceCases(policy, prefix, manifest.packageManager)) {
		phase = scenario.id;
		const caseDir = path.join(directory, scenario.id);
		const root = path.join(caseDir, "repo");
		const runtime = path.join(caseDir, "runtime");
		await fs.mkdir(root, { recursive: true });
		await fs.mkdir(runtime, { recursive: true });
		for (const [file, text] of Object.entries(scenario.files)) await Bun.write(path.join(root, file), text);
		for (const argv of [
			["git", "init", "--initial-branch=main"],
			["git", "config", "--local", "core.hooksPath", "/dev/null"],
			["git", "add", "--", ...Object.keys(scenario.files).filter(file => file !== "docs-zh-CN/new-fork-guide.md")],
			[
				"git",
				"-c",
				"user.name=Governance fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				"Controlled evaluation baseline",
			],
		]) {
			const result = await command(root, argv);
			assert.equal(result.code, 0, `Fixture Git initialization failed: ${result.stderr}`);
		}
		const before = await snapshot(root);
		const trace: TraceEntry[] = [];
		const judgments: Array<{ state: Record<string, string>; answers: SemanticVerdict }> = [];
		function localPath(input: string): { absolute: string; relative: string } {
			assert(!input.includes("\0"), "NUL path refused");
			const absolute = path.resolve(root, input);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			assert(
				relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative),
				"Outside-fixture path refused",
			);
			assert(relative !== ".git" && !relative.startsWith(".git/"), "Fixture Git internals are not model tools");
			return { absolute, relative };
		}
		async function observed<T>(
			op: TraceEntry["op"],
			input: string,
			action: (target: { absolute: string; relative: string }) => Promise<T>,
		): Promise<T> {
			const entry: TraceEntry = { op, path: input.replaceAll("\\", "/"), ok: false };
			trace.push(entry);
			assert(trace.length <= 100, "Maintenance exceeded the explicit 100-tool-call evaluation ceiling");
			const target = localPath(input);
			entry.path = target.relative;
			const result = await action(target);
			entry.ok = true;
			return result;
		}
		const textResult = (value: unknown) => ({
			content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
		});
		const pathSchema = type({ path: "string" });
		const writeSchema = type({ path: "string", content: "string" });
		const tools: CustomTool[] = [
			{
				name: "fixture_list",
				label: "List temporary project",
				loadMode: "essential",
				approval: "read",
				description:
					"List immediate names in one temporary-project directory. Paths are project-relative. No outside files are accessible.",
				parameters: pathSchema,
				async execute(_id, input) {
					const args = pathSchema.assert(input);
					return textResult(
						await observed("list", args.path, async target =>
							(await fs.readdir(target.absolute, { withFileTypes: true }))
								.filter(entry => entry.name !== ".git")
								.map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`),
						),
					);
				},
			},
			{
				name: "fixture_read",
				label: "Read temporary project",
				loadMode: "essential",
				approval: "read",
				description:
					"Read one entire UTF-8 file in the temporary project. Paths are project-relative. Read applicable approved specs and referenced domains before changing artifacts.",
				parameters: pathSchema,
				async execute(_id, input) {
					const args = pathSchema.assert(input);
					return textResult(await observed("read", args.path, target => fs.readFile(target.absolute, "utf8")));
				},
			},
			{
				name: "fixture_write",
				label: "Write temporary project artifact",
				loadMode: "essential",
				approval: "write",
				description: prompt.render(writeToolContract, { writable: scenario.writable }).trim(),
				parameters: writeSchema,
				async execute(_id, input) {
					const args = writeSchema.assert(input);
					return textResult(
						await observed("write", args.path, async target => {
							assert(scenario.writable.includes(target.relative), "Out-of-scope fixture write refused");
							await Bun.write(target.absolute, args.content);
							return { written: target.relative, bytes: Buffer.byteLength(args.content) };
						}),
					);
				},
			},
			{
				name: "fixture_remove",
				label: "Remove temporary project artifact",
				loadMode: "essential",
				approval: "write",
				description: prompt.render(removeToolContract, { writable: scenario.writable }).trim(),
				parameters: pathSchema,
				async execute(_id, input) {
					const args = pathSchema.assert(input);
					return textResult(
						await observed("remove", args.path, async target => {
							assert(scenario.writable.includes(target.relative), "Out-of-scope fixture deletion refused");
							await fs.unlink(target.absolute);
							return { removed: target.relative };
						}),
					);
				},
			},
			{
				name: "fixture_check",
				label: "Run real project assertions",
				loadMode: "essential",
				approval: "read",
				description:
					"Run the existing immutable package check script against test/cases.json and the actual CLI. No shell, install, network, arbitrary command or executable edit is exposed.",
				parameters: type({}),
				async execute() {
					const entry: TraceEntry = { op: "check", path: "scripts/check.ts", ok: false };
					trace.push(entry);
					const result = await command(root, [process.execPath, "run", "check"]);
					entry.ok = result.code === 0;
					return textResult(result);
				},
			},
		];
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: runtime,
			authStorage: auth,
			modelRegistry: registry,
			model,
			thinkingLevel: selected.thinkingLevel,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(root),
			contextFiles: [{ path: path.join(root, "AGENTS.md"), content: scenario.files["AGENTS.md"]! }],
			noContextFiles: true,
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: tools.map(tool => tool.name),
			customTools: tools,
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			spawns: "",
			bindProcessState: false,
			autoApprove: true,
			cacheWarming: false,
			suppressAutoPrewalk: true,
			autoTitle: false,
			disableModelFallback: true,
			disableServerSideFallback: true,
			assertDispatchModel: candidate =>
				assert.equal(
					`${candidate.provider}/${candidate.id}`,
					`${model.provider}/${model.id}`,
					"Unrequested model fallback",
				),
			deadline: Date.now() + deadlineMs,
		});
		try {
			await session.prompt(scenario.prompt);
			const terminal = session.state.messages.findLast(message => message.role === "assistant");
			assert(terminal?.role === "assistant", "No real model terminal message");
			assert.equal(
				terminal.stopReason,
				"stop",
				terminal.errorMessage ?? "Maintenance model did not complete normally",
			);
			const after = await snapshot(root);
			await scenario.verify({
				before,
				after,
				trace,
				read: file => fs.readFile(localPath(file).absolute, "utf8"),
				write: async (file, text) => {
					await Bun.write(localPath(file).absolute, text);
				},
				cli: args => command(root, [process.execPath, "scripts/cli.ts", ...args]),
				check: () => command(root, [process.execPath, "run", "check"]),
				async judge(state, ids) {
					const questions: Questions = {};
					for (const id of ids) {
						assert(Object.hasOwn(questionSet, id), `Unknown static judge question ${id}`);
						questions[id] = questionSet[id as keyof typeof questionSet];
					}
					const response = await judge.judge({ state, questions }, { signal: AbortSignal.timeout(deadlineMs) });
					const answers: SemanticVerdict = {};
					for (const id of ids) {
						const answer = response.answers[id];
						assert(answer?.type === "noul", `Malformed semantic judgment ${id}`);
						answers[id] = { probability: answer.noul };
					}
					judgments.push({ state, answers });
					return answers;
				},
			});
			results.push({
				id: scenario.id,
				requirement: scenario.requirement,
				scenarios: scenario.scenarios,
				status: "passed",
			});
		} catch (error) {
			results.push({
				id: scenario.id,
				requirement: scenario.requirement,
				scenarios: scenario.scenarios,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			await session.dispose();
			await Bun.write(
				path.join(caseDir, "evidence.json"),
				JSON.stringify(
					{
						trace,
						before: Object.fromEntries(before),
						after: Object.fromEntries(await snapshot(root)),
						judgments,
					},
					null,
					2,
				),
			);
		}
	}
	succeeded = true;
	console.log(
		JSON.stringify({ selector, model: `${model.provider}/${model.id}`, results, status: "passed" }, null, 2),
	);
} catch (error) {
	console.error(JSON.stringify({ phase, results, status: "failed", evidenceDirectory: directory }, null, 2));
	throw error; // Preserve real preflight/auth/connection failure; never skip or report success.
} finally {
	auth.close();
	if (succeeded) await fs.rm(directory, { recursive: true, force: true });
}
