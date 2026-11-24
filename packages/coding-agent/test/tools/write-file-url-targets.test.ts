import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, VaultProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as vaultProtocol from "@oh-my-pi/pi-coding-agent/internal-urls/vault-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { initTheme } from "../../src/ui/theme/service";
import { toolCall, toolCallText } from "../helpers/tool-text";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated({ "edit.mode": "replace" }),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

function expectWriteCard(
	args: { path: string; content: string },
	result: AgentToolResult,
	marker?: string,
	partial = false,
): void {
	const call = toolCall({ name: "write", args, result, partial });
	const detailed = toolCallText(call);
	expect(detailed.length).toBeGreaterThan(0);
	if (marker) expect(detailed).toContain(marker);
	call.setActivityVisible(false);
	expect(toolCallText(call)).toBe("");
}

describe("write to file-backed internal URLs", () => {
	let tmpDir: string;
	let vaultRoot: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-file-urls-"));
		vaultRoot = path.join(tmpDir, "vault");
		await fs.mkdir(path.join(vaultRoot, "Folder"), { recursive: true });
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
		VaultProtocolHandler.setVaultDirectoryForTests({ Work: vaultRoot });
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
		await removeWithRetries(tmpDir);
	});

	it("writes vault:// through the file pipeline at write tier, creating parents and naming the URL", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const args = { path: "vault://Work/new/deep/note.md", content: "# Note\n" };

		expect(tool.approval(args)).toBe("write");
		const result = await tool.execute("vault-write", args);

		expect(await Bun.file(path.join(vaultRoot, "new", "deep", "note.md")).text()).toBe("# Note\n");
		expect(resultText(result)).toContain("vault://Work/new/deep/note.md");
		expect(resultText(result)).not.toContain(vaultRoot);
	});

	it("renders vault write cards only in detailed mode", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const file = path.join(vaultRoot, "note.md");
		const args = { path: "vault://Work/note.md", content: "Vault first marker\n" };
		for (const [id, input] of [
			["created", args],
			["unchanged", args],
			["updated", { ...args, content: "Vault updated marker\n" }],
		] as const) {
			const result = await tool.execute(id, input);
			expect(await fs.readFile(file, "utf8")).toBe(input.content);
			expectWriteCard(input, result, input.content.trim());
		}
	});

	it("renders handler-backed and partial write cards only in detailed mode", () => {
		for (const target of ["agent://peer", "proc://job", "cfg://display/test"]) {
			const args = { path: target, content: "Not a file" };
			expectWriteCard(args, {
				content: [{ type: "text", text: "Not a file" }],
				details: { fileChanged: true, path: "/tmp/file", resolvedPath: "/tmp/file" },
			});
			expectWriteCard(args, {
				content: [{ type: "text", text: "Not a file" }],
				details: { conflictChanges: [{ path: "/tmp/file", diff: "-old\n+new" }] },
			});
		}
		expectWriteCard(
			{ path: "vault://Work/note.md", content: "Unverified" },
			{
				content: [{ type: "text", text: "Unverified" }],
				details: {},
			},
		);
		expectWriteCard(
			{ path: "vault://Work/note.md", content: "Preview" },
			{
				content: [{ type: "text", text: "Preview" }],
				details: { resolvedPath: "/tmp/file" },
			},
			undefined,
			true,
		);
	});

	it("renders file and handler-backed URL write cards only in detailed mode without change metadata", () => {
		for (const target of [
			"file:///tmp/note.txt",
			"local://note.txt",
			"ssh://example.test/tmp/note.txt",
			"conflict://1",
		]) {
			expectWriteCard({ path: target, content: "replacement" }, { content: [{ type: "text", text: "unchanged" }] });
		}
	});

	it("refuses vault:// writes while vault.enabled is off", async () => {
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(false);

		await expect(
			new WriteTool(createSession(tmpDir)).execute("vault-disabled", {
				path: "vault://Work/note.md",
				content: "x\n",
			}),
		).rejects.toThrow("vault:// is disabled");
		expect(await fs.exists(path.join(vaultRoot, "note.md"))).toBe(false);
	});

	it("refuses a URL write that resolves to an existing directory", async () => {
		await fs.mkdir(path.join(tmpDir, "artifacts", "local", "drafts"), { recursive: true });
		const tool = new WriteTool(createSession(tmpDir));

		await expect(tool.execute("vault-dir", { path: "vault://Work/Folder", content: "x\n" })).rejects.toThrow(
			"vault:// URL must resolve to a file",
		);
		await expect(tool.execute("local-dir", { path: "local://drafts", content: "x\n" })).rejects.toThrow(
			"local:// URL must resolve to a file",
		);
		expect((await fs.stat(path.join(vaultRoot, "Folder"))).isDirectory()).toBe(true);
	});
});
