import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand, walkerWorkersForCores } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Sentinel thrown by the stubbed session factory, so startup stops at session creation. */
const STOP = new Error("stop after session options");

const CHILD_FLAG = "--fs-tuning-child";

interface FsTuningEnv {
	walkWorkers?: string;
	scanTtl?: string;
}

/** Startup also mutates provider/worker globals; keep those out of the test runner. */
async function startWith(argv: string[], overrides: Record<string, string> = {}): Promise<FsTuningEnv> {
	using tempDir = TempDir.createSync("@omp-fs-tuning-child-");
	const child = Bun.spawn([process.execPath, "run", import.meta.path, CHILD_FLAG, JSON.stringify(argv)], {
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: tempDir.path(),
			PI_WALK_WORKERS: undefined,
			FS_SCAN_CACHE_TTL_MS: undefined,
			...overrides,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	return JSON.parse(stdout) as FsTuningEnv;
}

/** Run the real `runRootCommand` profile the launch command uses, with auth/settings/session stubbed. */
async function startInProcess(argv: string[]): Promise<FsTuningEnv> {
	using tempDir = TempDir.createSync("@omp-fs-tuning-");
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const parsed = parseArgs(argv);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = tempDir.path();

	try {
		await runRootCommand(parsed, argv, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async () => {
				throw STOP;
			},
		});
	} catch (error) {
		if (error !== STOP) throw error;
	} finally {
		authStorage.close();
	}
	return { walkWorkers: process.env.PI_WALK_WORKERS, scanTtl: process.env.FS_SCAN_CACHE_TTL_MS };
}

if (process.argv.includes(CHILD_FLAG)) {
	const snapshot = await startInProcess(JSON.parse(process.argv.at(-1)!));
	await Bun.write(Bun.stdout, JSON.stringify(snapshot));
	process.exit(0);
}
describe("runRootCommand — fork filesystem tuning", () => {
	it("sets PI_WALK_WORKERS from the logical core count when the variable is unset", async () => {
		const snapshot = await startWith(["--print", "hi"]);

		const expected = walkerWorkersForCores(os.availableParallelism());
		if (expected === undefined) {
			expect(snapshot.walkWorkers).toBeUndefined();
		} else {
			expect(snapshot.walkWorkers).toBe(String(expected));
		}
	});

	it("sets FS_SCAN_CACHE_TTL_MS for an --offline process", async () => {
		const snapshot = await startWith(["--offline", "--print", "hi"]);

		expect(snapshot.scanTtl).toBe("30000");
	});

	it("leaves FS_SCAN_CACHE_TTL_MS alone without --offline", async () => {
		const snapshot = await startWith(["--print", "hi"]);

		expect(snapshot.scanTtl).toBeUndefined();
	});

	it('keeps explicitly configured values, including the "0" opt-outs', async () => {
		const snapshot = await startWith(["--offline", "--print", "hi"], {
			PI_WALK_WORKERS: "0",
			FS_SCAN_CACHE_TTL_MS: "7",
		});

		expect(snapshot.walkWorkers).toBe("0");
		expect(snapshot.scanTtl).toBe("7");
	});
});

describe("walkerWorkersForCores", () => {
	it("halves hosts above 8 logical cores and caps the result at 16", () => {
		expect(walkerWorkersForCores(1)).toBeUndefined();
		expect(walkerWorkersForCores(8)).toBeUndefined();
		expect(walkerWorkersForCores(9)).toBe(4);
		expect(walkerWorkersForCores(12)).toBe(6);
		expect(walkerWorkersForCores(16)).toBe(8);
		expect(walkerWorkersForCores(32)).toBe(16);
		expect(walkerWorkersForCores(64)).toBe(16);
	});
});
