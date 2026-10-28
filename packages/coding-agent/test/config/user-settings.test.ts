import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { Settings } from "../../src/config/settings";
import { UserSettingError, UserSettingsStore } from "../../src/config/user-settings";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-user-settings-"));
	roots.push(root);
	const agentDir = path.join(root, "profiles", "work", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const store = new UserSettingsStore({ agentDir });
	return { root, agentDir, store };
}
const keys = ["team", "members"];

describe("explicit raw user settings persistence", () => {
	test.each(["{}", "", "# empty\n", "startup: null\n"])(
		"resetting a nested leaf without its parent is a no-op: %j",
		async source => {
			const { store, agentDir } = await fixture();
			const active = path.join(agentDir, "config.yml");
			await fs.writeFile(active, source);
			const segments = ["startup", "changelogMode"];
			const snapshot = await store.read(segments);
			const receipt = await store.save([{ segments, value: undefined }], snapshot.revision!);
			expect(receipt).toEqual({
				saveState: "complete",
				write: { status: "unchanged" },
			});
			expect(await fs.readFile(active, "utf8")).toBe(source);
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

	test("rejects duplicate keys without modifying the file", async () => {
		const { store, agentDir } = await fixture();
		const source = "team:\n  members: []\n  members: [provider/other]\n";
		await fs.writeFile(path.join(agentDir, "config.yml"), source);
		expect((await store.read(keys)).revision).toBeNull();
		await expect(store.save([{ segments: keys, value: [] }], "old")).rejects.toBeInstanceOf(UserSettingError);
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(source);
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
		expect(snapshot.readState).toBe("invalid");
		const diagnostics = JSON.stringify(snapshot.issues);
		expect(diagnostics).toContain("DUPLICATE_KEY");
		expect(diagnostics).toContain("line 3, column 3");
		expect(diagnostics).not.toContain(secret);
		expect(diagnostics).not.toContain("token");
		expect(diagnostics).not.toContain("duplicate");
	});

	test("preserves ordering, duplicate values, empty lists, deletion and comments", async () => {
		const { store, agentDir } = await fixture();
		await fs.writeFile(path.join(agentDir, "config.yaml"), "# active note\nother: active\n");
		for (const value of [["p/b", "p/a", "p/b"], [], undefined]) {
			const snapshot = await store.read(keys);
			expect(snapshot.revision).not.toBeNull();
			const result = await store.save([{ segments: keys, value }], snapshot.revision!);
			expect(result.saveState).toBe("complete");
			const saved = await store.read(keys);
			expect(saved.value).toEqual(value);
			expect(saved.readState).toBe(value === undefined ? "missing" : "present");
		}
		expect(await fs.readFile(path.join(agentDir, "config.yaml"), "utf8")).toContain("# active note");
	});

	test("distinguishes an empty file or absent leaf from explicit null and an empty list", async () => {
		const { store, agentDir } = await fixture();
		const file = path.join(agentDir, "config.yml");
		for (const source of ["", "# empty configuration\n", "other: preserved\n"]) {
			await fs.writeFile(file, source);
			const snapshot = await store.read(keys);
			expect(snapshot).toMatchObject({ readState: "missing", value: undefined });
			expect(snapshot.revision).not.toBeNull();
			await store.save([{ segments: keys, value: [] }], snapshot.revision!);
			expect(await store.read(keys)).toMatchObject({ readState: "present", value: [] });
		}
		await fs.writeFile(file, "team:\n  members: null\n");
		const explicitNull = await store.read(keys);
		expect(explicitNull).toMatchObject({ readState: "present", value: null });
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
			data: { saveState: "failed", write: { status: "not_attempted" } },
		});
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
});
