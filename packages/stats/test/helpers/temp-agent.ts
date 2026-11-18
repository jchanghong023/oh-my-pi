/**
 * Shared test isolation for stats Bun tests.
 *
 * Each test owns absolute config and cache roots and its agent directory, so
 * inherited roots, offline defaults, and XDG cannot redirect stats.db.
 * Absolute roots also work when the temporary directory and home are on
 * different Windows drives; `PI_CONFIG_DIR` retains its home-relative meaning.
 *
 * Snapshot directory state when each test starts, close its stats DB before
 * removing the temporary root, and restore the prior environment and agent.
 */
import { afterEach, beforeEach } from "bun:test";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	setAgentDir,
	setProfile,
	TempDir,
} from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["OMP_CONFIG_ROOT", "OMP_CACHE_DIR", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

export interface StatsTestIsolation {
	/** Active per-test `TempDir`. Null between tests. */
	current(): TempDir | null;
}

export function installStatsTestIsolation(prefix: string): StatsTestIsolation {
	let originalAgentDir: string;
	let originalProfile: string | undefined;
	const originalEnv: Record<string, string | undefined> = {};
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		originalProfile = getActiveProfile();
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
		}
		tempDir = TempDir.createSync(prefix);
		process.env.OMP_CONFIG_ROOT = tempDir.join("config");
		process.env.OMP_CACHE_DIR = tempDir.join("cache");
		setAgentDir(tempDir.join("config", "agent"));
	});

	afterEach(() => {
		closeDb();
		for (const key of ENV_KEYS) {
			const prior = originalEnv[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		setAgentDir(originalAgentDir);
		if (originalProfile !== undefined) setProfile(originalProfile);
		// The setters also write env vars; restore their exact original presence.
		for (const key of ENV_KEYS) {
			const prior = originalEnv[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		__resetProfileSnapshotForTests();
		tempDir?.removeSync();
		tempDir = null;
	});

	return {
		current() {
			return tempDir;
		},
	};
}
