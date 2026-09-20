import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand, walkerWorkersForCores } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Sentinel thrown by the stubbed session factory, so startup stops at session creation. */
const STOP = new Error("stop after session options");

let savedWalkWorkers: string | undefined;
let savedScanTtl: string | undefined;

beforeEach(() => {
	savedWalkWorkers = process.env.PI_WALK_WORKERS;
	savedScanTtl = process.env.FS_SCAN_CACHE_TTL_MS;
	delete process.env.PI_WALK_WORKERS;
	delete process.env.FS_SCAN_CACHE_TTL_MS;
});

afterEach(() => {
	if (savedWalkWorkers === undefined) delete process.env.PI_WALK_WORKERS;
	else process.env.PI_WALK_WORKERS = savedWalkWorkers;
	if (savedScanTtl === undefined) delete process.env.FS_SCAN_CACHE_TTL_MS;
	else process.env.FS_SCAN_CACHE_TTL_MS = savedScanTtl;
});

/** Run the real `runRootCommand` profile the launch command uses, with auth/settings/session stubbed. */
async function startWith(argv: string[]): Promise<void> {
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
}

describe("runRootCommand — fork filesystem tuning", () => {
	it("sets PI_WALK_WORKERS from the logical core count when the variable is unset", async () => {
		await startWith(["--print", "hi"]);

		const expected = walkerWorkersForCores(os.availableParallelism());
		if (expected === undefined) {
			expect(process.env.PI_WALK_WORKERS).toBeUndefined();
		} else {
			expect(process.env.PI_WALK_WORKERS).toBe(String(expected));
		}
	});

	it("sets FS_SCAN_CACHE_TTL_MS for an --offline process", async () => {
		await startWith(["--offline", "--print", "hi"]);

		expect(process.env.FS_SCAN_CACHE_TTL_MS).toBe("30000");
	});

	it("leaves FS_SCAN_CACHE_TTL_MS alone without --offline", async () => {
		await startWith(["--print", "hi"]);

		expect(process.env.FS_SCAN_CACHE_TTL_MS).toBeUndefined();
	});

	it('keeps explicitly configured values, including the "0" opt-outs', async () => {
		process.env.PI_WALK_WORKERS = "0";
		process.env.FS_SCAN_CACHE_TTL_MS = "7";

		await startWith(["--offline", "--print", "hi"]);

		expect(process.env.PI_WALK_WORKERS).toBe("0");
		expect(process.env.FS_SCAN_CACHE_TTL_MS).toBe("7");
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
