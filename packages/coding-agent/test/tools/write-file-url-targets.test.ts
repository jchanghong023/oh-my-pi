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
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

function expectWriteCard(
	args: { path: string; content: string },
	result: AgentToolResult,
	visible: boolean,
	marker?: string,
	partial = false,
): void {
	const previous = { ...chatTranscriptDisplayPreferences };
	const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
	const card = new ToolExecutionComponent("write", args, {}, undefined, ui);
	try {
		card.updateResult(result, partial);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		card.setToolActivityVisible(true);
		const detailed = Bun.stripANSI(card.render(120).join("\n"));
		expect(detailed.length).toBeGreaterThan(0);
		if (marker) expect(detailed).toContain(marker);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		card.setToolActivityVisible(false);
		const compact = Bun.stripANSI(card.render(120).join("\n"));
		expect(compact).toBe(visible ? detailed : "");
	} finally {
		card.dispose();
		setChatTranscriptDisplayPreferences(previous);
	}
}

describe("write to file-backed internal URLs", () => {
	let tmpDir: string;
	let vaultRoot: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
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

	it("retains the original card for vault writes regardless of whether bytes changed", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const file = path.join(vaultRoot, "note.md");
		const args = { path: "vault://Work/note.md", content: "Vault first marker\n" };
		for (const [id, input, changed] of [
			["created", args, true],
			["unchanged", args, false],
			["updated", { ...args, content: "Vault updated marker\n" }, true],
		] as const) {
			const result = await tool.execute(id, input);
			expect(await fs.readFile(file, "utf8")).toBe(input.content);
			expect(result.details?.fileChanged).toBe(changed);
			expect(result.details?.path).toBe(await fs.realpath(file));
			expectWriteCard(input, result, true, input.content.trim());
		}
	});

	it("retains file URL writes dispatched through xd://write even when unchanged", async () => {
		const session = createSession(tmpDir);
		const inner = new WriteTool(session);
		const xdev: XdevState = {
			tools: new Map([[inner.name, inner]]),
			mountedNames: new Set([inner.name]),
			builtInNames: new Set([inner.name]),
			isActive: () => false,
			resolve: name => resolveXdevTool(xdev, name),
		};
		session.xdev = xdev;
		const outer = new WriteTool(session);
		const file = path.join(vaultRoot, "device.md");
		for (const [id, content, changed] of [
			["created", "Device first marker\n", true],
			["unchanged", "Device first marker\n", false],
			["updated", "Device updated marker\n", true],
		] as const) {
			const input = { path: "vault://Work/device.md", content };
			const args = { path: "xd://write", content: JSON.stringify(input) };
			const result = await outer.execute(`device-${id}`, args);
			expect(await fs.readFile(file, "utf8")).toBe(content);
			expect(result.details?.xdev).toMatchObject({
				tool: "write",
				mode: "execute",
				args: input,
				inner: { fileChanged: changed, path: await fs.realpath(file) },
			});
			expectWriteCard(args, result, true);
		}
	});

	it("classifies device and partial results by the target, not diff-like metadata", () => {
		for (const target of ["agent://peer", "proc://job", "cfg://display/test"]) {
			const args = { path: target, content: "Not a file" };
			expectWriteCard(
				args,
				{
					content: [{ type: "text", text: "Not a file" }],
					details: { fileChanged: true, path: "/tmp/file", resolvedPath: "/tmp/file" },
				},
				false,
			);
			expectWriteCard(
				args,
				{
					content: [{ type: "text", text: "Not a file" }],
					details: { conflictChanges: [{ path: "/tmp/file", diff: "-old\n+new" }] },
				},
				false,
			);
		}
		const wrapped = { path: "xd://write", content: JSON.stringify({ path: "agent://peer", content: "Message" }) };
		expectWriteCard(
			wrapped,
			{
				content: [{ type: "text", text: "Message" }],
				details: {
					xdev: {
						tool: "write",
						mode: "execute",
						args: { path: "agent://peer" },
						inner: { fileChanged: true, path: "/tmp/file", resolvedPath: "/tmp/file" },
					},
				},
			},
			false,
		);
		expectWriteCard(
			{ path: "vault://Work/note.md", content: "Unverified" },
			{
				content: [{ type: "text", text: "Unverified" }],
				details: { op: "create", newText: "Unverified" },
			},
			true,
		);
		expectWriteCard(
			{ path: "vault://Work/note.md", content: "Preview" },
			{
				content: [{ type: "text", text: "Preview" }],
				details: { fileChanged: true, path: "/tmp/file", resolvedPath: "/tmp/file" },
			},
			true,
			undefined,
			true,
		);
		for (const mode of ["help", "preview"] as const) {
			const args = { path: "xd://write", content: mode === "help" ? "?" : "{}" };
			expectWriteCard(
				args,
				{
					content: [{ type: "text", text: "Not a file" }],
					details: {
						xdev: {
							tool: "write",
							mode,
							args: { path: "vault://Work/note.md" },
							inner: { fileChanged: true, path: "/tmp/file", resolvedPath: "/tmp/file" },
						},
					},
				},
				false,
			);
		}
	});

	it("retains file and handler-backed URL targets without requiring change metadata", () => {
		for (const target of [
			"file:///tmp/note.txt",
			"local://note.txt",
			"ssh://example.test/tmp/note.txt",
			"conflict://1",
		]) {
			expectWriteCard(
				{ path: target, content: "replacement" },
				{ content: [{ type: "text", text: "unchanged" }], details: { fileChanged: false } },
				true,
			);
		}
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
			newText: await fs.readFile(file, "utf8"),
		});
		expect(JSON.parse(JSON.stringify(updated.details)).oldText).toBe("\uFEFFbefore\r\n");
	});

	it("distinguishes unchanged updates and creation of an empty file", async () => {
		const tool = new WriteTool(createSession(tmpDir));
		const existing = path.join(tmpDir, "unchanged.txt");
		await fs.writeFile(existing, "same\n");
		const same = await tool.execute("same-checkpoint", { path: existing, content: "same\n" });
		expect(await fs.readFile(existing, "utf8")).toBe("same\n");
		expect(same.details?.fileChanged).toBe(false);
		const changed = await tool.execute("changed-checkpoint", { path: existing, content: "different\n" });
		expect(await fs.readFile(existing, "utf8")).toBe("different\n");
		expect(changed.details?.fileChanged).toBe(true);

		const emptyPath = path.join(tmpDir, "empty.txt");
		const created = await tool.execute("empty-checkpoint", { path: emptyPath, content: "" });
		expect(await fs.readFile(emptyPath, "utf8")).toBe("");
		expect(created.details?.fileChanged).toBe(true);
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
