import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type RecordLine = {
	timestamp: string;
	level: string;
	pid: number;
	message: string;
	operation_id?: string;
	call_id?: string;
	stage?: string;
	result?: string;
	elapsed_ms?: number;
	[key: string]: unknown;
};

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const profile = "diagnostic-acceptance";

async function sandbox() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-diagnostic-"));
	const root = path.join(directory, "project");
	const home = path.join(directory, "home");
	const cacheRoot = path.join(directory, "cache");
	await Promise.all([root, home].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
	// Keep OS executable-loading variables and the gate's Bun transpiler cache, not application state.
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			/^(?:path|systemroot|windir|comspec|pathext|systemdrive|lang|lc_all|bun_runtime_transpiler_cache_path)$/i.test(
				key,
			) &&
			value !== undefined
		)
			env[key] = value;
	}
	Object.assign(env, {
		OMP_CACHE_DIR: cacheRoot,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: directory,
		TMP: directory,
		TEMP: directory,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		OMP_OFFLINE: "1",
		OMP_LOG_LEVEL: "error",
	});
	const selectedCache = process.platform === "linux" ? path.join(cacheRoot, String(process.getuid!())) : cacheRoot;
	const logsDir = path.join(selectedCache, "profiles", profile, "logs");
	async function logs(): Promise<{ raw: string; records: RecordLine[] }> {
		const files = await fs.readdir(logsDir);
		const records: RecordLine[] = [];
		let raw = "";
		for (const name of files.filter(name => /^omp\.\d{4}-\d{2}-\d{2}\.\d+\.log(?:\.\d+)?$/.test(name))) {
			const text = await fs.readFile(path.join(logsDir, name), "utf8");
			raw += text;
			const filenamePid = Number(/^omp\.\d{4}-\d{2}-\d{2}\.(\d+)\.log/.exec(name)?.[1]);
			for (const line of text.split("\n").filter(Boolean)) {
				const record = JSON.parse(line) as RecordLine;
				expect(record.pid).toBe(filenamePid);
				expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/);
				expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);
				records.push(record);
			}
		}
		expect(records.length).toBeGreaterThan(0);
		return { raw, records };
	}
	async function run(args: string[]) {
		const child = Bun.spawn([process.execPath, cliEntry, "--profile", profile, ...args], {
			cwd: root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		// A watchdog bounds a hung real subprocess; completion is awaited via exited,
		// never a guessed sleep. Parent fake timers cannot drive a separate Bun process.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 25_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (timedOut) throw new Error(`Diagnostic child timed out: ${stderr}`);
			return { stdout, stderr, code };
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) {
				child.kill();
				await child.exited;
			}
		}
	}
	return {
		root,
		home,
		logsDir,
		logs,
		cli: run,
		async cleanup() {
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

describe("fork diagnostics on the real rotating disk transport", () => {
	it.skipIf(process.platform !== "linux")(
		"P2-40 writes offline CLI errors to primary logs when fallback-logs is a regular file",
		async () => {
			const box = await sandbox();
			const fallback = path.join(box.home, ".local", "state", "omp", "logs");
			try {
				await fs.mkdir(box.logsDir, { recursive: true, mode: 0o700 });
				await fs.mkdir(path.dirname(fallback), { recursive: true, mode: 0o700 });
				await fs.writeFile(fallback, "unavailable fallback");
				const failed = await box.cli([
					"models",
					"refresh",
					"--json",
					"--no-extensions",
					"--config",
					path.join(box.root, "missing.yml"),
				]);
				expect(failed.code).toBe(1);
				expect(await fs.readFile(fallback, "utf8")).toBe("unavailable fallback");
				const { records } = await box.logs();
				expect(records.every(record => record.level === "error")).toBe(true);
				expect(records.find(record => record.event === "models_init" && record.result === "failed")).toMatchObject({
					stage: "settings_init",
				});
			} finally {
				await box.cleanup();
			}
		},
		35_000,
	);

	it("closes offline CLI initialization without leaking rejected configuration paths", async () => {
		const box = await sandbox();
		const canary = "FORKDIAGNOSTICCATALOGPRIVATE";
		try {
			const success = await box.cli(["models", "refresh", "--json", "--no-extensions"]);
			expect(success.code).toBe(0);
			const failed = await box.cli([
				"models",
				"refresh",
				"--json",
				"--no-extensions",
				"--config",
				path.join(box.root, `${canary}.yml`),
			]);
			expect(failed.code).toBe(1);
			const { raw, records } = await box.logs();
			expect(raw).not.toContain(canary);
			expect(records.every(record => record.level === "error")).toBe(true);
			const initFailed = records.find(record => record.event === "models_init" && record.result === "failed");
			expect(initFailed).toMatchObject({ level: "error", stage: "settings_init", elapsed_ms: expect.any(Number) });
			expect(initFailed?.operation_id).toEqual(expect.any(String));
			expect(initFailed?.call_id).toEqual(expect.any(String));
		} finally {
			await box.cleanup();
		}
	}, 120_000);
});
