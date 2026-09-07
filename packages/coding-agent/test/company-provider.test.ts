import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = join(import.meta.dir, "../src/config/company-provider.ts");

// Separate processes exercise the real eager module boundary without touching host Claude credentials.
function runSnapshotProbe(initial: string | undefined): Record<string, unknown> {
	const home = mkdtempSync(join(tmpdir(), "company-snapshot-"));
	try {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
			import { mkdirSync, writeFileSync, rmSync } from "node:fs";
			import { homedir } from "node:os";
			import { join } from "node:path";
			import { Worker } from "node:worker_threads";
			const file = join(homedir(), ".claude", "settings.json");
			mkdirSync(join(homedir(), ".claude"), { recursive: true });
			const initial = ${JSON.stringify(initial) ?? "undefined"};
			if (initial !== undefined) writeFileSync(file, initial);
			// Import must happen after fixture creation: this probes eager configuration capture.
			const { getCompanyConfig, getCompanyConfigError } = await import(${JSON.stringify(modulePath)});
			const before = getCompanyConfig();
			const error = getCompanyConfigError();
			writeFileSync(file, JSON.stringify({ env: {
				ANTHROPIC_BASE_URL: "http://changed.invalid",
				ANTHROPIC_AUTH_TOKEN: "replacement-token"
			} }));
			const afterWrite = getCompanyConfig();
			rmSync(file);
			const workerResult = await new Promise((resolve, reject) => {
				const worker = new Worker(
					'import { parentPort } from "node:worker_threads";' +
					'import { getCompanyConfig, getCompanyConfigError } from ' + ${JSON.stringify(JSON.stringify(modulePath))} + ';' +
					'parentPort.postMessage({ tokenMatches: getCompanyConfig()?.token === "fixture-secret", error: getCompanyConfigError() });',
					{ eval: true },
				);
				worker.once("message", result => { resolve(result); worker.terminate(); });
				worker.once("error", reject);
			});
			console.log(JSON.stringify({
				available: before !== undefined,
				unchanged: before === afterWrite && before === getCompanyConfig() && error === getCompanyConfigError(),
				baseUrl: before?.baseUrl,
				embeddingBaseUrl: before?.embeddingBaseUrl,
				tokenMatches: before?.token === "fixture-secret",
				serialized: JSON.stringify(before),
				workerMatches: workerResult.tokenMatches === (before?.token === "fixture-secret") && workerResult.error === error,
				error
			}));
			`,
			],
			{ env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" },
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return JSON.parse(child.stdout.toString());
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("company provider startup snapshot", () => {
	test("keeps cached endpoint and token after file replacement and deletion", () => {
		const result = runSnapshotProbe(
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "http://internal.invalid/gateway/v1/",
					ANTHROPIC_AUTH_TOKEN: "fixture-secret",
				},
			}),
		);
		expect(result.available).toBe(true);
		expect(result.unchanged).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.baseUrl).toBe("http://internal.invalid/gateway");
		expect(result.embeddingBaseUrl).toBe("http://internal.invalid/gateway/v1");
		expect(result.tokenMatches).toBe(true);
		expect(result.serialized).not.toContain("fixture-secret");
	});

	test("does not recover a missing startup file until the next process", () => {
		const result = runSnapshotProbe(undefined);
		expect(result.available).toBe(false);
		expect(result.unchanged).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.error).toContain("cannot read");
	});

	test("caches malformed JSON failure without exposing its contents", () => {
		const result = runSnapshotProbe('{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-secret"');
		expect(result.available).toBe(false);
		expect(result.unchanged).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.error).toContain("not valid JSON");
		expect(JSON.stringify(result)).not.toContain("fixture-secret");
	});
});
