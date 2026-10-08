import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RepoService } from "../src/repo/service";

const temporary: string[] = [];
const services: RepoService[] = [];

async function fixture(files: Record<string, string>) {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-review-"));
	temporary.push(temp);
	const root = path.join(temp, "project");
	await fs.mkdir(root);
	for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content);
	const service = new RepoService({ cwd: root, agentDir: path.join(temp, "profile") });
	services.push(service);
	await service.build();
	return { root, service };
}

afterEach(async () => {
	for (const service of services.splice(0)) service.close();
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("repository review regressions", () => {
	it("refreshes removed descendants when their former directory becomes a file", async () => {
		const { root, service } = await fixture({
			"pkg/old.py": "def removed_definition(): return 'BEFOREONLYTOKEN'\n",
		});
		await fs.rm(path.join(root, "pkg"), { recursive: true });
		await Bun.write(path.join(root, "pkg"), "AFTERONLYTOKEN\n");
		service.markChanged([path.join(root, "pkg/old.py"), path.join(root, "pkg")]);

		expect((await service.search("AFTERONLYTOKEN")).hits.map(hit => hit.path)).toEqual(["pkg"]);
		expect((await service.search("BEFOREONLYTOKEN")).hits).toEqual([]);
		expect((await service.symbol("removed_definition")).hits).toEqual([]);
		expect(await service.status()).toMatchObject({ pendingCount: 0, failureCount: 0 });
	});

	it.skipIf(process.platform === "win32")(
		"isolates case-distinct directory filters for text and symbols",
		async () => {
			const { service } = await fixture({
				"src/lower.py": "def shared_definition(): return 'DIRECTORY_BEACON'\n",
				"SRC/upper.py": "def shared_definition(): return 'DIRECTORY_BEACON'\n",
			});

			expect((await service.search("DIRECTORY_BEACON", { path: "src" })).hits.map(hit => hit.path)).toEqual([
				"src/lower.py",
			]);
			expect((await service.symbol("shared_definition", { path: "SRC/" })).hits.map(hit => hit.path)).toEqual([
				"SRC/upper.py",
			]);
		},
	);

	it("matches literal Unicode directory prefixes without treating SQL wildcard characters as syntax", async () => {
		const { service } = await fixture({
			"𐐀%_/match.py": "def prefix_definition(): return 'PREFIX_BEACON'\n",
			"𐐀other/miss.py": "def prefix_definition(): return 'PREFIX_BEACON'\n",
		});

		expect((await service.search("PREFIX_BEACON", { path: "𐐀%_" })).hits.map(hit => hit.path)).toEqual([
			"𐐀%_/match.py",
		]);
		expect((await service.symbol("prefix_definition", { path: "𐐀%_/" })).hits.map(hit => hit.path)).toEqual([
			"𐐀%_/match.py",
		]);
	});
});
