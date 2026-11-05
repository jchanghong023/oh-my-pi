import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { astEdit } from "@oh-my-pi/pi-natives";
import { Settings } from "../src/config/settings";
import { ToolChoiceQueue } from "../src/session/tool-choice-queue";
import type { ToolSession } from "../src/tools";
import { AstEditTool } from "../src/tools/ast-edit";
import { subscribeFsMutation } from "../src/tools/fs-cache-invalidation";

describe("failed AST apply mutation notifications", () => {
	for (const scope of ["single root", "multiple roots"] as const) {
		it(`notifies possibly committed files after partial apply in ${scope}`, async () => {
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
			const mutations: Array<{ paths: readonly string[]; reason?: string }> = [];
			const unsubscribe = subscribeFsMutation((paths, reason) => mutations.push({ paths, reason }));
			const queue = new ToolChoiceQueue();
			const session: ToolSession = {
				cwd,
				hasUI: true,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "tools.xdev": false }),
				getToolChoiceQueue: () => queue,
				buildToolChoice: () => ({ type: "tool", name: "resolve" }),
				steer: () => {},
			};
			try {
				let applyCalls = 0;
				const tool = new AstEditTool(session, async options => {
					if (options.dryRun) return astEdit(options);
					applyCalls++;
					await Bun.write(firstFile, "modernWrap(firstValue, firstArg)\n");
					throw new Error("Failed to write second.ts: permission denied");
				});
				await tool.execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: scope === "single root" ? [cwd] : [firstDir, secondDir],
				});
				expect(mutations).toEqual([]);
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
				expect(mutations).toEqual([
					{
						paths: expect.arrayContaining([firstFile, secondFile]),
						reason: expect.any(String),
					},
				]);
			} finally {
				unsubscribe();
				await fs.rm(temp, { recursive: true, force: true });
			}
		});
	}
});
