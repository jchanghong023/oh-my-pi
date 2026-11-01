import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AgentRegistry } from "../../../src/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionResult } from "../../../src/sdk";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { SessionManager } from "../../../src/session/session-manager";
import { crawlBrowserRequest, writeCrawlMarkdown } from "../../../src/tools/browser/crawl-access";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

let directory: TempDir;
let auth: AuthStorage;
let created: CreateAgentSessionResult | undefined;

async function createSession(settings: Record<string, unknown> = {}): Promise<CreateAgentSessionResult> {
	created = await createAgentSession({
		cwd: directory.path(),
		agentDir: directory.path(),
		sessionManager: SessionManager.inMemory(directory.path()),
		settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, directory.join("models.yml")),
		model: getBundledModel("openai", "gpt-4o-mini"),
		agentRegistry: new AgentRegistry(),
		bindProcessState: false,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: ["write", "eval"],
		restrictToolNames: false,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return created;
}

beforeEach(() => {
	directory = TempDir.createSync("crawl-access-");
	auth = createInMemoryAuthStorage();
});

afterEach(async () => {
	await created?.session.dispose();
	created = undefined;
	auth.close();
	directory.removeSync();
});

describe("crawl session access", () => {
	it("rejects a disabled browser before dispatch", async () => {
		const { session } = await createSession({ "browser.enabled": false });
		await expect(crawlBrowserRequest(session, { action: "tabs" })).rejects.toThrow(/not enabled/);
	});

	it("applies the real browser deny policy before dispatch", async () => {
		const { session } = await createSession({ "browser.enabled": true, "tools.approval": { browser: "deny" } });
		await expect(crawlBrowserRequest(session, { action: "tabs" })).rejects.toThrow(/blocked by user policy/);
	});

	it("fails closed when browser approval needs a UI", async () => {
		const { session } = await createSession({ "browser.enabled": true, "tools.approval": { browser: "prompt" } });
		await expect(crawlBrowserRequest(session, { action: "tabs" })).rejects.toThrow(/no interactive UI/);
	});

	it("does not create a directory on write denial or missing approval UI", async () => {
		const { session } = await createSession({ "tools.approval": { write: "deny" } });
		await expect(writeCrawlMarkdown(session, "denied/nested", "page.md", "text")).rejects.toThrow(
			/blocked by user policy/,
		);
		expect(await Bun.file(directory.join("denied/nested/page.md")).exists()).toBe(false);
		await expect(fs.stat(directory.join("denied"))).rejects.toThrow();
	});

	it("honors an interactive browser denial before dispatch", async () => {
		const result = await createSession({ "browser.enabled": true, "tools.approval": { browser: "prompt" } });
		result.setToolUIContext({ approve: async () => "deny" } as never, true);
		await expect(crawlBrowserRequest(result.session, { action: "tabs" })).rejects.toThrow(/denied by user/);
	});

	it("requires approval for restricted output even in yolo mode", async () => {
		const { session } = await createSession({ "tools.approvalMode": "yolo", "tools.restrictedFolders": ["private"] });
		await expect(writeCrawlMarkdown(session, "private/nested", "page.md", "text")).rejects.toThrow(
			/no interactive UI/,
		);
		await expect(fs.stat(directory.join("private"))).rejects.toThrow();
	});

	it("does not create a file after an interactive denial", async () => {
		const result = await createSession({ "tools.approval": { write: "prompt" } });
		result.setToolUIContext({ approve: async () => "deny" } as never, true);
		await expect(writeCrawlMarkdown(result.session, "rejected", "page.md", "text")).rejects.toThrow(/denied by user/);
		await expect(fs.stat(directory.join("rejected"))).rejects.toThrow();
	});

	it("creates independent UTF-8 files without overwriting on concurrent collisions", async () => {
		const { session } = await createSession({ "tools.approvalMode": "yolo" });
		await fs.mkdir(directory.join("out"));
		await fs.writeFile(directory.join("out/page.md"), "existing", "utf8");
		const contents = ["来源一", "来源二", "来源三", "来源四"];
		const paths = await Promise.all(contents.map(content => writeCrawlMarkdown(session, "out", "page.md", content)));
		expect(new Set(paths).size).toBe(contents.length);
		expect(await fs.readFile(directory.join("out/page.md"), "utf8")).toBe("existing");
		expect(await Promise.all(paths.map(target => fs.readFile(target, "utf8")))).toEqual(contents);
	});

	it("does not write for an already aborted request", async () => {
		const { session } = await createSession();
		const controller = new AbortController();
		controller.abort();
		await expect(writeCrawlMarkdown(session, "cancelled", "page.md", "text", controller.signal)).rejects.toThrow();
		await expect(fs.stat(directory.join("cancelled"))).rejects.toThrow();
	});
});
