import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalGrantKey, SessionApprovals } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries, spillUrlIds, spillUrl } from "@oh-my-pi/pi-utils";

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe("local:// spill reads through session approval", () => {
	let root: string;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spill-approval-"));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		else await sessionManager?.close();
		authStorage?.close();
		session = undefined;
		sessionManager = undefined;
		authStorage = undefined;
		await removeWithRetries(root);
	});

	it.each([
		["main", 0],
		["subagent", 1],
	] as const)(
		"%s sessions can recover bash's advertised output with restricted folders configured",
		async (_kind, taskDepth) => {
			const cwd = path.join(root, "cwd");
			await fs.mkdir(cwd);
			sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
			authStorage = await AuthStorage.create(":memory:");
			const created = await createAgentSession({
				cwd,
				agentDir: path.join(root, "agent"),
				sessionManager,
				authStorage,
				settings: Settings.isolated({
					"tools.approvalMode": "yolo",
					"tools.restrictedFolders": [path.join(root, "restricted")],
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				bindProcessState: false,
				taskDepth,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["bash", "read"],
			});
			session = created.session;
			const bash = session.getToolByName("bash");
			const read = session.getToolByName("read");
			if (!bash || !read) throw new Error("Expected bash and read tools");

			const produced = await bash.execute("produce", {
				command: "printf 'artifact-start-'; printf '%010000d' 0; printf -- '-artifact-end'",
			});
			const [id] = spillUrlIds(textOf(produced));
			expect(id).toBeDefined();
			const hint = `${spillUrl(id!)}:raw:1-1`;

			const recovered = await read.execute("recover", { path: hint });
			expect(textOf(recovered)).toBe(`artifact-start-${"0".repeat(10_000)}-artifact-end`);
		},
	);

	function toolSession(localRoot = root): ToolSession {
		return {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => localRoot },
			settings: Settings.isolated(),
		};
	}

	const readTool = (localRoot = root) => new ReadTool(toolSession(localRoot));

	it("reuses a spill grant across selectors but not for another spill, session root, or restricted folder", () => {
		const read = readTool();
		const grants = new SessionApprovals();
		const target = "local://54.log:raw:4-4";
		const key = read.approvalCacheTargets({ path: target })?.[0];
		expect(key).toBeDefined();
		expect(resolveApproval(read, { path: target }, "always-ask-cached", {}, grants).policy).toBe("prompt");
		grants.record(approvalGrantKey("read", key!));
		expect(resolveApproval(read, { path: target }, "always-ask-cached", {}, grants).policy).toBe("allow");
		expect(resolveApproval(read, { path: "local://54.log:5-10" }, "always-ask-cached", {}, grants).policy).toBe(
			"allow",
		);
		expect(resolveApproval(read, { path: "local://55.log:raw:4-4" }, "always-ask-cached", {}, grants).policy).toBe(
			"prompt",
		);
		const other = readTool(path.join(root, "other"));
		expect(resolveApproval(other, { path: target }, "always-ask-cached", {}, grants).policy).toBe("prompt");
		expect(
			resolveApproval(read, { path: target }, "always-ask-cached", {}, grants, {
				restrictedFolders: [path.join(root, "local")],
			}),
		).toMatchObject({ source: "restriction", policy: "prompt", override: true });
	});

	it("requires per-call approval for local scratch writes and Bash working directories under restricted folders", () => {
		const session = toolSession();
		const restrictions = { cwd: root, restrictedFolders: [path.join(root, "local", "private")] };
		const write = new WriteTool(session);
		const bash = new BashTool(session);
		expect(
			resolveApproval(write, { path: "local://private/a.txt", content: "a" }, "yolo", {}, undefined, restrictions),
		).toMatchObject({ source: "restriction", policy: "prompt", override: true });
		expect(
			resolveApproval(bash, { command: "pwd", cwd: "local://private" }, "yolo", {}, undefined, restrictions),
		).toMatchObject({ source: "restriction", policy: "prompt", override: true });
	});

	it("does not reuse an SSH exec grant, even for the same authority and selector", () => {
		const read = readTool();
		const grants = new SessionApprovals();
		grants.record(approvalGrantKey("exec", "ssh://example.test:2222/log.txt"));

		expect(
			resolveApproval(read, { path: "ssh://example.test:2222/log.txt:raw:4-4" }, "always-ask-cached", {}, grants),
		).toMatchObject({ policy: "prompt", tier: "exec" });
	});

	it.skipIf(process.platform === "win32")(
		"keeps literal colon filenames separate from a base file's grant",
		async () => {
			await Bun.write(path.join(root, "notes.txt"), "base content");
			await Bun.write(path.join(root, "notes.txt:1"), "literal content");
			const read = readTool();
			const grants = new SessionApprovals();
			grants.record(approvalGrantKey("read", approvalTargetKey(root, "notes.txt")!));

			expect(resolveApproval(read, { path: "notes.txt:1" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
			grants.record(approvalGrantKey("read", approvalTargetKey(root, "notes.txt:1")!));
			expect(resolveApproval(read, { path: "notes.txt:1" }, "always-ask-cached", {}, grants).policy).toBe("allow");
			expect(textOf(await read.execute("literal", { path: "notes.txt:1" }))).toContain("literal content");
		},
	);
});
