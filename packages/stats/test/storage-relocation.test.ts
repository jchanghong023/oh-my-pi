import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("creates the stats database in its actual parent with and without a cache root", async () => {
	using temp = TempDir.createSync("@omp-stats-relocation-");
	const config = temp.join("config");
	const cache = temp.join("new", "performance");
	const selectedCache = process.platform === "linux" ? path.join(cache, String(process.getuid!())) : cache;
	const dbModule = path.resolve(import.meta.dir, "../src/db.ts");
	const dirsModule = path.resolve(import.meta.dir, "../../utils/src/dirs.ts");
	const script = `
import { initDb, closeDb, setFileOffset, getFileOffset } from ${JSON.stringify(dbModule)};
import { getStatsDbPath } from ${JSON.stringify(dirsModule)};
await initDb();
setFileOffset("session.jsonl", 42, 1234);
const result = { dbPath: getStatsDbPath(), offset: getFileOffset("session.jsonl") };
closeDb();
console.log(JSON.stringify(result));`;
	const run = async (cacheDir?: string) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			OMP_CONFIG_ROOT: config,
			OMP_OFFLINE: "0",
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		delete env.PI_CODING_AGENT_DIR;
		if (cacheDir) env.OMP_CACHE_DIR = cacheDir;
		else delete env.OMP_CACHE_DIR;
		const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Stats subprocess failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout) as { dbPath: string; offset: { offset: number; lastModified: number } | null };
	};

	const relocated = await run(cache);
	expect(relocated.dbPath).toBe(path.join(selectedCache, "stats.db"));
	expect(relocated.offset).toEqual({ offset: 42, lastModified: 1234 });
	expect((await fs.stat(relocated.dbPath)).isFile()).toBe(true);
	const original = await run();
	expect(original.dbPath).toBe(path.join(config, "stats.db"));
	expect(original.offset).toEqual({ offset: 42, lastModified: 1234 });
	expect((await fs.stat(original.dbPath)).isFile()).toBe(true);
});
