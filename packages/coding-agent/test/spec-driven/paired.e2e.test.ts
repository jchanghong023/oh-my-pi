import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createSpecPairedReport, renderSpecPairedReport, type SpecRunMeasurement } from "../../src/spec-driven/metrics";
import { createPairedProvider, PAIRED_CRITERIA, PAIRED_MODELS, PAIRED_SPEC_PATH, PAIRED_TASK } from "./paired-fixture";
import { contentText, IMPLEMENTATION, IMPLEMENTATION_PATH } from "./provider-fixture";

const GATE_BUDGET = 600_000;
const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const reportRoot = path.resolve(
	Bun.env.OMP_SPEC_PAIRED_REPORT_DIR?.trim() || path.join(repositoryRoot, "runs/spec-driven-paired"),
);
interface ArmOutput {
	mode: "baseline" | "workflow";
	measurement: SpecRunMeasurement;
	state: { phase: string; paused?: boolean; blockedReason?: string };
	events: unknown[];
	selectedResources: Array<{ name: string; filePath: string }>;
}
interface ScenarioCoverage {
	trim: boolean;
	blank: boolean;
	internalSpaces: boolean;
}
async function command(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
	const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}
async function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
	const result = await command(cwd, env, ["git", "-c", "core.hooksPath=", ...args]);
	if (result.exitCode !== 0) throw new Error(`Disposable paired Git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}
async function readOptional(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return null;
		throw error;
	}
}
async function environment(root: string, baseUrl: string): Promise<NodeJS.ProcessEnv> {
	const home = path.join(root, "home");
	const configRoot = path.join(root, "config");
	const agentDir = path.join(configRoot, "agent");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 200000\n`,
	);
	const emptyGitconfig = path.join(root, "empty-gitconfig");
	await fs.writeFile(emptyGitconfig, "");
	// Allowlist: never inherit API keys, proxy credentials or user configuration.
	return {
		PATH: Bun.env.PATH,
		SystemRoot: Bun.env.SystemRoot,
		WINDIR: Bun.env.WINDIR,
		ProgramFiles: Bun.env.ProgramFiles,
		LOCALAPPDATA: home,
		APPDATA: home,
		TEMP: root,
		TMP: root,
		TMPDIR: root,
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: configRoot,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: "1",
		PI_NO_TITLE: "1",
		NO_PROXY: "127.0.0.1,localhost",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: emptyGitconfig,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "OMP Paired Fixture",
		GIT_AUTHOR_EMAIL: "paired@example.invalid",
		GIT_COMMITTER_NAME: "OMP Paired Fixture",
		GIT_COMMITTER_EMAIL: "paired@example.invalid",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
	};
}
function coverage(spec: string | null): ScenarioCoverage {
	return {
		trim:
			spec !== null &&
			/#### Scenario: Outer whitespace/u.test(spec) &&
			spec.includes('greet("  Ada  ")') &&
			spec.includes('"Hello, Ada!"'),
		blank:
			spec !== null &&
			/#### Scenario: Blank name/u.test(spec) &&
			spec.includes('greet("  ")') &&
			spec.includes('"Hello, world!"'),
		internalSpaces:
			spec !== null &&
			/#### Scenario: Internal whitespace/u.test(spec) &&
			spec.includes('greet(" Ada  Lovelace ")') &&
			spec.includes('"Hello, Ada  Lovelace!"'),
	};
}

