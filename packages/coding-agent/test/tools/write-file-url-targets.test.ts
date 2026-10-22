import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, VaultProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as vaultProtocol from "@oh-my-pi/pi-coding-agent/internal-urls/vault-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

describe("write to file-backed internal URLs", () => {
	let tmpDir: string;
	let vaultRoot: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
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

	it("returns exact bounded create and update checkpoints through the tool result", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const file = path.join(tmpDir, "checkpoint.txt");
		const created = await tool.execute("create-checkpoint", { path: file, content: "\uFEFFbefore\r\n" });
		expect(created.details).toMatchObject({
			op: "create",
			path: await fs.realpath(file),
			oldText: "",
			newText: "\uFEFFbefore\r\n",
		});
		const updated = await tool.execute("update-checkpoint", { path: file, content: "after\n" });
		expect(updated.details).toMatchObject({
			op: "update",
			oldText: "\uFEFFbefore\r\n",
			newText: "after\n",
		});
		expect(JSON.parse(JSON.stringify(updated.details)).oldText).toBe("\uFEFFbefore\r\n");
	});

	it("prunes oversized combined snapshots and binary or invalid UTF-8 prior bytes", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const file = path.join(tmpDir, "checkpoint.txt");
		for (const prior of [Buffer.from([0xff]), Buffer.from([0, 1]), Buffer.from("a".repeat(32_768))]) {
			await fs.writeFile(file, prior);
			const result = await tool.execute("pruned-checkpoint", { path: file, content: "after\n" });
			expect(result.details?.snapshotsPruned).toBe(true);
			expect(result.details?.oldText).toBeUndefined();
			expect(result.details?.newText).toBeUndefined();
			expect(await fs.readFile(file, "utf8")).toBe("after\n");
		}
	});

	it("retains snapshots at the budget boundary and prunes oversized new files", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const file = path.join(tmpDir, "budget.txt");
		const kept = await tool.execute("budget-kept", { path: file, content: "a".repeat(32_768) });
		expect(kept.details?.newText?.length).toBe(32_768);
		expect(kept.details?.snapshotsPruned).toBeUndefined();
		const oversized = await tool.execute("budget-pruned", {
			path: path.join(tmpDir, "oversized.txt"),
			content: "b".repeat(32_769),
		});
		expect(oversized.details).toMatchObject({ op: "create", snapshotsPruned: true });
		expect(oversized.details?.oldText).toBeUndefined();
		expect(oversized.details?.newText).toBeUndefined();
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
