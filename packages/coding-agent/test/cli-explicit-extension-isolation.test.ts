import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { symlink, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgLspEnabled } from "@oh-my-pi/pi-coding-agent/lsp/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession, loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeAll(async () => {
	tempDir = await TempDir.create("@cli-explicit-extension-isolation-");
	authStorage = createInMemoryAuthStorage();
});

afterAll(async () => {
	authStorage.close();
	await tempDir.remove();
});

test.each(["-e", "--extension", "--hook", "--trusted-extension"])(
	"default CLI startup preserves %s while disabling ambient extensions and configured LSP",
	async flag => {
		const cwd = tempDir.join(`default-startup-${flag.replaceAll("-", "")}`);
		const extensionPath = path.join(cwd, "explicit.ts");
		await Bun.write(
			path.join(cwd, ".omp", "extensions", "ambient.ts"),
			'throw new Error("Ambient extension must not run during default CLI startup");',
		);
		await Bun.write(
			extensionPath,
			'export default function (pi) { pi.registerCommand("startup-fixture", { handler: async () => {} }); }',
		);
		const parsed = parseArgs([flag, extensionPath]);
		const settings = Settings.isolated({ "lsp.enabled": true, "lsp.lazy": false });
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(cwd), modelRegistry, settings);
		const extensions = await loadSessionExtensions(options, cwd, settings, new EventBus());
		expect(extensions.errors).toEqual([]);
		expect(extensions.extensions.map(extension => extension.resolvedPath)).toEqual([extensionPath]);
		const { session, lspServers } = await createAgentSession({
			...options,
			cwd,
			agentDir: cwd,
			modelRegistry,
			authStorage,
			settings,
			preloadedExtensions: extensions,
			hasUI: true,
			bindProcessState: false,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		try {
			expect(session.getAllToolNames()).not.toContain("lsp");
			expect(lspServers).toBeUndefined();
			expect(cfgLspEnabled.get(settings)).toBe(true);
			expect(options.enableLsp).toBe(false);
			expect(options.disableExtensionDiscovery).toBe(true);
			expect(options.skills).toBeUndefined();
			expect(options.rules).toBeUndefined();
			expect(options.noContextFiles).toBeUndefined();
			expect(
				session.extensionRunner?.getRegisteredCommands().some(command => command.name === "startup-fixture"),
			).toBe(true);
		} finally {
			await session.dispose();
		}
	},
);

test.each([
	{ name: "interactive", argv: [] },
	{ name: "print", argv: ["--print"] },
	{ name: "RPC", argv: ["--mode", "rpc"] },
	{ name: "ACP", argv: ["--mode", "acp"] },
])("first parse and extension-aware reparse retain lightweight defaults for $name", async ({ argv }) => {
	const explicit = tempDir.join("reparse-fixture.ts");
	const raw = [...argv, "--extension", explicit, "--probe-option", "value", "hello"];
	const flags = new Map([["probe-option", { type: "string" as const }]]);
	const first = parseArgs(raw);
	const reparsed = parseArgs(raw, flags);
	for (const parsed of [first, reparsed]) {
		expect(parsed.noLsp).toBe(true);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.extensions).toEqual([explicit]);
		expect(parsed.noSkills).toBeUndefined();
		expect(parsed.noRules).toBeUndefined();
		expect(parsed.noContextFiles).toBeUndefined();
	}
	expect(reparsed.unknownFlags.get("probe-option")).toBe("value");
	expect(reparsed.messages).toEqual(["hello"]);
	expect(raw).toEqual([...argv, "--extension", explicit, "--probe-option", "value", "hello"]);
});

// File symlinks require Developer Mode on Windows; the retargeting fixture cannot be built.
test.skipIf(process.platform === "win32")(
	"trusted extension allowlists are canonical and cannot be expanded by retargeting a symlink",
	async () => {
		const trustedTarget = tempDir.join("trusted-target.ts");
		const replacementDir = tempDir.join("replacement");
		const trustedLink = tempDir.join("trusted.ts");
		await Bun.write(trustedTarget, "export default function () {}");
		await Bun.write(`${replacementDir}/ambient.ts`, "export default function () {}");
		await symlink(trustedTarget, trustedLink);

		const parsed = parseArgs(["--trusted-extension", trustedLink]);
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.disableExtensionDiscovery).toBe(true);
		expect(options.additionalExtensionPaths).toEqual([realpathSync.native(trustedTarget)]);

		await unlink(trustedLink);
		await symlink(replacementDir, trustedLink);
		const result = await loadSessionExtensions(options, tempDir.path(), settings, new EventBus());

		expect(result.errors).toEqual([]);
		expect(result.extensions.map(extension => extension.resolvedPath)).toEqual([realpathSync.native(trustedTarget)]);
	},
);

test("buildSessionOptions rejects trusted extension directories", async () => {
	const parsed = parseArgs(["--trusted-extension", tempDir.path()]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	await expect(buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings)).rejects.toThrow(
		/module file, not a directory/,
	);
});
