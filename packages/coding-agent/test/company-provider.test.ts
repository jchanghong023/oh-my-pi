import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = join(import.meta.dir, "../src/config/company-provider.ts");

// Separate processes exercise the startup snapshot without touching host Claude credentials.
// Claude's config directory is pinned into the fixture home so a host-level CLAUDE_CONFIG_DIR cannot
// redirect the read; `relocateClaudeConfig` points it at a sibling directory instead.
function runSnapshotProbe(initial: string | undefined, relocateClaudeConfig = false): Record<string, unknown> {
	const home = mkdtempSync(join(tmpdir(), "company-snapshot-"));
	const claudeConfigDir = relocateClaudeConfig ? join(home, "relocated-claude") : join(home, ".claude");
	try {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
			import { mkdirSync, writeFileSync, rmSync } from "node:fs";
			import { Worker } from "node:worker_threads";
			const modulePath = ${JSON.stringify(modulePath)};
			const file = ${JSON.stringify(join(claudeConfigDir, "settings.json"))};
			mkdirSync(${JSON.stringify(claudeConfigDir)}, { recursive: true });
			const initial = ${JSON.stringify(initial) ?? "undefined"};
			if (initial !== undefined) writeFileSync(file, initial);
			const { getCompanyConfig, getCompanyConfigError, setCompanyOfflineEnabled, companySnapshotForSubprocess } = await import(${JSON.stringify(modulePath)});
			// The lane starts gated off even when the fixture config is valid.
			const gatedConfig = getCompanyConfig();
			const gatedError = getCompanyConfigError();
			await setCompanyOfflineEnabled(true);
			const before = getCompanyConfig();
			const error = getCompanyConfigError();
			writeFileSync(file, JSON.stringify({ env: {
				ANTHROPIC_BASE_URL: "http://changed.invalid",
				ANTHROPIC_AUTH_TOKEN: "replacement-token"
			} }));
			const afterWrite = getCompanyConfig();
			rmSync(file);
			const inherited = Bun.spawnSync([process.execPath, "--eval", \`
				const state = JSON.parse(await Bun.stdin.text());
				const realFile = Bun.file.bind(Bun);
				Bun.file = (path, ...args) => {
					if (String(path) === \${JSON.stringify(file)}) throw new Error("inherited snapshot must not read Claude settings");
					return realFile(path, ...args);
				};
				const provider = await import(\${JSON.stringify(modulePath)});
				await provider.inheritCompanyProcessSnapshot(state);
				console.log(JSON.stringify({ token: provider.getCompanyConfig()?.token, error: provider.getCompanyConfigError() }));
			\`], { stdin: Buffer.from(JSON.stringify(companySnapshotForSubprocess())), stdout: "pipe", stderr: "pipe" });
			if (inherited.exitCode !== 0) throw new Error(inherited.stderr.toString());
			const inheritedResult = JSON.parse(inherited.stdout.toString());
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
				gatedConfigUndefined: gatedConfig === undefined,
				gatedErrorUndefined: gatedError === undefined,
				available: before !== undefined,
				unchanged: before === afterWrite && before === getCompanyConfig() && error === getCompanyConfigError(),
				baseUrl: before?.baseUrl,
				embeddingBaseUrl: before?.embeddingBaseUrl,
				tokenMatches: before?.token === "fixture-secret",
				serialized: JSON.stringify(before),
				inheritedMatches: inheritedResult.token === before?.token && inheritedResult.error === error,
				workerMatches: workerResult.tokenMatches === (before?.token === "fixture-secret") && workerResult.error === error,
				error
			}));
			`,
			],
			{
				env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeConfigDir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		return JSON.parse(child.stdout.toString());
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("company provider startup snapshot", () => {
	test("shares one asynchronous read and rejects consumers until it is ready", () => {
		const home = mkdtempSync(join(tmpdir(), "company-async-"));
		const configDir = join(home, ".claude");
		try {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
					import { mkdirSync, writeFileSync } from "node:fs";
					const file = ${JSON.stringify(join(configDir, "settings.json"))};
					mkdirSync(${JSON.stringify(configDir)}, { recursive: true });
					writeFileSync(file, JSON.stringify({ env: {
						ANTHROPIC_BASE_URL: "http://internal.invalid",
						ANTHROPIC_AUTH_TOKEN: "fixture-secret"
					} }));
					const originalFile = Bun.file;
					const gate = Promise.withResolvers();
					let reads = 0;
					Bun.file = (path, ...args) => {
						const result = originalFile(path, ...args);
						if (String(path) !== file) return result;
						return { text: async () => { reads++; await gate.promise; return result.text(); } };
					};
					const provider = await import(${JSON.stringify(modulePath)});
					await provider.setCompanyOfflineEnabled(false);
					const onlineReads = reads;
					let settled = false;
					const first = provider.setCompanyOfflineEnabled(true).then(() => { settled = true; });
					const second = provider.setCompanyOfflineEnabled(true);
					let blocked = 0;
					for (const consume of [provider.getCompanyConfig, provider.getCompanyConfigError, provider.companySnapshotForSubprocess]) {
						try { consume(); } catch (error) { if (String(error).includes("not ready")) blocked++; }
					}
					await Bun.write(${JSON.stringify(join(home, "independent"))}, "continued");
					const progressed = !settled && reads === 1;
					gate.resolve();
					await Promise.all([first, second]);
					await provider.setCompanyOfflineEnabled(true);
					console.log(JSON.stringify({ onlineReads, reads, blocked, progressed, settled,
						tokenMatches: provider.getCompanyConfig()?.token === "fixture-secret" }));
					`,
				],
				{
					env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (child.exitCode !== 0) throw new Error(child.stderr.toString());
			const result = JSON.parse(child.stdout.toString());
			expect(result).toEqual({
				onlineReads: 0,
				reads: 1,
				blocked: 3,
				progressed: true,
				settled: true,
				tokenMatches: true,
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("keeps cached endpoint and token after file replacement and deletion", () => {
		const result = runSnapshotProbe(
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "http://internal.invalid/gateway/v1/",
					ANTHROPIC_AUTH_TOKEN: "fixture-secret",
				},
			}),
		);
		expect(result.gatedConfigUndefined).toBe(true);
		expect(result.gatedErrorUndefined).toBe(true);
		expect(result.available).toBe(true);
		expect(result.unchanged).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.inheritedMatches).toBe(true);
		expect(result.baseUrl).toBe("http://internal.invalid/gateway");
		expect(result.embeddingBaseUrl).toBe("http://internal.invalid/gateway/v1");
		expect(result.tokenMatches).toBe(true);
		expect(result.serialized).not.toContain("fixture-secret");
	});

	test("does not recover a missing startup file until the next process", () => {
		const result = runSnapshotProbe(undefined);
		expect(result.gatedConfigUndefined).toBe(true);
		expect(result.gatedErrorUndefined).toBe(true);
		expect(result.available).toBe(false);
		expect(result.unchanged).toBe(true);
		expect(result.inheritedMatches).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.error).toContain("cannot read");
	});

	test("caches malformed JSON failure without exposing its contents", () => {
		const result = runSnapshotProbe('{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-secret"');
		expect(result.gatedConfigUndefined).toBe(true);
		expect(result.gatedErrorUndefined).toBe(true);
		expect(result.available).toBe(false);
		expect(result.unchanged).toBe(true);
		expect(result.inheritedMatches).toBe(true);
		expect(result.workerMatches).toBe(true);
		expect(result.error).toContain("not valid JSON");
		expect(JSON.stringify(result)).not.toContain("fixture-secret");
	});

	test("reads Claude's active config dir when CLAUDE_CONFIG_DIR relocates it", () => {
		const result = runSnapshotProbe(
			JSON.stringify({
				env: { ANTHROPIC_BASE_URL: "http://relocated.invalid/gateway", ANTHROPIC_AUTH_TOKEN: "fixture-secret" },
			}),
			true,
		);
		expect(result.available).toBe(true);
		expect(result.tokenMatches).toBe(true);
		expect(result.baseUrl).toBe("http://relocated.invalid/gateway");
	});
});
