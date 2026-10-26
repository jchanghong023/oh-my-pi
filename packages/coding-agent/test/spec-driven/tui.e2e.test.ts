import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { DocsService } from "../../src/docs/service";
import {
	CHANGE_ID,
	createProviderFixture,
	IMPLEMENTATION_PATH,
	MARKER,
	REQUIREMENT,
	contentText,
	teamStage,
	rolePayload,
	type ProviderFixture,
	type ProviderScenario,
} from "./provider-fixture";

const tuiTest = Bun.which("tui-test");
const repo = path.resolve(import.meta.dir, "../../../..");

// Always launch the public development CLI on tui-test's real PTY. The HTTP
// provider is isolated; it can only ask the CLI's advertised native tools to act.
async function withTui(
	scenario: ProviderScenario,
	run: (harness: {
		cwd: string;
		provider: ProviderFixture;
		tui: (...args: string[]) => Promise<string>;
		chooseFirst: (label: string, submit?: boolean) => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	await using root = await TempDir.create("@omp-dev-four-stage-tui-");
	await using provider = createProviderFixture(scenario);
	const cwd = root.join("project");
	const home = root.join("home");
	const agentDir = root.join("config", "agent");
	const temp = root.join("tmp");
	for (const directory of [cwd, home, agentDir, temp]) await fs.mkdir(directory, { recursive: true });
	if (scenario.wikiQuery) {
		const knowledge = root.join("knowledge");
		await Bun.write(
			path.join(knowledge, "policy.md"),
			`# 企业规范\n${scenario.wikiQuery}：保留姓名内部空白，不添加远程服务。\n`,
		);
		const service = new DocsService({ agentDir, cwd });
		try {
			await service.init(knowledge, "company-policy");
		} finally {
			await service.close();
		}
		await fs.rm(knowledge, { recursive: true });
	}
	const env = {
		...process.env,
		OMP_CONFIG_ROOT: root.join("config"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "default",
		PI_PROFILE: "",
		HOME: home,
		USERPROFILE: home,
		TEMP: temp,
		TMP: temp,
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		// The gate marks every bun-test child as a test runtime, which disables
		// production behavior (network/model discovery, persistent caches). This
		// harness drives the real CLI on tui-test's PTY, so launch it as production.
		PI_TEST_RUNTIME: "",
		NO_PROXY: "127.0.0.1,localhost",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("gitconfig"),
		GIT_CONFIG_COUNT: "0",
	};
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n`,
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ncomposer:\n  predictions: false\nstartup:\n  setupWizard: false\n  checkUpdate: false\nasync:\n  enabled: false\n",
	);
	const session = `dev-four-stage-${crypto.randomUUID()}`;
	async function tui(...args: string[]): Promise<string> {
		if (!tuiTest) throw new Error("tui-test is required for this real TUI regression");
		const child = Bun.spawn([tuiTest, "--session", session, ...args], {
			cwd: repo,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`tui-test ${args.join(" ")} exited ${code}:\n${stdout}\n${stderr}`);
		return stdout;
	}
	async function chooseFirst(label: string, submit = true): Promise<void> {
		await tui("expect", "text", "操作（", "--timeout", "30000");
		const screen = await tui("text");
		const selection = /操作（(\d+)\//u.exec(screen);
		if (!selection) throw new Error(`Decision panel is not visible:\n${screen}`);
		const up = Number(selection[1]) - 1;
		if (up) await tui("key", "press", ...Array<string>(up).fill("Up"));
		await tui("expect", "text", `› 【阶段决策】${label}`, "--timeout", "30000");
		await tui("key", "press", "Enter");
		if (submit && ["确认需求并进入方案", "批准计划并开始执行"].includes(label))
			await tui("key", "press", "Ctrl+Enter");
	}
	try {
		await tui(
			"run",
			"--cwd",
			repo,
			"--cols",
			"120",
			"--rows",
			"36",
			...Object.entries(env)
				.filter((entry): entry is [string, string] => entry[1] !== undefined)
				.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
			"--",
			Bun.which("bun") ?? process.execPath,
			"run",
			"dev",
			"--cwd",
			cwd,
			"--no-extensions",
			"--no-rules",
			"--no-title",
			"--model",
			"spec-fixture/chat-a",
		);
		await tui("expect", "text", "Ctrl+T", "--timeout", "30000");
		await tui("expect", "text", "chat-a", "--timeout", "30000");
		await run({ cwd, provider, tui, chooseFirst });
	} catch (error) {
		console.error("Fresh native TUI screen:", await tui("text", "--full"));
		console.error("Local provider failures:", provider.failures);
		for (const role of ["requirements", "solution", "planner", "executor"]) {
			const latest = provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === role);
			if (latest)
				console.error(
					`Last ${role} native tool responses:`,
					JSON.stringify(latest.messages.filter(message => message.role === "tool").slice(-6)),
				);
		}
		throw error;
	} finally {
		await tui("close");
	}
}

test.skipIf(!tuiTest)(
	"TUI four-stage decisions preserve drafts and nonapproval, then accept real delivery",
	async () => {
		await withTui({ wikiQuery: "stagewikibeacon" }, async ({ cwd, provider, tui, chooseFirst }) => {
			await tui("submit", "/dev");
			await tui("expect", "text", "尚未启动", "--timeout", "30000");
			await tui("submit", `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
			await tui("expect", "text", "确认需求并进入方案", "--timeout", "30000");
			const requirementsRequest = provider.requests.findLast(
				request => rolePayload(request)?.specDrivenRole === "requirements",
			)!;
			expect(
				requirementsRequest.messages.some(
					message => message.role === "tool" && contentText(message.content).includes("保留姓名内部空白"),
				),
			).toBe(true);
			expect(provider.requests.map(rolePayload).some(payload => payload?.specDrivenRole === "solution")).toBe(false);
			await chooseFirst("确认需求并进入方案");
			await tui("expect", "text", "协同开发 · 方案", "--timeout", "30000");
			await tui("expect", "text", "› 【查看材料】查看完整方案文件与所有候选", "--timeout", "30000");
			const solution = provider.requests.map(rolePayload).find(payload => payload?.specDrivenRole === "solution");
			const solutionPath = (solution!.input.outputPaths as string[])[0]!;
			expect((await Bun.file(path.join(cwd, solutionPath)).json()).candidates).toHaveLength(2);
			const solutionRequest = provider.requests.findLast(
				request => rolePayload(request)?.specDrivenRole === "solution",
			)!;
			expect(
				solutionRequest.messages.some(
					message => message.role === "tool" && contentText(message.content).includes("保留姓名内部空白"),
				),
			).toBe(true);
			// Escape, resize, and an unsubmitted draft cannot select or approve.
			await tui("key", "press", "Escape");
			await tui("resize", "100", "28");
			await tui("type", "未提交的草稿：先让我再看看方案");
			expect(provider.requests.map(rolePayload).some(payload => payload?.specDrivenRole === "planner")).toBe(false);
			await tui("key", "press", "Ctrl+U");
			const rawSelection = "/dev choose pure 我就选纯函数；请完整保留这句确认和整个方案文件。";
			await tui("submit", rawSelection);
			await tui("expect", "text", "协同开发 · 计划", "--timeout", "30000");
			await tui("expect", "text", "› 【查看材料】查看完整计划文件", "--timeout", "30000");
			const planner = provider.requests.map(rolePayload).find(payload => payload?.specDrivenRole === "planner");
			expect(planner?.input.userReply).toBe(rawSelection);
			expect(planner?.input.candidateId).toBe("pure");
			expect(
				(planner?.input.files as Array<{ path: string; content: string }>).find(file => file.path === solutionPath)
					?.content,
			).toBe(await Bun.file(path.join(cwd, solutionPath)).text());
			expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).exists()).toBe(false);
			await chooseFirst("批准计划并开始执行");
			await tui("expect", "text", "协同开发 · 执行", "--timeout", "30000");
			await tui("expect", "text", "› 【查看材料】查看完整完成报告", "--timeout", "30000");
			expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).exists()).toBe(true);
			const executor = provider.requests.map(rolePayload).find(payload => payload?.specDrivenRole === "executor");
			const reportPath = (executor!.input.outputPaths as string[])[0]!;
			const report = await Bun.file(path.join(cwd, reportPath)).text();
			expect(path.dirname(reportPath)).toBe("docs/superpowers/plans");
			expect(report).toStartWith("# 完成报告");
			expect(report).toContain("## 未完成项");
			expect(report).toContain("1 pass");
			expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).exists()).toBe(false);
			console.log("Native TUI before explicit acceptance:\n", await tui("text"));
			await chooseFirst("验收交付并同步需求、归档");
			await tui("expect", "text", "已完成", "--timeout", "30000");
			console.log("Native TUI after requirements sync/archive:\n", await tui("text"));
			expect((await fs.readdir(path.join(cwd, "docs/superpowers/plans"))).length).toBe(3);
			expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
			expect(provider.failures).toEqual([]);
		});
	},
	300_000,
);

