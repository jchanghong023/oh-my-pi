import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MARKER, REQUIREMENT, rolePayload } from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeTranscript,
	tuiTest,
	withTui,
} from "./tui-harness";

for (const role of ["requirements", "solution", "planner", "executor"] as const) {
	for (const kind of ["missing", "malformed", "unknown"] as const) {
		test.skipIf(!tuiTest)(
			`native TUI next preserves ${role} on ${kind} formal material and retains editor focus`,
			async () => {
				await withTui({ fileFailure: { role, kind } }, [100, 28], async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					if (role !== "requirements") {
						await tui("submit", "/dev next");
						await stage("solution");
					}
					if (role === "planner" || role === "executor") {
						await tui("submit", "/dev next pure");
						await stage("planning");
					}
					if (role === "executor") {
						await tui("submit", "/dev next");
						await stage("executing");
					}
					const before = await state();
					const calls = provider.requests.length;
					const transcript = await nativeTranscript(before.run!, role);
					await tui("submit", role === "solution" ? "/dev next pure" : "/dev next");
					const material =
						role === "requirements"
							? `openspec/changes/${before.run!.changeId}${kind === "malformed" ? "" : "/specs/*/spec.md"}`
							: (entry(provider, role).outputPaths as string[])[0]!;
					const reason =
						kind !== "malformed"
							? role === "requirements"
								? /缺少需求规格/
								: role === "executor"
									? /缺少完成报告/
									: /ENOENT/
							: role === "requirements"
								? /Specification validation failed|Empty specification artifact/
								: role === "solution"
									? /valid JSON/
									: role === "planner"
										? /Empty specification artifact/
										: /Completion report requires/;
					await expectNativeFailure(tui, reason, material, role === "solution" ? "/dev next pure" : "/dev next");
					await idle();
					expect(await state()).toEqual(before);
					expect(provider.requests).toHaveLength(calls);
					expect(await nativeTranscript(before.run!, role)).toBe(transcript);
					await clearNativeDraft(tui);
					await tui("type", `retained-${role}-${kind}-draft`);
					await tui("expect", "text", `retained-${role}-${kind}-draft`, "--timeout", "30000");
					expect(provider.requests).toHaveLength(calls);
				});
			},
			180_000,
		);
	}
}

test.skipIf(!tuiTest)(
	"native candidate decisions reject missing and invalid IDs, detect changed approval bytes and back only one stage",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			for (const raw of ["可以", "继续", "同意"]) {
				await tui("submit", raw);
				await tui("expect", "text", `${MARKER}_REQUIREMENTS_DIALOGUE: ${raw}`, "--timeout", "30000");
				await idle();
				expect((await state()).run?.phase).toBe("requirements");
				expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(false);
			}
			const calls = provider.requests.length;
			await tui("submit", "/dev next pure");
			await tui("expect", "text", "只有方案阶段允许", "--timeout", "30000");
			expect((await state()).run?.phase).toBe("requirements");
			expect(provider.requests).toHaveLength(calls);
			await clearNativeDraft(tui, "/dev next pure");
			await tui("submit", "/dev next");
			await stage("solution");
			const solution = await state();
			const solutionCalls = provider.requests.length;
			const solutionPath = (entry(provider, "solution").outputPaths as string[])[0]!;
			const completeSolution = await Bun.file(path.join(cwd, solutionPath)).text();
			const valid = JSON.parse(completeSolution).candidates[0];
			for (const [candidates, reason] of [
				[[], /at least one candidate/],
				[[valid, valid], /Duplicate solution candidate ID/],
				[[{ ...valid, id: "invalid id" }], /whitespace-free id/],
				[[{ ...valid, title: "" }], /nonempty title\/content/],
				[[{ ...valid, content: "" }], /nonempty title\/content/],
			] as const) {
				await Bun.write(path.join(cwd, solutionPath), JSON.stringify({ candidates }));
				await tui("submit", "/dev next pure");
				await expectNativeFailure(tui, reason, solutionPath, "/dev next pure");
				await idle();
				expect(await state()).toEqual(solution);
				expect(provider.requests).toHaveLength(solutionCalls);
				await clearNativeDraft(tui);
			}
			await Bun.write(path.join(cwd, solutionPath), completeSolution);
			for (const command of ["/dev next", "/dev next nonexistent"]) {
				await tui("submit", command);
				await tui("expect", "text", "请选择有效方案 ID", "--timeout", "30000");
				expect(await state()).toEqual(solution);
				expect(provider.requests).toHaveLength(solutionCalls);
				await clearNativeDraft(tui, command);
			}
			const proposal = (entry(provider, "requirements").outputPaths as string[])[0]!;
			const original = await Bun.file(path.join(cwd, proposal)).text();
			await Bun.write(path.join(cwd, proposal), `${original}\nExternal approved material edit.\n`);
			await tui("submit", "/dev next pure");
			await tui("expect", "text", "变化", "--timeout", "30000");
			expect(await state()).toEqual(solution);
			expect(provider.requests).toHaveLength(solutionCalls);
			await Bun.write(path.join(cwd, proposal), original);
			await clearNativeDraft(tui, "/dev next pure");
			await tui("submit", "/dev next normalizer");
			const planning = (await stage("planning")).run!;
			expect(entry(provider, "planner").candidateId).toBe("normalizer");
			const beforeBack = provider.requests.length;
			await tui("submit", "/dev back");
			await stage("solution");
			expect(provider.requests).toHaveLength(beforeBack);
			expect((await state()).run?.sessions.planner?.sessionId).toBe(planning.sessions.planner?.sessionId);
			expect((await state()).run?.approvals.solution).toBeUndefined();
			await tui("submit", "/dev back");
			await stage("requirements");
			expect(provider.requests).toHaveLength(beforeBack);
			expect(await Bun.file(path.join(cwd, proposal)).text()).toBe(original);
			expect(await Bun.file(path.join(cwd, (entry(provider, "planner").outputPaths as string[])[0]!)).exists()).toBe(
				true,
			);
		});
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"new initialization failure preserves saved Team and unrelated files and permits a fresh requirements run",
	async () => {
		await withTui({}, [100, 28], async ({ cwd, provider, tui, state, stage, idle }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", "/dev config");
			await tui("expect", "text", "方案 Team", "--timeout", "30000");
			await tui("key", "press", "Up", "Enter");
			const configured = await eventually(state, value => value.team);
			await Bun.write(path.join(cwd, "user-source.txt"), "preserve user work\n");
			await Bun.write(path.join(cwd, "openspec"), "real initializer path obstruction\n");
			const calls = provider.requests.length;
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await expectNativeFailure(tui, /OpenSpec change creation failed/, "openspec", `/dev new ${REQUIREMENT}`);
			await idle();
			expect(await state()).toEqual(configured);
			expect(provider.requests).toHaveLength(calls);
			expect(await Bun.file(path.join(cwd, "user-source.txt")).text()).toBe("preserve user work\n");
			await fs.unlink(path.join(cwd, "openspec"));
			await clearNativeDraft(tui);
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			expect((await state()).team).toBe(true);
			expect(await Bun.file(path.join(cwd, "user-source.txt")).text()).toBe("preserve user work\n");
		});
	},
	180_000,
);
