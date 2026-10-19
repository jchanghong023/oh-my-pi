import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { parseDocument } from "yaml";
import { Settings } from "../../src/config/settings";
import { UserSettingError, UserSettingsStore } from "../../src/config/user-settings";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(offline = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-user-settings-"));
	roots.push(root);
	const runtimeRoot = path.join(root, "runtime"),
		persistentRoot = path.join(root, "persistent");
	const agentDir = path.join(runtimeRoot, "profiles", "work", "agent");
	const persistentDir = path.join(persistentRoot, "profiles", "work", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(persistentDir, { recursive: true });
	const locks: string[] = [];
	const store = new UserSettingsStore({
		agentDir,
		...(offline
			? {
					offline: { runtimeRoot, persistentRoot, domainId: "test-domain" },
					persistentLock: async (file, fn, options) => {
						locks.push(file);
						return withFileLock(file, fn, options);
					},
				}
			: {}),
	});
	return { root, agentDir, persistentDir, store, locks };
}
const keys = ["team", "members"];

describe("explicit raw user settings persistence", () => {
	test.each(["{}", "", "# empty\n", "startup: null\n"])(
		"resetting a nested leaf without its parent is a no-op on both sides: %j",
		async source => {
			const { store, agentDir, persistentDir } = await fixture(true);
			const active = path.join(agentDir, "config.yml");
			const persistent = path.join(persistentDir, "config.yml");
			await fs.writeFile(active, source);
			await fs.writeFile(persistent, source);
			const segments = ["startup", "changelogMode"];
			const snapshot = await store.read(segments);
			const receipt = await store.save([{ segments, value: undefined }], snapshot.revision!);
			expect(receipt).toEqual({
				saveState: "complete",
				writes: { active: { status: "unchanged" }, persistent: { status: "unchanged" } },
			});
			expect(await fs.readFile(active, "utf8")).toBe(source);
			expect(await fs.readFile(persistent, "utf8")).toBe(source);
		},
	);

	test.each(["startup: false\n", "startup: []\n"])(
		"rejects resetting through a non-mapping parent: %j",
		async source => {
			const { store, agentDir } = await fixture();
			const file = path.join(agentDir, "config.yml");
			await fs.writeFile(file, source);
			const segments = ["startup", "changelogMode"];
			expect((await store.read(segments)).revision).toBeNull();
			await expect(store.save([{ segments, value: undefined }])).rejects.toMatchObject({ code: "invalid_config" });
			expect(await fs.readFile(file, "utf8")).toBe(source);
		},
	);

	test("rejects duplicate keys without modifying either file", async () => {
		const { store, agentDir, persistentDir } = await fixture(true);
		const source = "team:\n  members: []\n  members: [provider/other]\n";
		await fs.writeFile(path.join(agentDir, "config.yml"), source);
		await fs.writeFile(path.join(persistentDir, "config.yml"), "team:\n  members: []\n");
		expect((await store.read(keys)).revision).toBeNull();
		await expect(store.save([{ segments: keys, value: [] }], "old")).rejects.toBeInstanceOf(UserSettingError);
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(source);
		expect(await fs.readFile(path.join(persistentDir, "config.yml"), "utf8")).toContain("members: []");
	});

	test("reports parser codes and locations without exposing unrelated configuration secrets", async () => {
		const { store, agentDir } = await fixture();
		const secret = "private-provider-token-do-not-return";
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			`credentials:\n  token: ${secret}\n  token: duplicate\nteam:\n  members: []\n`,
		);
		const snapshot = await store.read(keys);
		expect(snapshot.revision).toBeNull();
		expect(snapshot.active.readState).toBe("invalid");
		const diagnostics = JSON.stringify(snapshot.issues);
		expect(diagnostics).toContain("DUPLICATE_KEY");
		expect(diagnostics).toContain("line 3, column 3");
		expect(diagnostics).not.toContain(secret);
		expect(diagnostics).not.toContain("token");
		expect(diagnostics).not.toContain("duplicate");
	});

	test("preserves ordering, duplicate values, empty lists, deletion and each side's comments", async () => {
		const { store, agentDir, persistentDir, locks } = await fixture(true);
		await fs.writeFile(path.join(agentDir, "config.yaml"), "# active note\nother: active\n");
		await fs.writeFile(path.join(persistentDir, "config.yml"), "# persistent note\nother: persistent\n");
		for (const value of [["p/b", "p/a", "p/b"], [], undefined]) {
			const snapshot = await store.read(keys);
			expect(snapshot.revision).not.toBeNull();
			const result = await store.save([{ segments: keys, value }], snapshot.revision!);
			expect(result.saveState).toBe("complete");
			const saved = await store.read(keys);
			expect(saved.active.value).toEqual(value);
			expect(saved.persistent.value).toEqual(value);
			expect(saved.active.readState).toBe(value === undefined ? "missing" : "present");
			expect(saved.persistent.readState).toBe(value === undefined ? "missing" : "present");
			expect(saved.syncState).toBe("in_sync");
		}
		expect(locks).toEqual(Array(3).fill(path.join(persistentDir, "config.yml")));
		expect(await fs.readFile(path.join(agentDir, "config.yaml"), "utf8")).toContain("# active note");
		expect(await fs.readFile(path.join(persistentDir, "config.yml"), "utf8")).toContain("other: persistent");
		expect(await fs.readdir(path.dirname(persistentDir))).toEqual(["agent"]);
	});

	test("distinguishes an empty file or absent leaf from explicit null and an empty list", async () => {
		const { store, agentDir } = await fixture();
		const file = path.join(agentDir, "config.yml");
		for (const source of ["", "# empty configuration\n", "other: preserved\n"]) {
			await fs.writeFile(file, source);
			const snapshot = await store.read(keys);
			expect(snapshot.active).toEqual({ readState: "missing", value: undefined });
			expect(snapshot.revision).not.toBeNull();
			await store.save([{ segments: keys, value: [] }], snapshot.revision!);
			expect((await store.read(keys)).active).toEqual({ readState: "present", value: [] });
		}
		await fs.writeFile(file, "team:\n  members: null\n");
		const explicitNull = await store.read(keys);
		expect(explicitNull.active).toEqual({ readState: "present", value: null });
		expect(explicitNull.revision).not.toBeNull();
	});

	test("ignores unrelated edits but conflicts on the authorized leaf", async () => {
		const { store, agentDir } = await fixture();
		const file = path.join(agentDir, "config.yml");
		await fs.writeFile(file, "team:\n  members: [p/old]\nother: before\n");
		const snapshot = await store.read(keys);
		await fs.writeFile(file, "team:\n  members: [p/old]\nother: concurrent\n");
		expect((await store.read(keys)).revision).toBe(snapshot.revision);
		await store.save([{ segments: keys, value: ["p/new"] }], snapshot.revision!);
		expect(parseDocument(await fs.readFile(file, "utf8")).toJS().other).toBe("concurrent");
		await expect(store.save([{ segments: keys, value: [] }], snapshot.revision!)).rejects.toMatchObject({
			code: "revision_conflict",
			data: { saveState: "failed", writes: { active: { status: "not_attempted" } } },
		});
	});

	test("rejects a second persistent field changed by another host while acquiring the staged-save lock", async () => {
		const { agentDir, persistentDir, root } = await fixture();
		const activeSource = "# active remains unchanged\nteam:\n  members: [p/old]\nother: before\n";
		const activeFile = path.join(agentDir, "config.yml");
		const persistentFile = path.join(persistentDir, "config.yml");
		await fs.writeFile(activeFile, activeSource);
		await fs.writeFile(persistentFile, "team:\n  members: [p/old]\nother: before\n");
		const store = new UserSettingsStore({
			agentDir,
			offline: {
				runtimeRoot: path.join(root, "runtime"),
				persistentRoot: path.join(root, "persistent"),
				domainId: "staged-save-race",
			},
			persistentLock: async (file, fn, options) => {
				await fs.writeFile(persistentFile, "team:\n  members: [p/old]\nother: another-host\n");
				return withFileLock(file, fn, options);
			},
		});
		await expect(
			store.save([
				{ segments: keys, value: ["p/new"], baseValue: ["p/old"], checkBase: true },
				{ segments: ["other"], value: "requested", baseValue: "before", checkBase: true },
			]),
		).rejects.toMatchObject({
			code: "revision_conflict",
			data: {
				saveState: "failed",
				writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
			},
		});
		expect(await fs.readFile(activeFile, "utf8")).toBe(activeSource);
		expect(await fs.readFile(persistentFile, "utf8")).toContain("other: another-host");
	});

	test("projects higher layers and parents without modifying their values or revisions", () => {
		const settings = Settings.isolated({ "team.members": ["p/runtime"] });
		const child = settings.overlay();
		const before = settings.revision,
			childBefore = child.revision;
		expect(child.projectUserSetting("team.members", ["p/draft"])).toEqual({
			value: ["p/runtime"],
			source: "runtime",
		});
		expect(settings.revision).toBe(before);
		expect(child.revision).toBe(childBefore);
	});

	test("reports lock failure before either commit", async () => {
		const { agentDir, persistentDir, root } = await fixture();
		const store = new UserSettingsStore({
			agentDir,
			offline: {
				runtimeRoot: path.join(root, "runtime"),
				persistentRoot: path.join(root, "persistent"),
				domainId: "failure",
			},
			persistentLock: async () => {
				throw new Error("NFS lock unavailable");
			},
		});
		const snapshot = await store.read(keys);
		await expect(store.save([{ segments: keys, value: [] }], snapshot.revision!)).rejects.toMatchObject({
			code: "execution_failed",
			data: {
				saveState: "failed",
				writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
			},
		});
		expect(await fs.readdir(agentDir)).toEqual([]);
		expect(await fs.readdir(persistentDir)).toEqual([]);
	});

	test("retains the active commit and reports an unconfirmed persistent publication without replay", async () => {
		const { store, agentDir, persistentDir } = await fixture(true);
		const snapshot = await store.read(keys);
		const rename = nodeFs.promises.rename;
		const failure = spyOn(nodeFs.promises, "rename").mockImplementation(async (source, target) => {
			if (String(target) === path.join(persistentDir, "config.yml")) throw new Error("NFS publication interrupted");
			return rename(source, target);
		});
		try {
			await expect(store.save([{ segments: keys, value: ["p/saved"] }], snapshot.revision!)).rejects.toMatchObject({
				code: "persistence_failed",
				data: { saveState: "unknown", writes: { active: { status: "saved" }, persistent: { status: "unknown" } } },
			});
		} finally {
			failure.mockRestore();
		}
		expect(parseDocument(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toJS()).toEqual({
			team: { members: ["p/saved"] },
		});
		expect((await store.read(keys)).persistent.value).toBeUndefined();
		await expect(store.save([{ segments: keys, value: [] }], snapshot.revision!)).rejects.toMatchObject({
			code: "revision_conflict",
		});
	});
});