test.skipIf(!tuiTest)(
	"TUI enables Team and executor Goal in the existing approvals without extra stages or automatic acceptance",
	async () => {
		await withTui({}, async ({ cwd, provider, tui, chooseFirst }) => {
			await tui("submit", `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
			await tui("expect", "text", "确认需求并进入方案", "--timeout", "30000");
			await chooseFirst("确认需求并进入方案", false);
			await tui("expect", "text", "☐ 本次方案启用 Team", "--timeout", "30000");
			await tui("key", "press", "Space");
			await tui("expect", "text", "☑ 本次方案启用 Team", "--timeout", "30000");
			expect(provider.requests.some(teamStage)).toBe(false);
			await tui("key", "press", "Ctrl+Enter");
			await tui("expect", "text", "协同开发 · 方案", "--timeout", "30000");
			await tui("expect", "text", "查看完整方案文件与所有候选", "--timeout", "30000");
			const stages = provider.requests
				.filter(request => request.tools?.some(tool => tool.function?.name.replace(/^_/u, "") === "yield"))
				.map(teamStage)
				.filter(Boolean);
			expect(stages.filter(stage => stage === "proposal")).toHaveLength(3);
			expect(stages).toContain("alignment");
			expect(stages.filter(stage => stage === "review")).toHaveLength(3);
			expect(stages).toContain("synthesis");
			const solutionInput = provider.requests
				.map(rolePayload)
				.find(payload => payload?.specDrivenRole === "solution")!;
			const solutionPath = (solutionInput.input.outputPaths as string[])[0]!;
			const solution = await Bun.file(path.join(cwd, solutionPath)).json();
			expect(solution.candidates).toHaveLength(3);
			await tui("key", "press", "Escape");
			await tui("submit", `/dev choose ${solution.candidates[0].id} 采用完整 Team 候选`);
			await tui("expect", "text", "协同开发 · 计划", "--timeout", "30000");
			await chooseFirst("批准计划并开始执行", false);
			await tui("expect", "text", "☐ 本次执行启用原生 Goal", "--timeout", "30000");
			await tui("key", "press", "Space");
			await tui("expect", "text", "☑ 本次执行启用原生 Goal", "--timeout", "30000");
			expect(provider.requests.map(rolePayload).some(payload => payload?.specDrivenRole === "executor")).toBe(false);
			await tui("key", "press", "Escape");
			expect(provider.requests.map(rolePayload).some(payload => payload?.specDrivenRole === "executor")).toBe(false);
			await tui("submit", "/dev help");
			await chooseFirst("批准计划并开始执行", false);
			await tui("expect", "text", "☐ 本次执行启用原生 Goal", "--timeout", "30000");
			await tui("key", "press", "Space", "Ctrl+Enter");
			await tui("expect", "text", "查看完整完成报告", "--timeout", "30000");
			const executor = provider.requests.findLast(request => rolePayload(request)?.specDrivenRole === "executor")!;
			const results = executor.messages
				.filter(message => message.role === "tool")
				.map(message => contentText(message.content))
				.join("\n");
			expect(results).toContain("Status: active");
			expect(results).toContain("Greeting Implementation Plan");
			expect(results).toContain("Status: complete");
			expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toContain("export function greet");
			expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).exists()).toBe(false);
			console.log("Native Team/Goal decision result before acceptance:\n", await tui("text"));
			await chooseFirst("验收交付并同步需求、归档");
			await tui("expect", "text", "已完成", "--timeout", "30000");
			expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
			expect(provider.failures).toEqual([]);
		});
	},
	300_000,
);

for (const kind of ["missing", "malformed", "unknown"] as const) {
	test.skipIf(!tuiTest)(
		`TUI displays fresh native ${kind} solution-file refusal without admitting planner`,
		async () => {
			await withTui({ fileFailure: { role: "solution", kind } }, async ({ provider, tui, chooseFirst }) => {
				await tui("submit", `/dev start ${CHANGE_ID} ${MARKER}: ${REQUIREMENT}`);
				await tui("expect", "text", "确认需求并进入方案", "--timeout", "30000");
				await chooseFirst("确认需求并进入方案");
				await tui("expect", "text", "阻塞：", "--timeout", "30000");
				const stopped = await tui("text", "--full");
				expect(stopped).toContain("阻塞：");
				console.log("Fresh native file-gate refusal:", stopped);
				expect(provider.requests.map(rolePayload).some(payload => payload?.specDrivenRole === "planner")).toBe(
					false,
				);
				expect(provider.failures).toEqual([]);
			});
		},
		120_000,
	);
}
