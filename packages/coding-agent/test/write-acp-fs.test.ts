import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FILE_CONTENT = "bridge write content\n";

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

function resultText(result: AgentToolResult): string {
	const text: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join("\n");
}

function expectWriteCard(args: { path: string; content: string }, result: AgentToolResult, changed: boolean): void {
	const previous = { ...chatTranscriptDisplayPreferences };
	const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
	const card = new ToolExecutionComponent("write", args, {}, undefined, ui);
	try {
		card.updateResult(result, false);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		card.setToolActivityVisible(true);
		const detailed = Bun.stripANSI(card.render(120).join("\n"));
		expect(detailed).toContain(args.content.split("\n")[0]);

		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		card.setToolActivityVisible(false);
		const compact = Bun.stripANSI(card.render(120).join("\n"));
		if (changed) expect(compact).toBe(detailed);
		else expect(compact).toBe("");
	} finally {
		card.dispose();
		setChatTranscriptDisplayPreferences(previous);
	}
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes plain text writes through the bridge and does not call Bun.write", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, { bridge });
			const tool = new WriteTool(session);

			await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("keys the returned snapshot header on bridge-transformed disk content", async () => {
		const filePath = path.join(tmpDir, "formatted.ts");
		const requested = "function f() {\n    return 1;\n}\n";
		const persisted = "function f() {\n\treturn 1;\n}\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: target, content }) => {
				await Bun.write(target, content.replace(/^ {4}/gm, "\t"));
			},
		};
		const session = createSession(tmpDir, { bridge });

		const result = await new WriteTool(session).execute("call-drift", { path: filePath, content: requested });
		const text = resultText(result);

		expect(await Bun.file(filePath).text()).toBe(persisted);
		expect(text).toContain(`[formatted.ts#${hashlineFileHash(persisted)}]`);
		expect(text).not.toContain(`[formatted.ts#${hashlineFileHash(requested)}]`);
	});

	it("retains bridge write cards when formatted disk content is unchanged or changed", async () => {
		const filePath = path.join(tmpDir, "formatted-existing.ts");
		const original = "function f() {\n\treturn 1;\n}\n";
		await fs.writeFile(filePath, original);
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: target, content }) => {
				await fs.writeFile(target, content.replace(/^ {4}/gm, "\t"));
			},
		};
		const tool = new WriteTool(createSession(tmpDir, { bridge }));
		const same = { path: filePath, content: "function f() {\n    return 1;\n}\n" };
		const unchanged = await tool.execute("bridge-unchanged", same);
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
		expectWriteCard(same, unchanged, true);

		const changedArgs = { path: filePath, content: "function f() {\n    return 2;\n}\n" };
		const changed = await tool.execute("bridge-changed", changedArgs);
		expect(await fs.readFile(filePath, "utf8")).toBe("function f() {\n\treturn 2;\n}\n");
		expectWriteCard(changedArgs, changed, true);
	});

	it("retains the original detailed card for oversized and file URL writes", async () => {
		const filePath = path.join(tmpDir, "large.txt");
		const original = `before marker\n${`${"a".repeat(64)}\n`.repeat(510)}`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const same = { path: filePath, content: original };
		const unchanged = await tool.execute("large-unchanged", same);
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
		expectWriteCard(same, unchanged, true);

		const changedArgs = { path: filePath, content: `after_ marker\n${`${"b".repeat(64)}\n`.repeat(510)}` };
		const changed = await tool.execute("large-changed", changedArgs);
		expect(await fs.readFile(filePath, "utf8")).toBe(changedArgs.content);
		expectWriteCard(changedArgs, changed, true);

		const urlArgs = { path: "local://url.txt", content: "URL write marker\n" };
		const urlPath = resolveLocalUrlToPath(urlArgs.path, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		const created = await tool.execute("url-created", urlArgs);
		expect(await fs.readFile(urlPath, "utf8")).toBe(urlArgs.content);
		expectWriteCard(urlArgs, created, true);
		const sameUrl = await tool.execute("url-unchanged", urlArgs);
		expect(await fs.readFile(urlPath, "utf8")).toBe(urlArgs.content);
		expectWriteCard(urlArgs, sameUrl, true);
		const updatedArgs = { ...urlArgs, content: "Updated URL write marker\n" };
		const updated = await tool.execute("url-updated", updatedArgs);
		expect(await fs.readFile(urlPath, "utf8")).toBe(updatedArgs.content);
		expectWriteCard(updatedArgs, updated, true);
	});

	it("emits a progress snapshot before filesystem writes complete", async () => {
		const filePath = path.join(tmpDir, "progress.txt");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const updates: AgentToolResult[] = [];

		const result = await tool.execute(
			"call-progress",
			{ path: filePath, content: FILE_CONTENT },
			undefined,
			update => {
				updates.push(update);
			},
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content).toEqual([
			{ type: "text", text: `Writing ${FILE_CONTENT.length} bytes to progress.txt...` },
		]);
		expect(updates[0]?.details).toEqual({ resolvedPath: filePath });
		expect(resultText(result)).toContain(`Successfully wrote ${FILE_CONTENT.length} bytes to progress.txt`);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("Internal error");
			},
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-plan", { path: planPath, content: planContent });

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(planPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(planContent);
	});

	it("treats bracketed `[local://...#TAG]` headers as local artifacts, not bridge writes", async () => {
		const planPath = "local://PLAN.md";
		const scratchPath = "local://scratch.md";
		// Active plan file is unrelated to the scratch artifact we are writing.
		const bracketedScratch = `[${scratchPath}#ABCD]`;
		const scratchContent = "scratch notes\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-bracketed", { path: bracketedScratch, content: scratchContent });

		// Bracketed local headers must not slip past the bridge router — they are
		// still session-local artifacts and stay on disk under the local sandbox.
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(scratchPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(scratchContent);
	});

	it("rejects read-only internal URLs without creating scheme-looking paths on disk", async () => {
		const targetPath = "memory://root/memory_summary.md";
		const leakedPath = path.join(tmpDir, "memory:/root/memory_summary.md");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);

		let rejection: unknown;
		try {
			await tool.execute("call-memory", { path: targetPath, content: "memory summary\n" });
		} catch (error) {
			rejection = error;
		}

		expect(await Bun.file(leakedPath).exists()).toBe(false);
		if (!(rejection instanceof Error)) throw new Error("Expected memory:// write to reject");
		expect(rejection.message).toContain("memory:// URLs are read-only for write");
	});
});
