import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { cfgSpellingAutocomplete, cfgTuiAutoGraph, cfgTuiTitleState } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTitleRefreshOnReplan } from "@oh-my-pi/pi-coding-agent/utils/title-settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Sentinel thrown by the stubbed session factory, so startup stops at session creation. */
const STOP = new Error("stop after session options");

const CHILD_FLAG = "--fs-tuning-child";

interface FsTuningEnv {
	scanTtl?: string;
	runtimeUi: {
		autoGraph: string;
		titleState: boolean;
		titleRefreshOnReplan: boolean;
		spellingAutocomplete: string;
	};
}

/** Startup also mutates provider/worker globals; keep those out of the test runner. */
async function startWith(argv: string[], overrides: Record<string, string> = {}): Promise<FsTuningEnv> {
	using tempDir = TempDir.createSync("@omp-fs-tuning-child-");
	const child = Bun.spawn([process.execPath, "run", import.meta.path, CHILD_FLAG, JSON.stringify(argv)], {
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: tempDir.path(),
			FS_SCAN_CACHE_TTL_MS: undefined,
			OMP_OFFLINE: undefined,
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
	const settings = Settings.isolated({
		"marketplace.autoUpdate": "off",
		"tui.autoGraph": "smart",
		"tui.titleState": true,
		"title.refreshOnReplan": true,
		"spelling.autocomplete": "ngram",
	});
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
	return {
		scanTtl: process.env.FS_SCAN_CACHE_TTL_MS,
		runtimeUi: {
			autoGraph: cfgTuiAutoGraph.get(settings),
			titleState: cfgTuiTitleState.get(settings),
			titleRefreshOnReplan: cfgTitleRefreshOnReplan.get(settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(settings),
		},
	};
}

if (process.argv.includes(CHILD_FLAG)) {
	const snapshot = await startInProcess(JSON.parse(process.argv.at(-1)!));
	await Bun.write(Bun.stdout, JSON.stringify(snapshot));
	process.exit(0);
}
describe("runRootCommand — fork filesystem tuning", () => {
	it("sets FS_SCAN_CACHE_TTL_MS for an offline (OMP_OFFLINE=1) process", async () => {
		const snapshot = await startWith(["--print", "hi"], { OMP_OFFLINE: "1" });

		expect(snapshot.scanTtl).toBe("30000");
		expect(snapshot.runtimeUi).toEqual({
			autoGraph: "off",
			titleState: false,
			titleRefreshOnReplan: false,
			spellingAutocomplete: "ngram",
		});
	});

	it("leaves FS_SCAN_CACHE_TTL_MS alone without OMP_OFFLINE", async () => {
		const snapshot = await startWith(["--print", "hi"]);

		expect(snapshot.scanTtl).toBeUndefined();
		expect(snapshot.runtimeUi).toEqual({
			autoGraph: "smart",
			titleState: true,
			titleRefreshOnReplan: true,
			spellingAutocomplete: "ngram",
		});
	});

	it("keeps an explicitly configured scan-cache TTL", async () => {
		const snapshot = await startWith(["--print", "hi"], {
			OMP_OFFLINE: "1",
			FS_SCAN_CACHE_TTL_MS: "7",
		});

		expect(snapshot.scanTtl).toBe("7");
	});
});
