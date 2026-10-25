import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SpecDrivenStatus } from "../../src/spec-driven/types";
import { createProviderFixture, MARKER, REQUIREMENT } from "./provider-fixture";

const tuiTest = Bun.which("tui-test");
const repo = path.resolve(import.meta.dir, "../../../..");

// Exercise the public source CLI and its automatic decision panels, not a
// synthetic controller status. Model traffic is isolated to the local fixture.
for (const endorsesBlockedProposal of [false, true]) {
	test.skipIf(!tuiTest)(
		endorsesBlockedProposal
			? "TUI blocks a forbidden endorsement after a negated adoption clause"
			: "TUI advances an excluded-proposal report through candidate selection to plan approval",
		async () => {
			await using root = await TempDir.create("@omp-dev-report-tui-");
			await using provider = createProviderFixture({
				teamSynthesis: {
					reportMarkdown: [
						"### 方案 A（未通过审查，不作为可采用选项）",
						"方案 A 不作为可采用选项；其默认空白名字处理违反已批准需求。",
						...(endorsesBlockedProposal ? ["但仍建议采用方案 A。"] : []),
						"### 方案 B\n空白名字返回 world，保留内部空格。",
					].join("\n\n"),
					recommendedProposal: "B",
					recommendationReason: "方案 B 满足已批准的空白名字与空格保留要求。",
					recommendationPreconditions: "",
					hardConstraintViolations: [
						{
							proposalLabel: "A",
							issue: "空白名字未返回 world",
							evidence: "已批准需求明确要求空白名字默认返回 world。",
						},
					],
				},
			});
			const cwd = root.join("project");
			const home = root.join("home");
			const agentDir = root.join("config", "agent");
			const temp = root.join("tmp");
			for (const directory of [cwd, home, agentDir, temp]) await fs.mkdir(directory, { recursive: true });
			await Bun.write(
				path.join(agentDir, "models.yml"),
				`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 200000\n      - id: chat-b\n        reasoning: false\n        contextWindow: 200000\n`,
			);
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ncomposer:\n  predictions: false\nstartup:\n  setupWizard: false\n  checkUpdate: false\nasync:\n  enabled: false\nteam:\n  members:\n    - spec-fixture/chat-a\n    - spec-fixture/chat-b\n",
			);
			const session = `dev-report-${crypto.randomUUID()}`;
			async function tui(...args: string[]): Promise<string> {
				if (!tuiTest) throw new Error("tui-test is required for the real TUI regression");
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
			async function status(): Promise<SpecDrivenStatus> {
				const files = [...new Bun.Glob(".omp/spec-sessions/*/state.json").scanSync({ cwd })];
				expect(files).toHaveLength(1);
				const saved: { status: SpecDrivenStatus } = await Bun.file(path.join(cwd, files[0]!)).json();
				return saved.status;
			}
			async function chooseFirst(label: string): Promise<void> {
				const screen = await tui("text");
				const selection = /操作（(\d+)\//u.exec(screen);
				if (!selection) throw new Error(`Decision panel is not visible:\n${screen}`);
				const up = Number(selection[1]) - 1;
				if (up) await tui("key", "press", ...Array<string>(up).fill("Up"));
				await tui("expect", "text", `› 【阶段决策】${label}`, "--timeout", "30000");
				await tui("key", "press", "Enter");
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
					...Object.entries({
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
						NO_PROXY: "127.0.0.1,localhost",
						OPENSPEC_TELEMETRY: "0",
						DO_NOT_TRACK: "1",
					}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
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
				await tui("submit", "/dev");
				await tui("expect", "text", "尚未启动", "--timeout", "30000");
				await tui("submit", `/dev start report-regression ${MARKER}: ${REQUIREMENT}`);
				await tui("expect", "text", "确认需求并进入方案", "--timeout", "30000");
				expect((await status()).phase).toBe("awaiting-specification");
				expect(provider.requests.length).toBeGreaterThan(0);
				expect(provider.failures).toEqual([]);
				await chooseFirst("确认需求并进入方案");
				if (endorsesBlockedProposal) {
					await tui("expect", "text", "Team failed", "--timeout", "30000");
					const blocked = await status();
					expect(blocked).toMatchObject({ phase: "team", paused: true });
					expect(blocked.plan).toBeUndefined();
					expect(blocked.blockedReason).toContain("Team failed");
				} else {
					await tui("expect", "text", "查看方案比较与审查报告", "--timeout", "30000");
					const choice = await status();
					expect(choice.phase).toBe("awaiting-choice");
					expect(choice.team?.candidates.find(candidate => candidate.label === "A")).toMatchObject({
						adoptable: false,
					});
					expect(choice.team?.candidates.find(candidate => candidate.label === "B")).toMatchObject({
						adoptable: true,
					});
					expect(await tui("text")).not.toContain("采用A：");
					// Closing and resizing must not approve or choose anything.
					await tui("key", "press", "Escape");
					await tui("resize", "100", "28");
					await tui("type", "未提交的草稿");
					expect((await status()).phase).toBe("awaiting-choice");
					await tui("key", "press", "Ctrl+U");
					await tui("submit", "/dev help");
					await tui("expect", "text", "查看方案比较与审查报告", "--timeout", "30000");
					await chooseFirst("采用B：");
					await tui("expect", "text", "查看计划、验证与授权", "--timeout", "30000");
					const planned = await status();
					expect(planned.phase).toBe("awaiting-plan");
					expect(planned.selection?.candidateId).toBe(
						choice.team?.candidates.find(candidate => candidate.label === "B")?.id,
					);
					expect(planned.planApproval).toBeUndefined();
					expect(await Bun.file(path.join(cwd, "src/greeting.ts")).exists()).toBe(false);
					console.log(await tui("text"));
				}
				expect(provider.failures).toEqual([]);
			} catch (error) {
				console.error(await tui("text", "--full"));
				throw error;
			} finally {
				await tui("close");
			}
		},
		120_000,
	);
}
