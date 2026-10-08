import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { Settings } from "../src/config/settings";
import { RepoLifecycle } from "../src/repo/lifecycle";
import { RepoService } from "../src/repo/service";
import { ToolChoiceQueue } from "../src/session/tool-choice-queue";
import type { ToolSession } from "../src/tools";
import { AstEditTool } from "../src/tools/ast-edit";

describe("failed AST apply repository coverage", () => {
	for (const scope of ["single root", "multiple roots"] as const) {
		it(`refreshes possibly committed files and retains unchecked coverage after partial apply in ${scope}`, async () => {
			const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-partial-"));
			const cwd = path.join(temp, "project");
			const agentDir = path.join(temp, "agent");
			const firstDir = path.join(cwd, "first");
			const secondDir = path.join(cwd, "second");
			await fs.mkdir(firstDir, { recursive: true });
			await fs.mkdir(secondDir, { recursive: true });
			const firstFile = path.join(firstDir, "first.ts");
			const secondFile = path.join(secondDir, "second.ts");
			await Bun.write(firstFile, "legacyWrap(firstValue, firstArg)\n");
			await Bun.write(secondFile, "legacyWrap(secondValue, secondArg)\n");
			const service = new RepoService({ cwd, agentDir });
			const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
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
			let restoreApply: (() => void) | undefined;
			try {
				await service.build();
				lifecycle.start();
				await service.reconcile();
				const tool = new AstEditTool(session);
				await tool.execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: scope === "single root" ? [cwd] : [firstDir, secondDir],
				});
				expect((await service.status()).pendingPaths).toEqual([]);
				expect((await service.status()).unchecked).toBe(false);
				// Reproduce the native boundary: one commit followed by a failed write.
				// The real preview and resolve flow, filesystem, and index remain in use.
				const apply = spyOn(natives, "astEdit").mockImplementation(async () => {
					await Bun.write(firstFile, "modernWrap(firstValue, firstArg)\n");
					throw new Error("Failed to write second.ts: permission denied");
				});
				restoreApply = () => apply.mockRestore();
				const invoker = queue.peekPendingInvoker();
				expect(invoker).toBeDefined();
				await expect(invoker!({ action: "apply", reason: "apply preview" })).rejects.toThrow(
					"Failed to write second.ts: permission denied",
				);
				expect((await service.status()).pendingPaths.sort()).toEqual(["first/first.ts", "second/second.ts"]);
				expect((await service.search("modernWrap")).hits.map(hit => hit.path)).toEqual(["first/first.ts"]);
				expect((await service.search("legacyWrap")).hits.map(hit => hit.path)).toEqual(["second/second.ts"]);
				const status = await service.status();
				expect(status.pendingPaths).toEqual([]);
				expect(status.unchecked).toBe(true);
				expect(status.needsReconcile).toBe(true);
				expect(status.uncertainReasons).toContain(
					"AST edit apply failed; files may have been partially written; reconcile to verify coverage",
				);
			} finally {
				restoreApply?.();
				lifecycle.dispose();
				service.close();
				await fs.rm(temp, { recursive: true, force: true });
			}
		});
	}
});