// Opt-in only: this runs real OMP SDK/native child tasks and local Git, not a fake port graph.
test.skipIf(Bun.env.OMP_SPEC_PAIRED_E2E !== "1")(
	"AC18 bounded actual upstream-direct versus OMP pre-approval paired scenario",
	async () => {
		await using root = await TempDir.create("@omp-spec-paired-");
		await using provider = createPairedProvider();
		await fs.mkdir(reportRoot, { recursive: true });
		const baselineCwd = root.join("baseline/project");
		await fs.mkdir(baselineCwd, { recursive: true });
		const baselineEnv = await environment(root.join("baseline"), provider.baseUrl);
		await git(baselineCwd, baselineEnv, ["init", "--initial-branch=main"]);
		await fs.writeFile(
			path.join(baselineCwd, "baseline.txt"),
			"Identical disposable greeting specification baseline.\n",
		);
		await git(baselineCwd, baselineEnv, ["add", "baseline.txt"]);
		await git(baselineCwd, baselineEnv, ["commit", "-m", "Paired baseline"]);
		const baselineIdentity = await git(baselineCwd, baselineEnv, ["rev-parse", "HEAD^{tree}"]);
		const baselineCommit = await git(baselineCwd, baselineEnv, ["rev-parse", "HEAD"]);
		const workflowCwd = root.join("workflow/project");
		// Copy the initial .git too: same exact commit/tree, not merely similar source files.
		await fs.cp(baselineCwd, workflowCwd, { recursive: true });
		const workflowEnv = await environment(root.join("workflow"), provider.baseUrl);
		expect(await git(workflowCwd, workflowEnv, ["rev-parse", "HEAD"])).toBe(baselineCommit);
		expect(await git(workflowCwd, workflowEnv, ["rev-parse", "HEAD^{tree}"])).toBe(baselineIdentity);
		const arms: Array<{
			output: ArmOutput;
			measurement: SpecRunMeasurement;
			source: Record<string, unknown>;
			coverage: ScenarioCoverage;
			production: string | null;
			requestCount: number;
			attempts: Record<string, unknown>[];
			attempted: boolean;
			rejected: boolean;
		}> = [];
		for (const mode of ["baseline", "workflow"] as const) {
			const cwd = mode === "baseline" ? baselineCwd : workflowCwd;
			const env = mode === "baseline" ? baselineEnv : workflowEnv;
			const firstRequest = provider.requests.length;
			const outputPath = root.join(`${mode}/native-output.json`);
			const startedAt = Date.now();
			const processResult = await command(cwd, env, [
				process.execPath,
				path.join(import.meta.dir, "paired-fixture.ts"),
				mode,
				cwd,
				outputPath,
			]);
			const endedAt = Date.now();
			const rawOutput = await readOptional(outputPath);
			const observedRequests = provider.requests.slice(firstRequest);
			const spec = await readOptional(path.join(cwd, PAIRED_SPEC_PATH));
			const production = await readOptional(path.join(cwd, IMPLEMENTATION_PATH));
			const effects = {
				specification: spec,
				production,
				coverage: coverage(spec),
				head: await git(cwd, env, ["rev-parse", "HEAD"]),
				status: await git(cwd, env, ["status", "--porcelain=v1", "--untracked-files=all"]),
			};
			const source = {
				startedAt,
				endedAt,
				process: processResult,
				native: rawOutput ? (JSON.parse(rawOutput) as unknown) : null,
				requests: observedRequests,
				effects,
				measurementBoundary: {
					elapsed: "Parent-observed process start/end, including SDK/resource/runtime initialization and disposal",
					requests: "Every provider HTTP ingress, including auxiliary calls and failed responses",
					native:
						"Original native role/message_end measurements retained separately; they do not cover every SDK auxiliary HTTP call",
					usage: "Fixture token counters are synthetic; raw native usage is preserved but excluded from paired token/cost totals",
				},
			};
			await fs.writeFile(path.join(reportRoot, `${mode}-evidence.json`), JSON.stringify(source, null, 2));
			if (processResult.exitCode !== 0 || !rawOutput)
				throw new Error(
					`${mode} native run failed; evidence: ${path.join(reportRoot, `${mode}-evidence.json`)}\n${processResult.stderr}`,
				);
			const output = JSON.parse(rawOutput) as ArmOutput;
			const measurement: SpecRunMeasurement = {
				...output.measurement,
				startedAt,
				endedAt,
				requests: observedRequests.map(request => {
					if (!request.body?.model)
						throw new Error(`HTTP request ${request.id} has no parsed model; inspect ${mode}-evidence.json`);
					return {
						id: request.id,
						node: `provider-http:${request.kind}`,
						model: request.body.model,
						startedAt: request.startedAt,
						endedAt: request.endedAt,
						inputTokens: null,
						outputTokens: null,
						cacheReadTokens: null,
						cacheWriteTokens: null,
						cost: null,
						evidence: `${mode}-evidence.json requests id=${request.id}; actual localhost HTTP ingress/response status=${request.status}`,
					};
				}),
			};
			const toolResponses = observedRequests.flatMap(request =>
				(request.body?.messages ?? [])
					.filter(message => message.role === "tool")
					.map(message => contentText(message.content)),
			);
			const attempts = observedRequests.flatMap(request =>
				isRecord(request.reply) &&
				isRecord(request.reply.tool) &&
				isRecord(request.reply.tool.args) &&
				request.reply.tool.args.path === IMPLEMENTATION_PATH
					? [request.reply.tool.args]
					: [],
			);
			const attempted = attempts.length > 0;
			const rejected =
				production === null &&
				toolResponses.some(text =>
					/unknown tool|not found|not available|not allowed|not permitted|unrecognized|unsupported tool|restricted|不存在|禁止/iu.test(
						text,
					),
				);
			arms.push({
				output,
				measurement,
				source,
				coverage: effects.coverage,
				production,
				requestCount: observedRequests.length,
				attempts,
				attempted,
				rejected,
			});
		}
		const [baseline, workflow] = arms;
		if (!baseline || !workflow) throw new Error("Missing observed paired arm");
		for (const arm of arms) {
			const measurement = arm.measurement;
			measurement.task = PAIRED_TASK;
			measurement.codeBaseline = `commit ${baselineCommit}; tree ${baselineIdentity}`;
			measurement.modelConfiguration = JSON.stringify(PAIRED_MODELS);
			measurement.acceptanceCriteria = PAIRED_CRITERIA;
			measurement.assessmentComplete = false;
			measurement.observations = Object.entries(arm.coverage)
				.filter(([, covered]) => !covered)
				.map(([scenario]) => ({
					id: `missing-${scenario}`,
					kind: "omission" as const,
					description: `Proposed specification omits the declared ${scenario} scenario`,
					evidence: `${measurement.mode}-evidence.json effects.specification`,
					accepted: true,
				}));
			if (arm.production !== null)
				measurement.observations.push({
					id: "early-production-write",
					kind: "unauthorized-action",
					description: "Native write created production before any explicit approval",
					evidence: `${measurement.mode}-evidence.json effects.production and actual write tool result`,
					accepted: true,
				});
		}
		const report = createSpecPairedReport(baseline.measurement, workflow.measurement);
		report.attribution = {
			upstream: [
				"Both arms use pinned OpenSpec exploration/new-change/continue-change methods",
				"Direct arm reads original Superpowers brainstorming with normal SDK tools; OMP arm follows native requirements and independent-review roles",
			],
			orchestration: [
				"Actual OMP requirements role tool restrictions versus unrestricted ordinary SDK write",
				"Actual native core stops awaiting-specification without an approval",
			],
		};
		report.conclusion =
			"This single deterministic localhost adversarial pre-approval scenario measures spec scenario presence and actual early-write effects, not general model/delivery quality or billing. A scripted provider attempts the same unauthorized write in each arm. The direct SDK arm does not share OMP stage gates. Different role contexts, tool rosters and independent review overhead are intentional treatment differences. Team/TDD/implementation/release and human correction outcomes are unmeasured; planned approval waits are not corrections. No causal or statistical quality/cost improvement claim is supported.";
		const limitations = {
			measuredQuality: arms.map(arm => ({
				mode: arm.output.mode,
				scenarioCoverage: arm.coverage,
				missingScenarios: Object.values(arm.coverage).filter(value => !value).length,
				unauthorizedProductionWrites: arm.production === null ? 0 : 1,
				earlyWriteAttempted: arm.attempted,
				nativeRejectionObserved: arm.rejected,
			})),
			unknownQuality: [
				"implemented delivery defects",
				"unsupported release beyond this pre-approval run",
				"human corrections",
				"general model quality",
			],
			requestBoundary: {
				pairedTotals:
					"Complete provider HTTP ingress/response boundary, including auxiliary and failed calls; durations are server-observed handling times, not full client inference latency",
				elapsed: "Parent process start/end includes real initialization and disposal",
				nativeObservations: arms.map(arm => ({
					mode: arm.output.mode,
					nativeMessageEndRequests: arm.output.measurement.requests.length,
					providerHttpRequests: arm.requestCount,
					evidence: `${arm.output.mode}-evidence.json native.measurement.requests versus requests`,
				})),
				difference:
					"Native role/message_end observations are preserved as separate source evidence and may omit SDK labels/classifiers/titles; no equality with complete HTTP totals is assumed",
			},
			syntheticProviderCounters: {
				perRequest: { input: 100, output: 20, cacheRead: "not reported", cacheWrite: "not reported" },
				attribution: "Provider fixture SSE only; deliberately excluded from token/cost summaries",
				requests: { baseline: baseline.requestCount, workflow: workflow.requestCount },
			},
			waiting:
				"No user approval supplied. Stop at approval boundary; planned decision-wait duration and execution-wait duration are unknown, not zero.",
			sourceEvidence: ["baseline-evidence.json", "workflow-evidence.json"],
		};
		await fs.writeFile(
			path.join(reportRoot, "paired-report.json"),
			JSON.stringify({ ...report, limitations }, null, 2),
		);
		await fs.writeFile(
			path.join(reportRoot, "paired-report.md"),
			`${renderSpecPairedReport(report)}\n## Evidence and attribution limitations\n\n\`\`\`json\n${JSON.stringify(limitations, null, 2)}\n\`\`\`\n`,
		);
		// Assertions follow report persistence, preserving genuine defects rather than hiding them.
		expect(provider.failures).toEqual([]);
		for (const arm of arms) {
			expect(arm.attempted).toBe(true);
			expect(arm.coverage).toEqual({ trim: true, blank: true, internalSpaces: true });
			expect(arm.measurement.requests.length).toBe(arm.requestCount);
			expect(arm.requestCount).toBeGreaterThan(0);
		}
		expect(baseline.attempts).toHaveLength(1);
		expect(workflow.attempts).toEqual(baseline.attempts);
		expect(baseline.production).toBe(IMPLEMENTATION);
		expect(workflow.production).toBeNull();
		expect(workflow.rejected).toBe(true);
		expect(workflow.output.state.phase).toBe("awaiting-specification");
		expect(workflow.output.state.paused).not.toBe(true);
		expect(report.baselineSummary.acceptedFindings["unauthorized-action"]).toBe(1);
		expect(report.workflowSummary.acceptedFindings["human-correction"]).toBeNull();
		expect(report.baselineSummary.inputTokens).toBeNull();
		expect(report.workflowSummary.unknownCostRequests).toBe(workflow.requestCount);
	},
	GATE_BUDGET,
);
