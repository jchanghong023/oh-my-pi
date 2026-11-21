import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { astEdit } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { ToolChoiceQueue } from "../src/session/tool-choice-queue";
import type { ToolSession } from "../src/tools";
import { AstEditTool } from "../src/tools/ast-edit";

describe("failed native AST apply", () => {
	for (const scope of ["single root", "multiple roots"] as const) {
		it(`reports uncertain writes after partial apply in ${scope}`, async () => {
			const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-partial-"));
			const cwd = path.join(temp, "project");
			const firstDir = path.join(cwd, "first");
			const secondDir = path.join(cwd, "second");
			await fs.mkdir(firstDir, { recursive: true });
			await fs.mkdir(secondDir, { recursive: true });
			const firstFile = path.join(firstDir, "first.ts");
			const secondFile = path.join(secondDir, "second.ts");
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
			const errorLog = spyOn(logger, "error").mockImplementation(() => {});
			try {
				let applyCalls = 0;
				const tool = new AstEditTool(session, async options => {
					if (options.dryRun) return astEdit(options);
					applyCalls++;
					await Bun.write(firstFile, "modernWrap(firstValue, firstArg)\n");
					throw new Error("Failed to write second.ts: permission denied");
				});
				const preview = await tool.execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: scope === "single root" ? [cwd] : [firstDir, secondDir],
				});
				expect(preview.details).toMatchObject({ applied: false, totalReplacements: 2 });
				expect(applyCalls).toBe(0);
				expect(await Bun.file(firstFile).text()).toBe("legacyWrap(firstValue, firstArg)\n");
				expect(await Bun.file(secondFile).text()).toBe("legacyWrap(secondValue, secondArg)\n");
				// The real preview and resolve flow and filesystem remain in use;
				// the injected native apply simulates one commit followed by a failed write.
				const invoker = queue.peekPendingInvoker();
				expect(invoker).toBeDefined();
				await expect(invoker!({ action: "apply", reason: "apply preview" })).rejects.toThrow(
					"Failed to write second.ts: permission denied",
				);
				expect(applyCalls).toBe(1);
				expect(await Bun.file(firstFile).text()).toBe("modernWrap(firstValue, firstArg)\n");
				expect(await Bun.file(secondFile).text()).toBe("legacyWrap(secondValue, secondArg)\n");
				expect(errorLog).toHaveBeenCalledWith(
					"Deferred AST edit apply failed",
					expect.objectContaining({
						event: "ast_edit_deferred_apply_failed",
						stage: "native_apply",
						result: "failed",
						candidate_count: 2,
						reported_written_count: "unknown",
						possible_partial_write: true,
					}),
				);
			} finally {
				errorLog.mockRestore();
				await fs.rm(temp, { recursive: true, force: true });
			}
		});
	}
});
