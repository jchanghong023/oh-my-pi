import { expect, test } from "bun:test";
import * as path from "node:path";
import { MARKER, REQUIREMENT, rolePayload } from "./provider-fixture";
import { clearNativeDraft, entry, expectNativeFailure, tuiTest, withTui } from "./tui-harness";
import { registerMaterialFailureTests } from "./tui-materials-cases";

registerMaterialFailureTests(["requirements", "planner"]);

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
				await Bun.write(
					path.join(cwd, solutionPath),
					JSON.stringify({ candidates, recommendedCandidateId: "pure" }),
				);
				await tui("submit", "/dev next pure");
				await expectNativeFailure(tui, reason, solutionPath, "/dev next pure");
				await idle();
				expect(await state()).toEqual(solution);
				expect(provider.requests).toHaveLength(solutionCalls);
				await clearNativeDraft(tui);
			}
			for (const recommendedCandidateId of [undefined, "missing"]) {
				await Bun.write(
					path.join(cwd, solutionPath),
					JSON.stringify({
						candidates: JSON.parse(completeSolution).candidates,
						recommendedCandidateId,
					}),
				);
				await tui("submit", "/dev next pure");
				await expectNativeFailure(tui, /recommendedCandidateId/, solutionPath, "/dev next pure");
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
