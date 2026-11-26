import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { astEdit } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { ToolChoiceQueue } from "../src/session/tool-choice-queue";
import type { ToolSession } from "../src/tools";
import { AstEditTool } from "../src/tools/ast-edit";

it("reports uncertain writes after a native directory apply commits only part of the preview", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-partial-"));
	const errorLog = spyOn(logger, "error").mockImplementation(() => {});
	try {
		const firstFile = path.join(cwd, "first.ts");
		const secondFile = path.join(cwd, "second.ts");
		await Bun.write(firstFile, "legacyWrap(firstValue, firstArg)\n");
		await Bun.write(secondFile, "legacyWrap(secondValue, secondArg)\n");
		const queue = new ToolChoiceQueue();
		const session: ToolSession = {
			cwd,
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "tools.commands": false }),
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool", name: "resolve" }),
			steer: () => {},
		};
		const failure = new Error("Failed to write second.ts");
		const tool = new AstEditTool(session, async options => {
			if (options.dryRun) return astEdit(options);
			// Native apply can reject after committing one of the previewed files.
			await Bun.write(firstFile, "modernWrap(firstValue, firstArg)\n");
			throw failure;
		});
		await tool.execute("preview", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: [cwd],
		});
		const invoker = queue.peekPendingInvoker()!;
		await expect(invoker({ action: "apply", reason: "apply preview" })).rejects.toThrow(
			/^Apply failed: Failed to write second\.ts$/,
		);
		expect(await Bun.file(firstFile).text()).toBe("modernWrap(firstValue, firstArg)\n");
		expect(await Bun.file(secondFile).text()).toBe("legacyWrap(secondValue, secondArg)\n");
		expect(errorLog).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				event: "ast_edit_deferred_apply_failed",
				candidate_count: 2,
				reported_written_count: "unknown",
				possible_partial_write: true,
			}),
		);
	} finally {
		errorLog.mockRestore();
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
