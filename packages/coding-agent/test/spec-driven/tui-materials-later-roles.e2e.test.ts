import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { REQUIREMENT } from "./provider-fixture";
import { clearNativeDraft, eventually, expectNativeFailure, tuiTest, withTui } from "./tui-harness";
import { registerMaterialFailureTests } from "./tui-materials-cases";

registerMaterialFailureTests(["solution", "executor"]);

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
