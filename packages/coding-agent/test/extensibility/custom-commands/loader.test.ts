import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { discoverCustomCommands, loadCustomCommands } from "../../../src/extensibility/custom-commands/loader";
import { SYMLINKS_USABLE } from "../../helpers/symlink-support";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let tempRoot: string | undefined;
let settingsState: SettingsTestState | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (settingsState) {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	}
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

function commandSource(name: string, description: string): string {
	return `export default () => ({ name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}, execute() {} });`;
}

async function makeCommandsRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	await fs.mkdir(path.join(root, "commands"), { recursive: true });
	return root;
}

describe("custom command loader", () => {
	it("keeps bundled commands without probing or executing external commands when discovery is disabled", async () => {
		tempRoot = await makeCommandsRoot("omp-custom-command-no-discovery-");
		settingsState = beginSettingsTest();
		setAgentDir(tempRoot);
		const projectCommands = path.join(tempRoot, ".omp", "commands");
		const marker = path.join(tempRoot, "imported.txt");
		for (const commandsDir of [path.join(tempRoot, "commands"), projectCommands]) {
			await Bun.write(
				path.join(commandsDir, "external-fixture", "index.js"),
				`await Bun.write(${JSON.stringify(marker)}, "imported");\n${commandSource("external-fixture", "External command")}`,
			);
		}
		const exists = vi.spyOn(syncFs, "existsSync");
		const readdir = vi.spyOn(fs, "readdir");

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot, discover: false });

		const externalDirs = new Set([path.join(tempRoot, "commands"), projectCommands].map(dir => path.resolve(dir)));
		const probes = [...exists.mock.calls, ...readdir.mock.calls]
			.map(([target]) => path.resolve(String(target)))
			.filter(target => [...externalDirs].some(dir => target === dir || target.startsWith(`${dir}${path.sep}`)));
		expect(probes).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.commands.map(({ command }) => command.name).sort()).toEqual(["annotate", "green", "review"]);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("allows external commands to override bundled commands when discovery is omitted", async () => {
		tempRoot = await makeCommandsRoot("omp-custom-command-override-");
		settingsState = beginSettingsTest();
		setAgentDir(tempRoot);
		const commandPath = path.join(tempRoot, "commands", "review", "index.js");
		await Bun.write(commandPath, commandSource("review", "External review"));

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot });

		expect(result.errors).toEqual([]);
		const reviews = result.commands.filter(({ command }) => command.name === "review");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.resolvedPath).toBe(commandPath);
		expect(reviews[0]?.source).toBe("user");
	});

	it("loads external commands when discovery is explicitly enabled", async () => {
		tempRoot = await makeCommandsRoot("omp-custom-command-discovery-");
		settingsState = beginSettingsTest();
		setAgentDir(tempRoot);
		await Bun.write(
			path.join(tempRoot, "commands", "external-fixture", "index.js"),
			commandSource("external-fixture", "External command"),
		);

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot, discover: true });

		expect(result.errors).toEqual([]);
		expect(result.commands.map(({ command }) => command.name)).toEqual(
			expect.arrayContaining(["review", "annotate", "green", "external-fixture"]),
		);
	});

	it("supports legacy and callable ArkType injection", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-command-loader-"));
		const commandDir = path.join(tempRoot, "commands", "arktype-compat");
		await fs.mkdir(commandDir, { recursive: true });
		const commandPath = path.join(commandDir, "index.js");
		await Bun.write(
			commandPath,
			[
				"export default api => {",
				'\tconst legacy = api.arktype.type("string");',
				'\tconst current = api.arktype("string");',
				'\tif (legacy("ok") !== "ok" || current("ok") !== "ok") throw new Error("ArkType schema failed");',
				"\treturn {",
				'\t\tname: "arktype-compat",',
				'\t\tdescription: "Checks both ArkType injection forms",',
				"\t\texecute() {},",
				"\t};",
				"};",
			].join("\n"),
		);

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot });

		expect(result.errors.find(error => error.path === commandPath)).toBeUndefined();
		expect(result.commands.map(({ command }) => command.name)).toContain("arktype-compat");

		expect((type as typeof type & { type?: typeof type }).type).toBeUndefined();
		expect(Object.prototype.propertyIsEnumerable.call(type, "type")).toBeFalse();
	});

	// Sharing one command package between checkouts is done by linking it into the commands
	// dir. `readdir(withFileTypes)` reports that entry as a link rather than a directory, so
	// before the fix discovery dropped the link with no path and no warning.
	it.skipIf(!SYMLINKS_USABLE)("loads a command package linked into the commands dir", async () => {
		tempRoot = await makeCommandsRoot("omp-custom-command-symlink-");
		const commandsDir = path.join(tempRoot, "commands");
		const shared = path.join(tempRoot, "shared", "linked-cmd");
		const linkedDir = path.join(commandsDir, "linked-cmd");
		await fs.mkdir(shared, { recursive: true });
		await Bun.write(path.join(shared, "index.js"), commandSource("linked-cmd", "Linked shared package"));
		await fs.symlink(shared, linkedDir, "dir");

		const discovered = await discoverCustomCommands({ cwd: tempRoot, agentDir: tempRoot });
		expect(discovered.paths.map(({ path: commandPath }) => commandPath)).toContain(path.join(linkedDir, "index.js"));

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot });
		expect(result.commands.find(({ command }) => command.name === "linked-cmd")?.command.description).toBe(
			"Linked shared package",
		);
	});

	// The fix accepts a link so the index.* probe can look through it. A link to a file has
	// no index.* inside, so it must stay rejected rather than turning every link into a
	// candidate.
	it.skipIf(!SYMLINKS_USABLE)("rejects a commands dir entry linked to a file", async () => {
		tempRoot = await makeCommandsRoot("omp-custom-command-file-link-");
		const commandsDir = path.join(tempRoot, "commands");
		const sharedFile = path.join(tempRoot, "shared-command.js");
		await Bun.write(sharedFile, commandSource("file-link", "Link to a file, not a package"));
		await fs.symlink(sharedFile, path.join(commandsDir, "file-link"), "file");

		const discovered = await discoverCustomCommands({ cwd: tempRoot, agentDir: tempRoot });
		expect(discovered.paths).toHaveLength(0);

		const result = await loadCustomCommands({ cwd: tempRoot, agentDir: tempRoot });
		expect(result.commands.map(({ command }) => command.name)).not.toContain("file-link");
	});
});
