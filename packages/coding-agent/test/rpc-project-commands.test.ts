// Unit coverage for RpcCommandCatalogService (rpc-project-commands.ts, R2):
// the session-free project catalog snapshot (builtin registry + discovered
// skills), zero-side-effect name/argument completion, strict resolution for
// execute_command, and revision invalidation. The live-session projection is
// covered end-to-end by rpc-project-protocol.test.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { RpcCommandCatalogService } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-commands";
import type { RpcProjectCommandDescriptor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-types";

let globalSettingsReady: Promise<unknown> | undefined;

beforeAll(async () => {
	// Skill discovery and settings access route through the process-global
	// settings singleton; tests initialize it in memory (never touches the
	// user's real config). Same memoized shape as rpc-fork-config.test.ts.
	globalSettingsReady ??= Settings.init({ inMemory: true });
	await globalSettingsReady;
});

/** Write one project skill under `<root>/.omp/skills/<name>/SKILL.md`. */
async function writeProjectSkill(root: string, name: string, description: string): Promise<void> {
	const skillDir = path.join(root, ".omp", "skills", name);
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\nProbe body for catalog tests.\n`,
	);
}

/** Sorted relative paths of every entry under `root` (side-effect snapshot). */
async function listTree(root: string): Promise<string[]> {
	const entries: string[] = [];
	const walk = async (dir: string) => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			entries.push(path.relative(root, path.join(dir, entry.name)));
			if (entry.isDirectory()) await walk(path.join(dir, entry.name));
		}
	};
	await walk(root);
	return entries.sort();
}

function byName(commands: readonly RpcProjectCommandDescriptor[]): Map<string, RpcProjectCommandDescriptor> {
	return new Map(commands.map(command => [command.name, command]));
}

/** Whether an availability verdict is the session_required refusal. */
function isSessionRequired(availability: RpcProjectCommandDescriptor["availability"]): boolean {
	return !availability.available && availability.reason === "session_required";
}

describe("RpcCommandCatalogService (rpc-project-commands, R2)", () => {
	test("project and independent live-session catalogs cannot poison each other", async () => {
		await using temp = await TempDir.create("rpc-catalog-isolation-");
		const cwd = path.resolve(temp.path());
		const service = new RpcCommandCatalogService({ cwd, getSettings: () => Settings.isolated() });
		const session = (name: string) => ({
			customCommands: [],
			skills: [
				{ name, description: name, filePath: `${cwd}/${name}/SKILL.md`, baseDir: cwd, source: "native:project" },
			],
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
		});
		await service.buildCatalog();
		expect(byName(await service.buildCatalog(session("alpha"))).get("skill:alpha")?.availability.available).toBe(
			true,
		);
		const beta = byName(await service.buildCatalog(session("beta")));
		expect(beta.has("skill:alpha")).toBe(false);
		expect(beta.get("skill:beta")?.availability.available).toBe(true);
		expect(byName(await service.buildCatalog()).get("model")?.availability).toEqual({
			available: false,
			reason: "session_required",
		});
	});

	test("resolves registered file commands while rejecting unknown names", async () => {
		await using temp = await TempDir.create("rpc-catalog-file-");
		const cwd = path.resolve(temp.path());
		await fs.mkdir(path.join(cwd, ".omp", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".omp", "commands", "probe.md"), "Probe content");
		const service = new RpcCommandCatalogService({ cwd, getSettings: () => Settings.isolated() });
		const session = {
			customCommands: [],
			skills: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
		};
		expect(await service.resolve("/probe", session)).toMatchObject({ kind: "session", name: "probe" });
		expect(await service.resolve("/missing", session)).toMatchObject({ kind: "unknown" });
	});
	test("buildCatalog without a session lists builtins and project skills with scope/availability split", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-project-");
		const root = path.resolve(tempDir.path());
		await writeProjectSkill(root, "rpc-catalog-probe", "Probe skill for RPC catalog tests");

		const settings = Settings.isolated();
		const service = new RpcCommandCatalogService({ cwd: root, getSettings: () => settings });
		const commands = await service.buildCatalog();
		const map = byName(commands);

		// Well-known builtins are described with zero sessions loaded.
		for (const name of ["plan", "model", "skills", "settings", "new"]) {
			expect(map.has(name)).toBe(true);
		}

		// Every descriptor carries the full wire shape with omp execution.
		for (const command of commands) {
			expect(typeof command.name).toBe("string");
			expect(["builtin", "skill", "template", "custom"]).toContain(command.source);
			expect(["omp", "host_action"]).toContain(command.execution);
			expect(["project", "session"]).toContain(command.scope);
			expect(typeof command.availability.available).toBe("boolean");
		}

		// Session-bound builtins report session_required until a session exists.
		for (const name of ["model", "plan"]) {
			expect(map.get(name)).toMatchObject({
				source: "builtin",
				scope: "session",
				availability: { available: false, reason: "session_required" },
			});
		}

		// Project-scoped builtins are project scope and either available or
		// carry a handler-based reason (tui_only/unsupported), never
		// session_required.
		for (const name of ["settings", "skills", "new"]) {
			const command = map.get(name);
			expect(command).toBeDefined();
			expect(command!.source).toBe("builtin");
			expect(command!.scope).toBe("project");
			expect(isSessionRequired(command!.availability)).toBe(false);
		}

		// A project SKILL.md surfaces as a `skill:<name>` session-bound row.
		expect(map.get("skill:rpc-catalog-probe")).toMatchObject({
			source: "skill",
			execution: "omp",
			scope: "session",
			availability: { available: false, reason: "session_required" },
			description: "Probe skill for RPC catalog tests",
		});
	}, 15_000);

	test("complete completes command names with slash-prefixed replacement ranges", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-name-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		const model = await service.complete({ text: "/mo", cursor: 3 });
		expect(
			model.items.some(
				item =>
					item.label === "model" &&
					item.kind === "command" &&
					item.insertText === "/model " &&
					item.replaceStart === 0 &&
					item.replaceEnd === 3,
			),
		).toBe(true);
		expect(model.revision).toBe(service.revision);

		const skills = await service.complete({ text: "/sk", cursor: 3 });
		expect(skills.items.some(item => item.label === "skills" && item.kind === "command")).toBe(true);

		// Text before the cursor that does not start with "/" completes nothing.
		const prose = await service.complete({ text: "hello", cursor: 5 });
		expect(prose.items).toEqual([]);
	}, 15_000);

	test("complete returns argument items for subcommand-bearing builtins only", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-args-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		// "/security sc" (cursor at the end): the static subcommand completion
		// filters to scan/scans and replaces only the argument range [10, 12).
		const scan = await service.complete({ text: "/security sc", cursor: 12 });
		expect(scan.items.map(item => item.label).sort()).toEqual(["scan", "scans"]);
		expect(scan.items.find(item => item.label === "scan")).toMatchObject({
			insertText: "scan ",
			replaceStart: 10,
			replaceEnd: 12,
			kind: "argument",
		});

		const search = await service.complete({ text: "/skills se", cursor: 10 });
		expect(search.items).toHaveLength(1);
		expect(search.items[0]).toMatchObject({
			label: "search",
			insertText: "search ",
			replaceStart: 8,
			replaceEnd: 10,
			kind: "argument",
		});

		// Builtins without static argument completions and unknown commands
		// complete nothing (no runtime is constructed for either).
		const plan = await service.complete({ text: "/plan review", cursor: 12 });
		expect(plan.items).toEqual([]);
		const unknown = await service.complete({ text: "/nosuchcmd ar", cursor: 13 });
		expect(unknown.items).toEqual([]);
	}, 15_000);

	test("complete validates the cursor and throws invalid_params otherwise", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-cursor-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		await expect(service.complete({ text: "/mo", cursor: -1 })).rejects.toMatchObject({
			name: "RpcCommandCatalogError",
			code: "invalid_params",
		});
		await expect(service.complete({ text: "/mo", cursor: 99 })).rejects.toMatchObject({
			code: "invalid_params",
		});
	}, 10_000);

	test("complete at a mid-word cursor replaces only the typed command token", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-mid-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		// Cursor 5 sits inside "/plan": the command item replaces [0, 5) and
		// keeps the typed token's trailing text intact — no extra space is
		// appended when content already follows the replaced token.
		const result = await service.complete({ text: "/plan review", cursor: 5 });
		expect(result.items.some(item => item.label === "plan" && item.kind === "command")).toBe(true);
		expect(result.items.find(item => item.label === "plan")).toMatchObject({
			insertText: "/plan",
			replaceStart: 0,
			replaceEnd: 5,
			kind: "command",
		});
	}, 15_000);

	test("resolve classifies builtin, skill, and unknown commands strictly", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-resolve-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		const builtin = await service.resolve("/model x");
		expect(builtin.kind).toBe("builtin");
		expect(builtin.name).toBe("model");
		expect(builtin.spec?.name).toBe("model");

		// Unknown skills must not manufacture a business entry.
		expect(await service.resolve("/skill:my-skill")).toMatchObject({ kind: "unknown" });

		const unknown = await service.resolve("/nosuchcommand");
		expect(unknown).toMatchObject({ kind: "unknown", name: "nosuchcommand" });
	}, 10_000);

	test("complete is side-effect free: identical results twice and no filesystem writes", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-effects-");
		const root = path.resolve(tempDir.path());
		await writeProjectSkill(root, "rpc-catalog-probe", "Probe skill for RPC catalog tests");

		const before = await listTree(root);
		const service = new RpcCommandCatalogService({ cwd: root, getSettings: () => Settings.isolated() });

		const first = await service.complete({ text: "/sk", cursor: 3 });
		expect(first.items.length).toBeGreaterThan(0);
		const second = await service.complete({ text: "/sk", cursor: 3 });
		expect(second.items).toEqual(first.items);

		const after = await listTree(root);
		expect(after).toEqual(before);
	}, 15_000);

	test("invalidate drops the cached catalog and bumps the revision", async () => {
		await using tempDir = await TempDir.create("rpc-catalog-revision-");
		const service = new RpcCommandCatalogService({
			cwd: path.resolve(tempDir.path()),
			getSettings: () => Settings.isolated(),
		});

		await service.buildCatalog();
		const initial = service.revision;
		await service.buildCatalog();
		expect(service.revision).toBe(initial);

		service.invalidate();
		const first = service.revision;
		expect(first).not.toBe(initial);
		service.invalidate();
		expect(service.revision).not.toBe(first);

		// The invalidated catalog rebuilds and completion reports the revision used.
		const commands = await service.buildCatalog();
		expect(commands.length).toBeGreaterThan(0);
		const result = await service.complete({ text: "/mo", cursor: 3 });
		expect(result.revision).toBe(service.revision);
	}, 15_000);
});
