import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runBazelCommands, type BazelTargetResult } from "./test-gate-bazel";
import { runGate, type GateCommand, type GateLevel } from "./test-gate-runtime";
import { discoverGateInputs } from "./test-gate-bazel-inputs";
import { gateResources } from "./test-gate-bazel-resources";
import { GateCommandError } from "./test-gate-failure-events";

// Retire unused fixture JVMs through Bazel itself, never teardown signals.
// Every invocation of a fixture, including its graph server and public CLIs,
// keeps this startup identity so lifecycle assertions still exercise reuse.
const fixtureServerIdleSeconds = 60;

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-bazel-"));
	const git = Bun.spawn(["git", "init", "--quiet"], { cwd: root, stdout: "ignore", stderr: "inherit" });
	if ((await git.exited) !== 0) throw new Error("Fixture git init failed");
	await Bun.write(path.join(root, ".gitignore"), "node_modules/\n.state/\n");
	await Bun.write(path.join(root, "shared.json"), "{}\n");
	for (const name of [
		"test-gate-bazel-runner.ts",
		"test-gate-bazel-report.ts",
		"test-gate-events.ts",
		"test-gate-clock.ts",
		"test-gate-libc.ts",
	])
		await Bun.write(path.join(root, "scripts", name), await Bun.file(path.join(import.meta.dir, name)).text());
	for (const name of ["a", "b", "dependency"]) {
		await Bun.write(
			path.join(root, `packages/${name}/package.json`),
			JSON.stringify({
				name: `@fixture/${name}`,
				dependencies: name === "a" ? { "@fixture/dependency": "workspace:*" } : {},
			}),
		);
		await Bun.write(path.join(root, `packages/${name}/status.txt`), "pass");
		await Bun.write(
			path.join(root, `packages/${name}/check.ts`),
			`import * as fs from "node:fs";\nfs.mkdirSync(${JSON.stringify(path.join(root, ".state"))}, {recursive:true});\nfs.appendFileSync(${JSON.stringify(path.join(root, ".state", `${name}.runs`))}, "run\\n");\nprocess.exit(fs.readFileSync("status.txt", "utf8") === "pass" ? 0 : 7);\n`,
		);
	}
	return root;
}

async function copyReporter(root: string): Promise<void> {
	const repository = path.resolve(import.meta.dir, "..");
	const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: repository,
		stdout: "pipe",
		stderr: "inherit",
	});
	const inventory = (await new Response(git.stdout).text()).split("\0").filter(Boolean);
	if (await git.exited) throw new Error("Reporter source inventory failed");
	const graph = await discoverGateInputs(
		repository,
		[
			{
				label: "test/repository scripts",
				argv: [process.execPath, path.join(import.meta.dir, "test-report-bun.ts")],
				cwd: repository,
			},
		],
		inventory,
	);
	const inputs = new Set(Object.values(graph.groups).flat());
	for (const file of inputs) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.copyFile(path.join(repository, file), path.join(root, file));
	}
	for (const file of inputs) {
		if (!/^packages\/[^/]+\/package\.json$/.test(file)) continue;
		const manifest = await Bun.file(path.join(root, file)).json();
		const alias = path.join(root, "node_modules", manifest.name);
		if (
			await fs.stat(alias).then(
				() => true,
				() => false,
			)
		)
			continue;
		await fs.mkdir(path.dirname(alias), { recursive: true });
		await fs.symlink(path.join(root, path.dirname(file)), alias, process.platform === "win32" ? "junction" : "dir");
	}
}

async function batch(
	root: string,
	commands: GateCommand[],
	level: GateLevel = "fastcheck",
): Promise<{ exitCode: number; targets: BazelTargetResult[] }> {
	let targets: BazelTargetResult[] = [];
	const result = await runGate(level, async gate => {
		targets = await runBazelCommands(gate, commands, {
			root,
			concurrency: 2,
			serverIdleSeconds: fixtureServerIdleSeconds,
		});
	});
	return { exitCode: result.exitCode, targets };
}

async function cleanup(root: string): Promise<void> {
	// Keep both live server footprints and their native caches, including graph
	// workspaces, declarations, and leases. Removing their cwd/output base or
	// issuing shutdown would invalidate the very lifecycle exercised above.
	const retained = path.join(root, "node_modules", ".cache", "test-gate-bazel");
	const removeFixture = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			if (filename === retained) continue;
			if (retained.startsWith(`${filename}${path.sep}`) && entry.isDirectory() && !entry.isSymbolicLink())
				await removeFixture(filename);
			else await fs.rm(filename, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	};
	await removeFixture(root);
}

async function nativeIdentity(target: BazelTargetResult): Promise<{ pid: number; outputBase: string }> {
	const events = (await Bun.file(target.buildEventFile).text())
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	const started = events.find(event => event.started)?.started;
	expect(Number(started?.serverPid)).toBeGreaterThan(0);
	const startup: string[] = events.find(event => event.optionsParsed)?.optionsParsed?.startupOptions ?? [];
	const outputBase = startup.find(option => option.startsWith("--output_base="))?.slice("--output_base=".length);
	expect(outputBase).toBeDefined();
	if (/^(test|smoke)\//.test(target.label))
		expect(
			events.some(
				event => event.id?.testSummary?.label === target.target && event.testSummary?.overallStatus === "PASSED",
			),
		).toBe(true);
	return { pid: Number(started.serverPid), outputBase: outputBase! };
}

async function waitForNativeFiles(files: string[], signal: AbortSignal): Promise<void> {
	// Readiness lives in native actions: fake timers cannot advance those processes.
	while (!signal.aborted) {
		if ((await Promise.all(files.map(filename => Bun.file(filename).exists()))).every(Boolean)) return;
		await Bun.sleep(5);
	}
	throw signal.reason;
}

for (const { cancellation, build } of [
	{ cancellation: "first failure", build: false },
	{ cancellation: "timeout", build: false },
	{ cancellation: "first failure", build: true },
	{ cancellation: "runner death", build: false },
	{ cancellation: "runner death", build: true },
] as const) {
	test(`a hot native server cancels ${cancellation} ${build ? "run payloads" : "test actions"} without cancelling another queued GateRun`, async () => {
		const root = await fixture();
		const queuedController = new AbortController();
		const activeController = new AbortController();
		const state = path.join(root, ".state");
		const release = path.join(state, "release");
		const ready = path.join(state, "native.ready");
		const descendant = path.join(state, "descendant.pid");
		let active: Promise<unknown> | undefined;
		let cancelledQueue: Promise<unknown> | undefined;
		let survivingQueue: Promise<unknown> | undefined;
		try {
			const command: GateCommand = {
				label: build ? "build/fixture payload" : "test/fork session",
				argv: [process.execPath, "check.ts"],
				cwd: path.join(root, "packages/a"),
			};
			const warm = await batch(root, [command], "fulltest");
			expect(warm.exitCode).toBe(0);
			const identity = await nativeIdentity(warm.targets[0]!);
			// The native descendant must stay alive until Bazel cancellation, not a mocked timer.
			await Bun.write(
				path.join(root, "packages/a/descendant.ts"),
				`import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(descendant)},String(process.pid)); console.log("ready"); await Bun.sleep(30000);\n`,
			);
			await Bun.write(
				path.join(root, "packages/a/check.ts"),
				`import * as fs from "node:fs"; if (!fs.existsSync(${JSON.stringify(release)})) { const child = Bun.spawn([process.execPath,"descendant.ts"],{stdout:"pipe",stderr:"inherit"}); const reader=child.stdout.getReader(); await reader.read(); reader.releaseLock(); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); await child.exited; }\n`,
			);
			const activeRun = runGate(
				"fulltest",
				async gate => {
					await Promise.all([
						runBazelCommands(gate, [command], {
							root,
							concurrency: 2,
							serverIdleSeconds: fixtureServerIdleSeconds,
						}),
						gate.charged(async () => {
							await waitForNativeFiles([ready, descendant], gate.signal);
							// Establish queued-consumer isolation before triggering any failure.
							await waitForNativeFiles([path.join(state, "fail")], gate.signal);
							if (cancellation === "timeout") {
								// Exercise the real cumulative charged budget only after native
								// readiness. Its stricter child deadline cancels the owned root
								// action without resetting the enclosing fulltest clock.
								await gate.childGate(
									"fastcheck",
									child =>
										child.charged(async () => {
											const stopped = Promise.withResolvers<void>();
											const onAbort = () => stopped.reject(child.signal.reason);
											child.signal.addEventListener("abort", onAbort, { once: true });
											try {
												if (child.signal.aborted) onAbort();
												await stopped.promise;
											} finally {
												child.signal.removeEventListener("abort", onAbort);
											}
										}),
									{ limitSeconds: 0.4, cleanupReserveMs: 0, print: () => {} },
								);
							} else if (cancellation === "runner death") {
								const context = await Bun.file(
									path.join(identity.outputBase.slice(0, -"-output".length), "context.json"),
								).json();
								expect(Number.isSafeInteger(context.runnerPid)).toBe(true);
								process.kill(context.runnerPid, "SIGKILL");
							} else {
								gate.fail(new GateCommandError("fixture first native failure", 37));
							}
						}),
					]);
				},
				{
					signal: activeController.signal,
					print: () => {},
				},
			);
			active = activeRun;
			await waitForNativeFiles([ready, descendant], AbortSignal.timeout(30_000));
			const actionPid = Number(await Bun.file(ready).text());
			const descendantPid = Number(await Bun.file(descendant).text());
			if (cancellation === "first failure" && !build) {
				// Exercise the real host route while its native action is running.
				// Rejected requests must not launch a client or disturb that action.
				const workspace = identity.outputBase.slice(0, -"-output".length);
				const context = await Bun.file(path.join(workspace, "context.json")).json();
				const broker: { url: string; token: string } = context.nativeBroker;
				const runs = path.join(workspace, "runs");
				const declarationName = (await fs.readdir(runs)).find(name => name.endsWith(".batches.json"));
				expect(declarationName).toBeDefined();
				const declaration = await Bun.file(path.join(runs, declarationName!)).json();
				const nestedWorkspace = path.join(state, "denied-native");
				const declaredArgv = [
					declaration.batches[0].argv[0],
					`--output_base=${nestedWorkspace}-output`,
					"--ignore_all_rc_files",
					"test",
					"//:fixture",
				];
				const nestedDeclaration = path.join(nestedWorkspace, "runs", "rejected.batches.json");
				await Bun.write(nestedDeclaration, JSON.stringify({ batches: [{ argv: declaredArgv }] }));
				for (const { token, argv, status, reason } of [
					{ token: "invalid", argv: declaredArgv, status: 403, reason: "Forbidden" },
					{
						token: broker.token,
						argv: [process.execPath, ...declaredArgv.slice(1)],
						status: 400,
						reason: "Invalid nested native executable",
					},
					{
						token: broker.token,
						argv: declaredArgv.map(arg => (arg.startsWith("--output_base=") ? `--output_base=${root}` : arg)),
						status: 400,
						reason: "Invalid nested native output base",
					},
					{
						token: broker.token,
						argv: declaredArgv.map(arg => (arg === "test" ? "shutdown" : arg)),
						status: 400,
						reason: "Native invocation differs from nested declaration",
					},
				]) {
					const response = await fetch(new URL("/native", broker.url), {
						method: "POST",
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
						body: JSON.stringify({
							id: crypto.randomUUID(),
							argv,
							cwd: nestedWorkspace,
							env: { OMP_GATE_NATIVE_DECLARATION: nestedDeclaration },
						}),
					});
					expect(response.status).toBe(status);
					expect(await response.text()).toContain(reason);
					expect(() => process.kill(actionPid, 0)).not.toThrow();
					expect(() => process.kill(descendantPid, 0)).not.toThrow();
				}
			}
			const queuedReady = Promise.withResolvers<void>();
			const queuedRun = runGate(
				"fulltest",
				async gate => {
					queuedReady.resolve();
					await runBazelCommands(gate, [command], {
						root,
						concurrency: 2,
						serverIdleSeconds: fixtureServerIdleSeconds,
					});
				},
				{ signal: queuedController.signal, print: () => {} },
			);
			cancelledQueue = queuedRun;
			await queuedReady.promise;
			queuedController.abort();
			expect((await queuedRun).status).toBe("INTERRUPTED");
			expect(() => process.kill(actionPid, 0)).not.toThrow();
			expect(() => process.kill(descendantPid, 0)).not.toThrow();
			await Bun.write(release, "release");
			const survivingReady = Promise.withResolvers<void>();
			let survivingTargets: BazelTargetResult[] = [];
			const survivor = runGate(
				"fulltest",
				async gate => {
					survivingReady.resolve();
					survivingTargets = await runBazelCommands(gate, [command], {
						root,
						concurrency: 2,
						serverIdleSeconds: fixtureServerIdleSeconds,
					});
				},
				{ print: () => {} },
			);
			survivingQueue = survivor;
			await survivingReady.promise;
			await Bun.write(path.join(state, "fail"), "fail");
			const result = await activeRun;
			expect(result.status).toBe(cancellation === "timeout" ? "TIMEOUT" : "FAIL");
			if (cancellation === "runner death") expect(result.exitCode).not.toBe(0);
			else expect(result.exitCode).toBe(cancellation === "timeout" ? 124 : 37);
			expect(() => process.kill(actionPid, 0)).toThrow();
			expect(() => process.kill(descendantPid, 0)).toThrow();
			await Bun.write(release, "release");
			const surviving = await survivor;
			expect(surviving.exitCode).toBe(0);
			expect(await nativeIdentity(survivingTargets[0]!)).toEqual(identity);
		} finally {
			activeController.abort();
			queuedController.abort();
			await Bun.write(release, "release");
			await Bun.write(path.join(state, "fail"), "fail");
			await Promise.allSettled([active, cancelledQueue, survivingQueue]);
			await cleanup(root);
		}
	}, 120_000);
}

test("native Bazel actions reuse cross-tier success, invalidate real shared/transitive/installed inputs, and never reuse failures", async () => {
	const root = await fixture();
	try {
		const commands: GateCommand[] = ["a", "b"].map(name => ({
			label: `static/TS types @fixture/${name}`,
			argv: [process.execPath, "check.ts"],
			cwd: path.join(root, "packages", name),
		}));
		const first = await batch(root, commands);
		expect(first.exitCode).toBe(0);
		expect(first.targets.map(target => target.status)).toEqual(["new", "new"]);
		const second = await batch(root, commands, "fulltest");
		expect(second.exitCode).toBe(0);
		expect(second.targets.map(target => target.status)).toEqual(["cached", "cached"]);
		await Bun.write(path.join(root, "packages/dependency/untracked-fixture.json"), '{"changed":true}\n');
		const transitive = await batch(root, commands);
		expect(transitive.exitCode).toBe(0);
		expect(transitive.targets.map(target => target.status)).toEqual(["new", "cached"]);
		await Bun.write(path.join(root, "shared.json"), '{"changed":true}\n');
		const shared = await batch(root, commands);
		expect(shared.exitCode).toBe(0);
		expect(shared.targets.map(target => target.status)).toEqual(["new", "new"]);
		await Bun.write(path.join(root, "node_modules/fixture/data.txt"), "installed input\n");
		const installed = await batch(root, commands);
		expect(installed.exitCode).toBe(0);
		expect(installed.targets.map(target => target.status)).toEqual(["new", "new"]);
		await Bun.write(path.join(root, "packages/a/status.txt"), "fail");
		const before = await Bun.file(path.join(root, ".state/a.runs")).text();
		expect((await batch(root, [commands[0]!])).exitCode).toBe(7);
		expect((await batch(root, [commands[0]!])).exitCode).toBe(7);
		expect(await Bun.file(path.join(root, ".state/a.runs")).text()).toBe(`${before}run\nrun\n`);
	} finally {
		await cleanup(root);
	}
}, 240_000);

test("native Bazel test cache retains its own artifacts instead of re-executing unchanged Bun cases", async () => {
	const root = await fixture();
	try {
		await Bun.write(
			path.join(root, "packages/a/sample.test.ts"),
			`import { test, expect } from "bun:test";\nimport * as fs from "node:fs";\ntest("real fixture", () => { fs.mkdirSync(${JSON.stringify(path.join(root, ".state"))},{recursive:true}); fs.appendFileSync(${JSON.stringify(path.join(root, ".state/test.runs"))},"run\\n"); expect(2+2).toBe(4); });\n`,
		);
		const command: GateCommand = {
			label: "test/fork packages/a/sample.test.ts",
			argv: [process.execPath, "test", "sample.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/a"),
			env: { HOME: path.join(root, ".state/home") },
		};
		const first = await batch(root, [command], "fulltest");
		expect(first.exitCode).toBe(0);
		expect(first.targets[0]?.status).toBe("new");
		const identity = await nativeIdentity(first.targets[0]!);
		const second = await batch(root, [command], "slowtest");
		expect(second.exitCode).toBe(0);
		expect(second.targets[0]?.status).toBe("cached");
		expect(await nativeIdentity(second.targets[0]!)).toEqual(identity);
		expect(await Bun.file(path.join(root, ".state/test.runs")).text()).toBe("run\n");
		const events = (await Bun.file(second.targets[0]!.buildEventFile).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
		const summary = events.find(event => event.id?.testSummary)?.testSummary;
		const log = fileURLToPath(summary.passed[0].uri);
		expect(await Bun.file(log).text()).toContain("real fixture");
		await fs.appendFile(path.join(root, "packages/a/sample.test.ts"), "\n// real input edit\n");
		const changed = await batch(root, [command], "fulltest");
		expect(changed.exitCode).toBe(0);
		expect(changed.targets[0]?.status).toBe("new");
		expect(await nativeIdentity(changed.targets[0]!)).toEqual(identity);
		expect(await Bun.file(path.join(root, ".state/test.runs")).text()).toBe("run\nrun\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("native Bazel owns real producer artifacts, restores deleted products, and rejects missing outputs", async () => {
	const root = await fixture();
	try {
		const cwd = path.join(root, "packages/a");
		const input = path.join(cwd, "producer-input.json");
		const counter = path.join(root, ".state/producer.runs");
		await Bun.write(input, JSON.stringify({ values: [2, 5, 7], omitMetadata: false }));
		await Bun.write(
			path.join(cwd, "produce.ts"),
			`import * as fs from "node:fs/promises";
import * as path from "node:path";
const argument = process.argv.find(value => value.startsWith("--output-dir="));
if (!argument) throw new Error("Producer requires --output-dir");
const directory = argument.slice("--output-dir=".length);
const input = JSON.parse(await fs.readFile("producer-input.json", "utf8"));
const total = input.values.reduce((sum, value, index) => sum + value * (index + 1), 0);
await fs.rm(directory, { recursive: true, force: true });
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, "payload.txt"), "weighted=" + total + "\\n");
if (!input.omitMetadata)
 await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify({ count: input.values.length, total }));
await fs.mkdir(${JSON.stringify(path.dirname(counter))}, { recursive: true });
await fs.appendFile(${JSON.stringify(counter)}, "exit-zero\\n");
`,
		);
		await Bun.write(
			path.join(cwd, "consume.ts"),
			`import * as fs from "node:fs/promises";
const payload = await fs.readFile(process.argv[2], "utf8");
const metadata = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
if (payload !== "weighted=" + metadata.total + "\\n") throw new Error("Inconsistent producer outputs");
console.log(JSON.stringify({ total: metadata.total, average: metadata.total / metadata.count }));
`,
		);
		const command: GateCommand = {
			label: "compile/fixture",
			argv: [process.execPath, "produce.ts"],
			cwd,
			artifactFiles: ["payload.txt", "metadata.json"],
		};
		const consume = async (target: BazelTargetResult): Promise<{ total: number; average: number }> => {
			expect(Object.keys(target.artifacts ?? {}).sort()).toEqual(["metadata.json", "payload.txt"]);
			const events = (await Bun.file(target.buildEventFile).text())
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			const bepFiles = events.flatMap(event => [
				...(event.namedSetOfFiles?.files ?? []),
				...(event.completed?.outputGroup ?? []).flatMap(
					(group: { inlineFiles?: { uri?: string }[] }) => group.inlineFiles ?? [],
				),
			]);
			const bepPaths = new Set(
				bepFiles
					.filter((file: { uri?: string }) => file.uri?.startsWith("file:"))
					.map((file: { uri: string }) => fileURLToPath(file.uri)),
			);
			for (const filename of Object.values(target.artifacts!)) {
				expect(path.isAbsolute(filename)).toBe(true);
				expect(bepPaths.has(filename)).toBe(true);
				expect((await fs.stat(filename)).isFile()).toBe(true);
			}
			const consumer = Bun.spawn(
				[process.execPath, "consume.ts", target.artifacts!["payload.txt"]!, target.artifacts!["metadata.json"]!],
				{ cwd, stdout: "pipe", stderr: "inherit" },
			);
			const output = await new Response(consumer.stdout).text();
			expect(await consumer.exited).toBe(0);
			return JSON.parse(output);
		};
		const first = await batch(root, [command], "fulltest");
		expect(first.exitCode).toBe(0);
		expect(first.targets[0]?.status).toBe("new");
		expect(await consume(first.targets[0]!)).toEqual({ total: 33, average: 11 });
		expect(await Bun.file(first.targets[0]!.artifacts!["payload.txt"]!).text()).toBe("weighted=33\n");
		expect(await Bun.file(first.targets[0]!.artifacts!["metadata.json"]!).json()).toEqual({ count: 3, total: 33 });
		expect(await Bun.file(counter).text()).toBe("exit-zero\n");
		const second = await batch(root, [command], "fulltest");
		expect(second.exitCode).toBe(0);
		expect(second.targets[0]?.status).toBe("cached");
		expect(second.targets[0]?.artifacts).toEqual(first.targets[0]!.artifacts);
		expect(await consume(second.targets[0]!)).toEqual({ total: 33, average: 11 });
		expect(await Bun.file(counter).text()).toBe("exit-zero\n");
		await fs.unlink(second.targets[0]!.artifacts!["payload.txt"]!);
		const restored = await batch(root, [command], "fulltest");
		expect(restored.exitCode).toBe(0);
		expect(await consume(restored.targets[0]!)).toEqual({ total: 33, average: 11 });
		// Native disk-cache restoration may avoid executing the producer again.
		const restoredRuns = await Bun.file(counter).text();
		expect(["exit-zero\n", "exit-zero\nexit-zero\n"]).toContain(restoredRuns);
		await Bun.write(input, JSON.stringify({ values: [4, 8], omitMetadata: false }));
		const changed = await batch(root, [command], "fulltest");
		expect(changed.exitCode).toBe(0);
		expect(changed.targets[0]?.status).toBe("new");
		expect(await consume(changed.targets[0]!)).toEqual({ total: 20, average: 10 });
		expect(await Bun.file(counter).text()).toBe(`${restoredRuns}exit-zero\n`);
		await Bun.write(input, JSON.stringify({ values: [4, 8], omitMetadata: true }));
		for (let attempt = 1; attempt <= 2; attempt++) {
			const missing = await batch(root, [command], "fulltest");
			expect(missing.exitCode).not.toBe(0);
			expect(missing.targets.some(target => target.status === "cached")).toBe(false);
			expect(await Bun.file(counter).text()).toBe(`${restoredRuns}${"exit-zero\n".repeat(1 + attempt)}`);
		}
	} finally {
		await cleanup(root);
	}
}, 240_000);

test.skipIf(process.platform !== "win32")(
	"CI Rust checks cache real success and invalidate Rust sources, ignored configs, and enumerated definitions",
	async () => {
		const root = await fixture();
		try {
			const homes = {
				CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"),
				RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup"),
			};
			await Bun.write(
				path.join(root, ".gitignore"),
				"node_modules/\n.state/\ntarget/\n**/.clippy.toml\n**/.rustfmt.toml\ncrates/pi-shell/src/minimizer/defs/*.toml\n",
			);
			await Bun.write(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/probe"]\nresolver = "2"\n');
			await Bun.write(
				path.join(root, "crates/probe/Cargo.toml"),
				'[package]\nname = "gate-rust-probe"\nversion = "0.1.0"\nedition = "2021"\n',
			);
			// Locked metadata accepts semantically equal lockfiles, but unlocked
			// clippy rewrites missing generated headers. Start with Cargo's bytes
			// so the first consumer does not mutate its own declared input.
			const lockfile =
				'# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "gate-rust-probe"\nversion = "0.1.0"\n';
			await Bun.write(path.join(root, "Cargo.lock"), lockfile);
			const source = path.join(root, "crates/probe/src/lib.rs");
			await Bun.write(source, "pub fn answer() -> u32 {\n    42\n}\n");
			const definition = path.join(root, "crates/pi-shell/src/minimizer/defs/probe.toml");
			await Bun.write(definition, 'name = "first"\n');
			// SDKROOT is ignored by Git and has no Bazel packages initially.
			// A real Cargo build script consumes this external inventory root.
			const sdk = path.join(root, ".state/sdk");
			const sdkValue = path.join(sdk, "include/value.txt");
			await Bun.write(sdkValue, "valid\n");
			await Bun.write(
				path.join(root, "crates/probe/build.rs"),
				`fn main() {
    let sdk = std::env::var_os("SDKROOT").expect("SDKROOT");
    let value = std::path::PathBuf::from(sdk).join("include/value.txt");
    println!("cargo:rerun-if-changed={}", value.display());
    assert_eq!(std::fs::read_to_string(value).unwrap().trim(), "valid");
}
`,
			);
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({ scripts: { "check:rs": "bun rust-check.ts" } }),
			);
			const counter = path.join(root, ".state/rust.runs");
			await Bun.write(
				path.join(root, "rust-check.ts"),
				`import * as fs from "node:fs";
if (process.env.OMP_GATE_BAZEL_PRIMITIVE !== "1") throw new Error("Missing primitive marker");
fs.mkdirSync(${JSON.stringify(path.dirname(counter))}, { recursive: true });
fs.appendFileSync(${JSON.stringify(counter)}, "run\\n");
for (const argv of [
	["cargo", "fmt", "--all", "--", "--check"],
	["cargo", "clippy", "--workspace", "--no-deps", "--", "-D", "warnings"],
]) {
	const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code) process.exit(code);
}
`,
			);
			const command: GateCommand = {
				label: "static/Rust fmt+clippy",
				argv: ["bun", "run", "check:rs"],
				cwd: root,
				env: { ...homes, SDKROOT: sdk, CI: "1", RUSTUP_AUTO_INSTALL: "0" },
			};
			let runs = 0;
			const fresh = async () => {
				const result = await batch(root, [command]);
				expect(result.exitCode).toBe(0);
				expect(result.targets[0]?.status).toBe("new");
				expect(await Bun.file(counter).text()).toBe("run\n".repeat(++runs));
			};
			await fresh();
			expect(await Bun.file(path.join(root, "Cargo.lock")).text()).toBe(lockfile);
			const cached = await batch(root, [command], "fulltest");
			expect(cached.exitCode).toBe(0);
			if (cached.targets[0] && cached.targets[0].status !== "cached") {
				const explain = `${cached.targets[0].buildEventFile}.explain.txt`;
				console.error(`Unexpected Rust cache miss (${explain}):\n${await Bun.file(explain).text()}`);
			}
			expect(cached.targets[0]?.status).toBe("cached");
			expect(await Bun.file(counter).text()).toBe("run\n".repeat(runs));
			// Creating a package must switch away from the root glob. Editing
			// an existing file beneath it must still rerun the Cargo consumer.
			await Bun.write(path.join(sdk, "include/BUILD.bazel"), "# SDK-owned package\n");
			await fresh();
			await Bun.write(sdkValue, "valid \n");
			await fresh();
			await Bun.write(source, "pub fn answer() -> u32 {\n    43\n}\n");
			await fresh();
			// These files are absent at initial discovery and ignored by Git.
			await Bun.write(path.join(root, ".clippy.toml"), "too-many-arguments-threshold = 8\n");
			await fresh();
			await Bun.write(path.join(root, ".clippy.toml"), "too-many-arguments-threshold = 9\n");
			await fresh();
			await Bun.write(path.join(root, "crates/probe/.rustfmt.toml"), "max_width = 99\n");
			await fresh();
			await Bun.write(path.join(root, "crates/pi-shell/src/minimizer/defs/new.toml"), 'name = "new"\n');
			await fresh();
			await Bun.write(definition, 'name = "changed"\n');
			await fresh();
			await Bun.write(source, "pub fn answer() -> u32 {\n    missing_symbol()\n}\n");
			for (let attempt = 0; attempt < 2; attempt++) {
				expect((await batch(root, [command])).exitCode).not.toBe(0);
				expect(await Bun.file(counter).text()).toBe("run\n".repeat(++runs));
			}
		} finally {
			await cleanup(root);
		}
	},
	600_000,
);

test.each(["missing homes", "non-CI", "disabled reuse", "different primitive"] as const)(
	"unclosed Rust commands execute every round and restore deleted external products: %s",
	async reason => {
		const root = await fixture();
		try {
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({ scripts: { "check:rs": "bun packages/a/check.ts" } }),
			);
			await Bun.write(path.join(root, "status.txt"), "pass");
			const command: GateCommand = {
				label: "static/Rust fmt+clippy",
				argv:
					reason === "different primitive"
						? [process.execPath, "packages/a/check.ts"]
						: ["bun", "run", "check:rs"],
				cwd: root,
				env: {
					CI: reason === "non-CI" ? "0" : "1",
					CARGO_HOME:
						reason === "missing homes" ? "" : (process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo")),
					RUSTUP_HOME:
						reason === "missing homes" ? "" : (process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup")),
				},
				...(reason === "disabled reuse" ? { resultReuse: "disabled" as const } : {}),
			};
			const product = path.join(root, ".state/a.runs");
			const first = await batch(root, [command]);
			expect(first.exitCode).toBe(0);
			expect(first.targets[0]?.status).toBe("new");
			expect(await Bun.file(product).text()).toBe("run\n");
			const second = await batch(root, [command]);
			expect(second.exitCode).toBe(0);
			expect(second.targets[0]?.status).toBe("new");
			expect(await Bun.file(product).text()).toBe("run\nrun\n");
			await fs.unlink(product);
			const restored = await batch(root, [command]);
			expect(restored.exitCode).toBe(0);
			expect(restored.targets[0]?.status).toBe("new");
			expect(await Bun.file(product).text()).toBe("run\n");
		} finally {
			await cleanup(root);
		}
	},
	120_000,
);

// Each lifecycle has its own timed real fixture and cold native warm. Keeping
// failure/recovery before SIGKILL in one case consumed its cancellation window.
test.each(["normal exits and failure", "top-level SIGKILL"] as const)(
	"native servers survive independent public Bun CLI %s",
	async lifecycle => {
		const root = await fixture();
		const release = path.join(root, ".state", "cli-death.release");
		let killedCli: Bun.Subprocess | undefined;
		let successor: Promise<{ exitCode: number; targets: BazelTargetResult[] }> | undefined;
		try {
			await Bun.write(
				path.join(root, "packages/dependency/package.json"),
				JSON.stringify({ name: "@fixture/dependency", dependencies: { "@fixture/a": "workspace:*" } }),
			);
			const commands: GateCommand[] = [
				{ label: "test/fork session", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/a") },
				{ label: "test/fork remaining", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/b") },
			];
			const entry = path.join(root, ".state", "independent-cli.ts");
			const resultFile = path.join(root, ".state", "independent-cli.json");
			await Bun.write(
				entry,
				`import { runGate } from ${JSON.stringify(path.join(import.meta.dir, "test-gate-runtime.ts"))};
import { runBazelCommands } from ${JSON.stringify(path.join(import.meta.dir, "test-gate-bazel.ts"))};
let targets = [];
const result = await runGate("fulltest", async gate => {
	targets = await runBazelCommands(gate, ${JSON.stringify(commands)}, { root: ${JSON.stringify(root)}, concurrency: 2, serverIdleSeconds: ${fixtureServerIdleSeconds} });
});
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ exitCode: result.exitCode, targets }));
process.exit(result.exitCode);
`,
			);
			const invoke = async (): Promise<{ exitCode: number; targets: BazelTargetResult[] }> => {
				// Exercise both the public `bun run` wrapper and its script process.
				// Await their real exit before inspecting/reusing either JVM; no
				// resident GateRun host is allowed to own the persistent servers.
				const child = Bun.spawn([process.execPath, "run", entry], {
					cwd: root,
					env: { ...process.env },
					stdin: "ignore",
					stdout: "inherit",
					stderr: "inherit",
				});
				const exitCode = await child.exited;
				const result = await Bun.file(resultFile).json();
				expect(exitCode).toBe(result.exitCode);
				return result;
			};
			const first = await invoke();
			expect(first.exitCode).toBe(0);
			const identity = await nativeIdentity(first.targets[0]!);
			const graphPidFile = path.join(
				root,
				"node_modules/.cache/test-gate-bazel/tests/graph-workspace-output/server/server.pid.txt",
			);
			const graphPid = Number((await Bun.file(graphPidFile).text()).trim());
			expect(graphPid).toBeGreaterThan(0);
			for (const pid of [identity.pid, graphPid]) expect(() => process.kill(pid, 0)).not.toThrow();
			if (lifecycle === "normal exits and failure") {
				const second = await invoke();
				expect(second.exitCode).toBe(0);
				expect(second.targets.map(target => target.status)).toEqual(["cached", "cached"]);
				for (const target of second.targets) expect(await nativeIdentity(target)).toEqual(identity);
				expect(Number((await Bun.file(graphPidFile).text()).trim())).toBe(graphPid);
				await Bun.write(path.join(root, "packages/b/status.txt"), "fail");
				expect((await invoke()).exitCode).not.toBe(0);
				expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\nrun\n");
				for (const pid of [identity.pid, graphPid]) expect(() => process.kill(pid, 0)).not.toThrow();
				await Bun.write(path.join(root, "packages/b/status.txt"), "pass");
				const recovered = await invoke();
				expect(recovered.exitCode).toBe(0);
				for (const target of recovered.targets) expect(await nativeIdentity(target)).toEqual(identity);
				expect(Number((await Bun.file(graphPidFile).text()).trim())).toBe(graphPid);
				expect(await Bun.file(path.join(root, ".state/a.runs")).text()).toBe("run\n");
				return;
			}
			const ready = path.join(root, ".state", "cli-death.ready");
			const descendant = path.join(root, ".state", "cli-death.descendant");
			await Bun.write(
				path.join(root, "packages/a/descendant.ts"),
				`import * as fs from "node:fs"; const watcher = fs.watch("."); process.on("exit", () => watcher.close()); fs.writeFileSync(${JSON.stringify(descendant)}, String(process.pid)); console.log("ready"); await Promise.withResolvers().promise;\n`,
			);
			await Bun.write(
				path.join(root, "packages/a/check.ts"),
				`import * as fs from "node:fs"; if (!fs.existsSync(${JSON.stringify(release)})) { const child = Bun.spawn([process.execPath, "descendant.ts"], { stdout: "pipe", stderr: "inherit" }); const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock(); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); await child.exited; }\n`,
			);
			// Kill the actual top-level standalone Bun CLI, not its reporting
			// runner. Its guardian must survive to cancel the action and retain
			// the declaration lease until that cancellation is acknowledged.
			killedCli = Bun.spawn([process.execPath, entry], {
				cwd: root,
				env: { ...process.env },
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
			await waitForNativeFiles([ready, descendant], AbortSignal.timeout(30_000));
			const actionPid = Number(await Bun.file(ready).text());
			const descendantPid = Number(await Bun.file(descendant).text());
			await Bun.write(release, "release");
			successor = invoke();
			killedCli.kill("SIGKILL");
			await killedCli.exited;
			const afterDeath = await successor;
			expect(afterDeath.exitCode).toBe(0);
			expect(() => process.kill(actionPid, 0)).toThrow();
			expect(() => process.kill(descendantPid, 0)).toThrow();
			for (const target of afterDeath.targets) expect(await nativeIdentity(target)).toEqual(identity);
			expect(Number((await Bun.file(graphPidFile).text()).trim())).toBe(graphPid);
		} finally {
			await Bun.write(release, "release");
			if (killedCli?.exitCode === null) killedCli.kill("SIGKILL");
			await Promise.allSettled([killedCli?.exited, successor]);
			await cleanup(root);
		}
	},
	120_000,
);

test("cached risk bands retain one supervised Bazel server and complete native evidence", async () => {
	const root = await fixture();
	try {
		// A real workspace dependency cycle forces native allpaths discovery.
		await Bun.write(
			path.join(root, "packages/dependency/package.json"),
			JSON.stringify({ name: "@fixture/dependency", dependencies: { "@fixture/a": "workspace:*" } }),
		);
		const graphOutputBase = path.join(root, "node_modules/.cache/test-gate-bazel/tests/graph-workspace-output");
		const graphPidFile = path.join(graphOutputBase, "server/server.pid.txt");
		const commands: GateCommand[] = [
			{ label: "test/fork session", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/a") },
			{ label: "test/fork remaining", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/b") },
		];
		const first = await batch(root, commands, "fulltest");
		expect(first.exitCode).toBe(0);
		const identity = await nativeIdentity(first.targets[0]!);
		const graphPid = Number((await Bun.file(graphPidFile).text()).trim());
		expect(graphPid).toBeGreaterThan(0);
		expect(() => process.kill(graphPid, 0)).not.toThrow();
		const second = await batch(root, commands, "fulltest");
		expect(second.exitCode).toBe(0);
		expect(second.targets.map(target => target.label)).toEqual(commands.map(command => command.label));
		expect(second.targets.map(target => target.status)).toEqual(["cached", "cached"]);
		const serverPids = [];
		for (const target of second.targets) {
			const events = (await Bun.file(target.buildEventFile).text())
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			const started = events.find(event => event.started)?.started;
			expect(Number(started?.serverPid)).toBeGreaterThan(0);
			serverPids.push(started.serverPid);
			expect(
				events.some(
					event => event.id?.testSummary?.label === target.target && event.testSummary?.overallStatus === "PASSED",
				),
			).toBe(true);
		}
		expect(new Set(serverPids).size).toBe(1);
		for (const target of second.targets) expect(await nativeIdentity(target)).toEqual(identity);
		expect(Number((await Bun.file(graphPidFile).text()).trim())).toBe(graphPid);
		expect(() => process.kill(graphPid, 0)).not.toThrow();
		expect(await Bun.file(path.join(root, ".state/a.runs")).text()).toBe("run\n");
		expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\n");
		// A partial cache miss must still execute the invalidated lower band
		// without re-running the successful higher band or losing its evidence.
		await fs.appendFile(path.join(root, "packages/b/check.ts"), "\n");
		const changed = await batch(root, commands, "fulltest");
		expect(changed.exitCode).toBe(0);
		expect(changed.targets.map(target => target.status)).toEqual(["cached", "new"]);
		for (const target of changed.targets) expect(await nativeIdentity(target)).toEqual(identity);
		expect(Number((await Bun.file(graphPidFile).text()).trim())).toBe(graphPid);
		expect(await Bun.file(path.join(root, ".state/a.runs")).text()).toBe("run\n");
		expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\nrun\n");
		// Changed file contents and a previously failed test result are distinct
		// misses: neither may be mistaken for an unchanged successful test.
		await Bun.write(path.join(root, "packages/b/status.txt"), "fail");
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\nrun\nrun\n");
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\nrun\nrun\nrun\n");
		expect(await Bun.file(path.join(root, ".state/a.runs")).text()).toBe("run\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("a failing risk band still dispatches the lower-risk native test band", async () => {
	const root = await fixture();
	try {
		await Bun.write(path.join(root, "packages/a/status.txt"), "fail");
		const result = await batch(
			root,
			[
				{ label: "test/fork session", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/a") },
				{ label: "test/fork remaining", argv: [process.execPath, "check.ts"], cwd: path.join(root, "packages/b") },
			],
			"fulltest",
		);
		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(root, ".state/b.runs")).text()).toBe("run\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("local business, asset and installed dependency edits invalidate only their real test consumers", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		await Bun.write(
			path.join(root, "configs/jsx.json"),
			'{"compilerOptions":{"jsx":"react","jsxFactory":"jsxFirst"}}\n',
		);
		await Bun.write(path.join(root, "packages/a/tsconfig.json"), '{"extends":"../../configs/jsx.json"}\n');
		const leftModule = (expression: string) =>
			`export const value = ${expression};\nexport function startWorker() { return new Worker(new URL("./worker.ts", import.meta.url)); }\n`;
		await Bun.write(path.join(root, "packages/a/left.ts"), leftModule("1 + 1"));
		await Bun.write(path.join(root, "packages/a/worker.ts"), 'import { value } from "./left"; postMessage(value);\n');
		await Bun.write(
			path.join(root, "packages/a/right.ts"),
			'export const value = 7;\nexport function startWorker() { return new Worker(new URL("./right-worker.ts", import.meta.url)); }\n',
		);
		await Bun.write(
			path.join(root, "packages/a/right-worker.ts"),
			'import { value } from "./right"; postMessage(value);\n',
		);
		await Bun.write(path.join(root, "packages/a/fixtures/value.json"), '{"value":2}\n');
		await Bun.write(
			path.join(root, "node_modules/fixture-used/package.json"),
			'{"name":"fixture-used","exports":"./index.js"}\n',
		);
		await Bun.write(
			path.join(root, "node_modules/fixture-used/index.js"),
			'import "./side-effect.js"; export const value = 40 + 2;\n',
		);
		await Bun.write(path.join(root, "node_modules/fixture-used/side-effect.js"), "export {};\n");
		await Bun.write(
			path.join(root, "node_modules/fixture-unused/package.json"),
			'{"name":"fixture-unused","exports":"./index.js"}\n',
		);
		await Bun.write(path.join(root, "node_modules/fixture-unused/index.js"), "export const value = 0;\n");
		await Bun.write(
			path.join(root, "packages/a/child.tsx"),
			'import { value } from "./left"; function jsxFirst() { return value; } function jsxSecond() { return 99; } console.log(<item />);\n',
		);
		await Bun.write(
			path.join(root, "packages/a/left.test.ts"),
			`
import { test, expect } from "bun:test";
import { value } from "fixture-used";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorker } from "./left";
function parseAsset(contents: string) { return JSON.parse(contents); }
function command(plan: { argv: string[] }) { return { cmd: plan.argv, cwd: import.meta.dir, stdout: "pipe" }; }
test("left consumer", async () => {
 const generated = path.resolve(import.meta.dir, "../../node_modules/.cache/omp-gate-wrappers", \`\${process.platform}-\${process.arch}\`);
 mkdirSync(generated, {recursive:true});
 const temporary = path.join(generated, \`fixture-\${randomUUID()}.txt\`);
 writeFileSync(temporary, "generated from declared source");
 expect(readFileSync(temporary, "utf8")).toBe("generated from declared source");
 const worker = startWorker();
 try {
  const { promise, resolve, reject } = Promise.withResolvers();
  worker.onmessage = event => resolve(event.data);
  worker.onerror = reject;
  expect(await promise).toBe(2);
 } finally { worker.terminate(); }
 const child = Bun.spawn(command({ argv: [process.execPath, fileURLToPath(new URL("./child.tsx", import.meta.url))] }));
 const output = await new Response(child.stdout).text();
 expect(await child.exited).toBe(0);
 expect(output.trim()).toBe("2");
 expect(value).toBe(42);
 const contents = await Bun.file(new URL("./fixtures/value.json", import.meta.url)).text();
 expect(parseAsset(contents).value).toBe(2);
 mkdirSync(${JSON.stringify(path.join(root, ".state"))}, {recursive:true});
 appendFileSync(${JSON.stringify(path.join(root, ".state/left.runs"))}, "run\\n");
});
`,
		);
		await Bun.write(
			path.join(root, "packages/a/right.test.ts"),
			`
import { test, expect } from "bun:test";
import { startWorker } from "./right";
import { appendFileSync, mkdirSync } from "node:fs";
test("right consumer", async () => {
 const worker = startWorker();
 try {
  const { promise, resolve, reject } = Promise.withResolvers();
  worker.onmessage = event => resolve(event.data);
  worker.onerror = reject;
  expect(await promise).toBe(7);
 } finally { worker.terminate(); }
 mkdirSync(${JSON.stringify(path.join(root, ".state"))}, {recursive:true});
 appendFileSync(${JSON.stringify(path.join(root, ".state/right.runs"))}, "run\\n");
});
`,
		);
		const commands: GateCommand[] = ["left", "right"].map(name => ({
			label: `test/fork packages/a/${name}.test.ts`,
			argv: [process.execPath, "../../scripts/test-report-bun.ts", `${name}.test.ts`, "--bail=1"],
			cwd: path.join(root, "packages/a"),
		}));
		await Bun.write(
			path.join(root, "packages/a/extra.test.ts"),
			'import { test, expect } from "bun:test"; import { value } from "fixture-used"; test("extra shared importer", () => expect(value).toBe(42));\n',
		);
		const extraCommand: GateCommand = {
			label: "test/fork packages/a/extra.test.ts",
			argv: [process.execPath, "../../scripts/test-report-bun.ts", "extra.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/a"),
		};
		const initial = await batch(root, commands, "fulltest");
		expect(initial.exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		// A different entry set changes Bun chunk ownership, not the actual
		// inputs of the two independent worker consumers already cached.
		const expanded = await batch(root, [commands[1]!, extraCommand, commands[0]!], "fulltest");
		expect(expanded.exitCode).toBe(0);
		for (const command of commands)
			expect(expanded.targets.find(target => target.label === command.label)?.status).toBe("cached");
		const reordered = await batch(root, [...commands].reverse(), "fulltest");
		expect(reordered.exitCode).toBe(0);
		expect(reordered.targets.every(target => target.status === "cached")).toBe(true);
		await Bun.write(path.join(root, "packages/a/unrelated.ts"), "export const unrelated = true;\n");
		await Bun.write(path.join(root, "node_modules/fixture-unused/index.js"), "export const value = 99;\n");
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		await Bun.write(path.join(root, "packages/a/left.ts"), leftModule("2"));
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual(["new", "cached"]);
		await Bun.write(path.join(root, "packages/a/fixtures/value.json"), '{ "value": 2 }\n');
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual(["new", "cached"]);
		await Bun.write(
			path.join(root, "node_modules/fixture-used/index.js"),
			'import "./side-effect.js"; export const value = 42;\n',
		);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual(["new", "cached"]);
		expect(await Bun.file(path.join(root, ".state/right.runs")).text()).toBe("run\n");
		expect(await Bun.file(path.join(root, ".state/left.runs")).text()).toBe("run\nrun\nrun\nrun\n");
		// Tree-external tool state explicitly disables successful test reuse.
		// Observe execution through the real consumer, not its reported status.
		const uncachedCommands: GateCommand[] = [commands[0]!, { ...commands[1]!, resultReuse: "disabled" }];
		for (const count of [2, 3]) {
			const uncached = await batch(root, uncachedCommands, "fulltest");
			expect(uncached.exitCode).toBe(0);
			expect(uncached.targets.find(target => target.label === commands[0]!.label)?.status).toBe("cached");
			expect(await Bun.file(path.join(root, ".state/right.runs")).text()).toBe("run\n".repeat(count));
			expect(await Bun.file(path.join(root, ".state/left.runs")).text()).toBe("run\nrun\nrun\nrun\n");
		}
		// Even a module contributing no emitted bytes remains a real source
		// input; adding a side effect must invalidate its actual consumer.
		await Bun.write(
			path.join(root, "node_modules/fixture-used/side-effect.js"),
			'throw new Error("changed input");\n',
		);
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		await Bun.write(path.join(root, "node_modules/fixture-used/side-effect.js"), "export {};\n");
		await Bun.write(
			path.join(root, "configs/jsx.json"),
			'{"compilerOptions":{"jsx":"react","jsxFactory":"jsxSecond"}}\n',
		);
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		await Bun.write(path.join(root, "packages/b/fixtures/relative-child.ts"), "console.log(2);\n");
		await Bun.write(
			path.join(root, "packages/a/relative.test.ts"),
			`
import { test, expect } from "bun:test";
test("relative subprocess cwd", async () => {
 const child = Bun.spawn({ cmd: [process.execPath, "./relative-child.ts"], cwd: "../b/fixtures", stdout: "pipe" });
 const output = await new Response(child.stdout).text();
 expect(await child.exited).toBe(0);
 expect(output.trim()).toBe("2");
});
`,
		);
		const relativeCommand: GateCommand = {
			label: "test/fork packages/a/relative.test.ts",
			argv: [process.execPath, "../../scripts/test-report-bun.ts", "relative.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/a"),
		};
		expect((await batch(root, [relativeCommand], "fulltest")).exitCode).toBe(0);
		expect((await batch(root, [relativeCommand], "fulltest")).targets[0]?.status).toBe("cached");
		await Bun.write(path.join(root, "packages/b/fixtures/relative-child.ts"), "console.log(99);\n");
		expect((await batch(root, [relativeCommand], "fulltest")).exitCode).not.toBe(0);
		for (const [name, imported, factory] of [
			["named", "{ createRequire }", "createRequire"],
			["alias", "{ createRequire as makeRequire }", "makeRequire"],
			["namespace", "* as nodeModule", "nodeModule.createRequire"],
		]) {
			await Bun.write(path.join(root, "node_modules/fixture-used/index.js"), "export const value = 42;\n");
			const file = `require-${name}.test.ts`;
			await Bun.write(
				path.join(root, "packages/a", file),
				`
import { test, expect } from "bun:test";
import ${imported} from "node:module";
${name === "alias" ? `const load = ${factory}(import.meta.url);` : ""}
test("require factory input", () => expect(${name === "alias" ? "load" : `${factory}(import.meta.url)`}("fixture-used").value).toBe(42));
`,
			);
			const command: GateCommand = {
				label: `test/fork packages/a/${file}`,
				argv: [process.execPath, "../../scripts/test-report-bun.ts", file, "--bail=1"],
				cwd: path.join(root, "packages/a"),
			};
			expect((await batch(root, [command], "fulltest")).exitCode).toBe(0);
			expect((await batch(root, [command], "fulltest")).targets[0]?.status).toBe("cached");
			await Bun.write(path.join(root, "node_modules/fixture-used/index.js"), "export const value = 99;\n");
			expect((await batch(root, [command], "fulltest")).exitCode).not.toBe(0);
		}
	} finally {
		await cleanup(root);
	}
}, 240_000);

test("temporary shell probes cache independently while real shell script edits invalidate their consumer", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		const runs = path.join(root, ".state/temporary-probe.runs");
		const independentRuns = path.join(root, ".state/temporary-independent.runs");
		await Bun.write(path.join(root, "packages/a/worker.ts"), "console.log(42);\n");
		await Bun.write(
			path.join(root, "packages/a/probe.test.ts"),
			`import { test, expect } from "bun:test";
import { $ } from "bun";
import os from "node:os";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
function fixture() {
 const temp = mkdtempSync(path.join(os.tmpdir(), "gate-fixture-"));
 const root = path.join(temp, "project");
 mkdirSync(root);
 return {temp, root};
}
test("temporary capability probe and repository script", async () => {
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
 const {temp, root} = fixture();
 const alias = root;
 const probe = await $\`bun --version\`.cwd(alias).quiet().nothrow();
 expect(probe.exitCode).toBe(0);
 const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "worker.ts")], {cwd: alias, stdout:"pipe"});
 const output = await new Response(child.stdout).text();
 expect(await child.exited).toBe(0);
 rmSync(temp, {recursive:true, force:true});
 expect(output.trim()).toBe("42");
});
`,
		);
		await Bun.write(
			path.join(root, "packages/b/independent.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("independent consumer", () => {
 expect(6 * 7).toBe(42);
 mkdirSync(${JSON.stringify(path.dirname(independentRuns))}, {recursive:true});
 appendFileSync(${JSON.stringify(independentRuns)}, "run\\n");
});
`,
		);
		const commands: GateCommand[] = ["a/probe", "b/independent"].map(entry => {
			const [name, testName] = entry.split("/");
			return {
				label: `test/fork packages/${name}/${testName}.test.ts`,
				argv: [process.execPath, "../../scripts/test-report-bun.ts", `${testName}.test.ts`, "--bail=1"],
				cwd: path.join(root, "packages", name!),
			};
		});
		expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		await Bun.write(path.join(root, "shared.json"), '{"unrelated":true}\n');
		await Bun.write(path.join(root, "crates/unrelated/src/lib.rs"), "pub const VALUE: u8 = 2;\n");
		const unrelated = await batch(root, commands, "fulltest");
		expect(unrelated.exitCode).toBe(0);
		expect(unrelated.targets.map(target => target.status)).toEqual(["cached", "cached"]);
		expect(await Bun.file(runs).text()).toBe("run\n");
		await Bun.write(path.join(root, "packages/a/worker.ts"), "console.log(99);\n");
		const changed = await batch(root, commands, "fulltest");
		expect(changed.exitCode).not.toBe(0);
		expect(await Bun.file(runs).text()).toBe("run\nrun\n");
		// Fail-fast may omit the independent target from the failed batch.
		// Request it directly to observe its retained cache without rerunning it.
		const independent = await batch(root, [commands[1]!], "fulltest");
		expect(independent.exitCode).toBe(0);
		expect(independent.targets[0]?.status).toBe("cached");
		expect(await Bun.file(independentRuns).text()).toBe("run\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("explicit indirect source entries retain transitive script assets without caching unrelated source edits", async () => {
	const root = await fixture();
	try {
		const directory = path.join(root, "packages/dependency");
		const source = path.join(directory, "indirect.ts");
		const runs = path.join(root, ".state/indirect.runs");
		const entrySource = `import { $ } from "bun";
const child = await $\`bun ./worker.ts\`.cwd(import.meta.dir).quiet();
console.log(child.stdout.toString().trim());
`;
		await Bun.write(source, entrySource);
		await Bun.write(
			path.join(directory, "worker.ts"),
			'import { readFileSync } from "node:fs"; console.log(readFileSync(import.meta.dir + "/value.txt", "utf8").trim());\n',
		);
		await Bun.write(path.join(directory, "value.txt"), "42\n");
		await Bun.write(
			path.join(root, "packages/a/indirect.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("indirect launch", async () => {
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
 const child = Bun.spawn([process.execPath, process.env.INDIRECT_SOURCE!], {stdout:"pipe", stderr:"inherit"});
 const output = await new Response(child.stdout).text();
 expect(await child.exited).toBe(0);
 expect(output.trim()).toBe("42");
});
`,
		);
		const command: GateCommand = {
			label: "test/fork packages/a/indirect.test.ts",
			argv: [process.execPath, "test", "indirect.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/a"),
			sourceEntrypoints: ["../dependency/indirect.ts"],
			env: { INDIRECT_SOURCE: source },
		};
		expect((await batch(root, [command], "fulltest")).exitCode).toBe(0);
		expect((await batch(root, [command], "fulltest")).targets[0]?.status).toBe("cached");
		await Bun.write(path.join(directory, "unrelated.ts"), "export const value = 99;\n");
		const unrelated = await batch(root, [command], "fulltest");
		expect(unrelated.exitCode).toBe(0);
		expect(unrelated.targets[0]?.status).toBe("cached");
		expect(await Bun.file(runs).text()).toBe("run\n");
		// The indirect entry launches a static script which reads this asset.
		await Bun.write(path.join(directory, "value.txt"), "42\n\n");
		const resource = await batch(root, [command], "fulltest");
		expect(resource.exitCode).toBe(0);
		expect(resource.targets[0]?.status).not.toBe("cached");
		expect(await Bun.file(runs).text()).toBe("run\nrun\n");
		await Bun.write(source, entrySource.replace("console.log(child.stdout.toString().trim());", "console.log(99);"));
		expect((await batch(root, [command], "fulltest")).exitCode).not.toBe(0);
		expect(await Bun.file(runs).text()).toBe("run\nrun\nrun\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("missing explicit source entries fail discovery instead of dropping the indirect dependency", async () => {
	const root = await fixture();
	try {
		const command: GateCommand = {
			label: "test/indirect missing source",
			argv: [process.execPath, "check.ts"],
			cwd: path.join(root, "packages/a"),
			sourceEntrypoints: ["missing-cli.ts"],
		};
		await expect(discoverGateInputs(root, [command], [])).rejects.toThrow("Missing source entrypoint");
	} finally {
		await cleanup(root);
	}
});

test("opaque package loading reuses unrelated shared edits but observes transitive cyclic package inputs", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		await Bun.write(
			path.join(root, "packages/b/package.json"),
			JSON.stringify({ name: "@fixture/b", dependencies: { "@fixture/dependency": "workspace:*" } }),
		);
		await Bun.write(
			path.join(root, "packages/dependency/package.json"),
			JSON.stringify({ name: "@fixture/dependency", dependencies: { "@fixture/leaf": "workspace:*" } }),
		);
		await Bun.write(
			path.join(root, "packages/leaf/package.json"),
			JSON.stringify({ name: "@fixture/leaf", dependencies: { "@fixture/dependency": "workspace:*" } }),
		);
		await Bun.write(
			path.join(root, "packages/b/value.cjs"),
			'exports.value = require("../dependency/value.cjs").value;\n',
		);
		await Bun.write(
			path.join(root, "packages/dependency/value.cjs"),
			'exports.value = require("../leaf/value.cjs").value;\n',
		);
		await Bun.write(path.join(root, "packages/leaf/value.cjs"), "exports.value = 41;\n");
		await Bun.write(path.join(root, "crates/unrelated/src/lib.rs"), "pub const VALUE: u8 = 1;\n");
		const independentRuns = path.join(root, ".state/independent.runs");
		await Bun.write(
			path.join(root, "packages/b/opaque.test.ts"),
			`import { test, expect } from "bun:test";
import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
test("dynamic local value", () => expect(load("./value.cjs").value + 1).toBe(42));
`,
		);
		await Bun.write(
			path.join(root, "packages/a/independent.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("independent consumer", () => {
 expect(6 * 7).toBe(42);
 mkdirSync(${JSON.stringify(path.dirname(independentRuns))}, {recursive:true});
 appendFileSync(${JSON.stringify(independentRuns)}, "run\\n");
});
`,
		);
		const commands: GateCommand[] = [
			{
				label: "test/fork packages/b/opaque.test.ts",
				argv: [process.execPath, "../../scripts/test-report-bun.ts", "opaque.test.ts", "--bail=1"],
				cwd: path.join(root, "packages/b"),
			},
			{
				label: "test/fork packages/a/independent.test.ts",
				argv: [process.execPath, "../../scripts/test-report-bun.ts", "independent.test.ts", "--bail=1"],
				cwd: path.join(root, "packages/a"),
			},
		];
		expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		await Bun.write(path.join(root, "docs/notes.md"), "Unrelated documentation.\n");
		await Bun.write(path.join(root, "scripts/install.ps1"), "Write-Host 'Unrelated installer'\n");
		await Bun.write(path.join(root, "crates/unrelated/src/lib.rs"), "pub const VALUE: u8 = 2;\n");
		const unrelated = await batch(root, commands, "fulltest");
		expect(unrelated.exitCode).toBe(0);
		expect(unrelated.targets.map(target => target.status)).toEqual(["cached", "cached"]);
		await Bun.write(path.join(root, "packages/leaf/value.cjs"), "exports.value = 99;\n");
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		expect(await Bun.file(independentRuns).text()).toBe("run\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("shared Bun chunks do not spread opaque package inputs to unrelated consumers", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		const runs = path.join(root, ".state/clean.runs");
		await Bun.write(
			path.join(root, "packages/a/shared.ts"),
			'import { meaning } from "./cycle-a"; export const shared = meaning();\n',
		);
		await Bun.write(
			path.join(root, "packages/a/cycle-a.ts"),
			'import { meaning } from "./cycle-b"; export function marker() {} export { meaning };\n',
		);
		await Bun.write(
			path.join(root, "packages/a/cycle-b.ts"),
			'import { marker } from "./cycle-a"; export function meaning() { return typeof marker === "function" ? 42 : 0; }\n',
		);
		await Bun.write(
			path.join(root, "packages/a/clean.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { shared } from "./shared";
test("clean", () => {
 expect(shared).toBe(42);
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
});
`,
		);
		await Bun.write(path.join(root, "packages/b/value.cjs"), "exports.value = 42;\n");
		await Bun.write(
			path.join(root, "packages/b/opaque.ts"),
			`import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
export const value = load("./value.cjs").value;
`,
		);
		for (const name of ["opaque", "extra"])
			await Bun.write(
				path.join(root, `packages/b/${name}.test.ts`),
				`import { test, expect } from "bun:test";
import { shared } from "../a/shared";
import { value } from "./opaque";
test("${name}", () => expect(value).toBe(shared));
`,
			);
		const command = (packageName: string, name: string): GateCommand => ({
			label: `test/fork packages/${packageName}/${name}.test.ts`,
			argv: [process.execPath, "../../scripts/test-report-bun.ts", `${name}.test.ts`, "--bail=1"],
			cwd: path.join(root, "packages", packageName),
		});
		const clean = command("a", "clean");
		const opaque = command("b", "opaque");
		const extra = command("b", "extra");
		const initial = [clean, opaque];
		expect((await batch(root, initial, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, initial, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		const expanded = await batch(root, [clean, opaque, extra], "fulltest");
		expect(expanded.exitCode).toBe(0);
		expect(expanded.targets.find(target => target.label === clean.label)?.status).toBe("cached");
		expect(expanded.targets.find(target => target.label === opaque.label)?.status).toBe("cached");
		await Bun.write(path.join(root, "packages/b/value.cjs"), "exports.value = 6 * 7;\n");
		const changedFallback = await batch(root, [clean, opaque, extra], "fulltest");
		expect(changedFallback.exitCode).toBe(0);
		expect(changedFallback.targets.map(target => target.status)).toEqual(["cached", "new", "new"]);
		await Bun.write(
			path.join(root, "packages/a/cycle-b.ts"),
			'import { marker } from "./cycle-a"; export function meaning() { return typeof marker === "function" ? 6 * 7 : 0; }\n',
		);
		const changedCycle = await batch(root, [clean, opaque, extra], "fulltest");
		expect(changedCycle.exitCode).toBe(0);
		expect(changedCycle.targets.map(target => target.status)).toEqual(["new", "new", "new"]);
		await Bun.write(path.join(root, "packages/a/shared.ts"), "export const shared = 6 * 7;\n");
		const changedImport = await batch(root, [clean, opaque, extra], "fulltest");
		expect(changedImport.exitCode).toBe(0);
		expect(changedImport.targets.map(target => target.status)).toEqual(["new", "new", "new"]);
		expect(await Bun.file(runs).text()).toBe("run\nrun\nrun\n");
	} finally {
		await cleanup(root);
	}
}, 240_000);

test("native discovery refreshes installed package resolution before caching a new dependency edge", async () => {
	const root = await fixture();
	try {
		await Bun.write(path.join(root, "node_modules/fixture-edge/package.json"), '{"exports":"./index.js"}\n');
		await Bun.write(path.join(root, "node_modules/fixture-edge/index.js"), "export const value = 42;\n");
		await Bun.write(
			path.join(root, "packages/a/edge.test.ts"),
			'import { test, expect } from "bun:test"; import { value } from "fixture-edge"; test("installed edge", () => expect(value).toBe(42));\n',
		);
		await Bun.write(
			path.join(root, "packages/b/independent.test.ts"),
			'import { test, expect } from "bun:test"; test("independent input", () => expect(2 + 2).toBe(4));\n',
		);
		const command: GateCommand = {
			label: "test/fork packages/a/edge.test.ts",
			argv: [process.execPath, "test", "edge.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/a"),
		};
		const independent: GateCommand = {
			label: "test/fork packages/b/independent.test.ts",
			argv: [process.execPath, "test", "independent.test.ts", "--bail=1"],
			cwd: path.join(root, "packages/b"),
		};
		const commands = [command, independent];
		expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		// Neither this ignored file nor this edge existed in the first graph.
		// Watching only the first graph's installed inputs would miss the
		// dependency after the package entry point changes.
		await Bun.write(path.join(root, "node_modules/fixture-edge/late.js"), "export const value = 42;\n");
		await Bun.write(path.join(root, "node_modules/fixture-edge/index.js"), 'export { value } from "./late.js";\n');
		const expanded = await batch(root, commands, "fulltest");
		expect(expanded.exitCode).toBe(0);
		expect(expanded.targets.map(target => target.status)).toEqual(["new", "cached"]);
		await Bun.write(path.join(root, "node_modules/fixture-edge/late.js"), "export const value = 99;\n");
		expect((await batch(root, commands, "fulltest")).exitCode).not.toBe(0);
		// Failed batches intentionally return no target evidence. Check native
		// cache isolation in a successful batch after restoring the real input.
		await Bun.write(path.join(root, "node_modules/fixture-edge/late.js"), "export const value = 42;\n");
		const restored = await batch(root, commands, "fulltest");
		expect(restored.exitCode).toBe(0);
		expect(restored.targets.find(target => target.label === independent.label)?.status).toBe("cached");
	} finally {
		await cleanup(root);
	}
}, 120_000);

for (const scenario of [
	"optional",
	"extension",
	"index",
	"nested-installed",
	"resource-edit",
	"resource-create",
	"resource-directory",
	"structured-literal-argv",
	"module-require-installed",
	"module-alias-require-installed",
] as const) {
	test(`native cached consumers observe ignored resolution changes: ${scenario}`, async () => {
		const root = await fixture();
		try {
			await fs.appendFile(path.join(root, ".gitignore"), "*.b64.js\n*.tsx\n*.local-asset\nignored-resources/\n");
			const directory = path.join(root, "packages/a");
			let changed: string;
			let source: string;
			let restoredContents: string | undefined;
			if (scenario === "resource-edit" || scenario === "resource-create") {
				const relative = "value.local-asset";
				changed = path.join(directory, relative);
				if (scenario.endsWith("-edit")) await Bun.write(changed, "1\n");
				source = `import { existsSync, readFileSync } from "node:fs";
const resource = import.meta.dir + ${JSON.stringify(`/${relative}`)};
const value = existsSync(resource) ? Number(readFileSync(resource, "utf8")) : 1;`;
			} else if (scenario === "resource-directory") {
				await fs.mkdir(path.join(directory, "ignored-resources/nested"), { recursive: true });
				changed = path.join(directory, "ignored-resources/nested/value.local-asset");
				source = `import { readdirSync, readFileSync } from "node:fs";
const resource = new URL("./ignored-resources/", import.meta.url);
const names = readdirSync(resource, { recursive: true, withFileTypes: true });
const value = names.filter(entry => entry.isFile()).reduce((value, entry) => value + Number(readFileSync(entry.parentPath + "/" + entry.name, "utf8")), 1);`;
			} else if (scenario === "structured-literal-argv") {
				changed = path.join(directory, "worker.ts");
				restoredContents = "console.log(1);\n";
				await Bun.write(changed, restoredContents);
				source = `function command(plan: { argv: string[]; cwd: string }) { return { cmd: plan.argv, cwd: plan.cwd, stdout: "pipe" as const }; }
const child = Bun.spawn(command({ argv: ["bun", "./worker.ts"], cwd: import.meta.dir }));
const output = await new Response(child.stdout).text();
if (await child.exited) throw new Error("structured worker failed");
const value = Number(output.trim());`;
			} else if (scenario === "module-require-installed" || scenario === "module-alias-require-installed") {
				await Bun.write(path.join(root, "node_modules/fixture-loader/package.json"), '{"main":"index.cjs"}\n');
				await Bun.write(
					path.join(root, "node_modules/fixture-loader/index.cjs"),
					scenario === "module-require-installed"
						? "module.exports = module.require(process.env.FIXTURE_DEP);\n"
						: "const m = module; module.exports = m.require(process.env.FIXTURE_DEP);\n",
				);
				await Bun.write(path.join(root, "node_modules/fixture-leaf/package.json"), '{"main":"index.cjs"}\n');
				changed = path.join(root, "node_modules/fixture-leaf/index.cjs");
				restoredContents = "exports.value = 1;\n";
				await Bun.write(changed, restoredContents);
				source = 'const value = require("fixture-loader").value;';
			} else if (scenario === "extension") {
				await Bun.write(path.join(directory, "priority.ts"), "export const value = 1;\n");
				changed = path.join(directory, "priority.tsx");
				source = 'import { value } from "./priority";';
			} else if (scenario === "nested-installed") {
				await Bun.write(path.join(root, "node_modules/outer/package.json"), '{"main":"index.js"}\n');
				await Bun.write(path.join(root, "node_modules/outer/index.js"), 'module.exports = require("inner");\n');
				changed = path.join(root, "node_modules/outer/node_modules/inner/index.js");
				await Bun.write(changed, "exports.value = 1;\n");
				source =
					'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const value = load("outer").value;';
			} else {
				const specifier = scenario === "index" ? "./optional-directory" : "./optional.b64.js";
				if (scenario === "index") {
					await fs.mkdir(path.join(directory, "optional-directory"));
					await fs.appendFile(path.join(root, ".gitignore"), "optional-directory/\n");
				}
				changed = path.join(directory, scenario === "index" ? "optional-directory/index.js" : "optional.b64.js");
				source = `let value = 1; try { value = require(${JSON.stringify(specifier)}).value; } catch {}`;
			}
			await Bun.write(
				path.join(directory, "resolution.test.ts"),
				`import { test, expect } from "bun:test"; ${source}
function display(text: string) { return text.length; }
display("       ▓█   "); display("ordinary caption... "); display("   "); display("..."); display("invalid:caption? ");
test("resolution input", () => expect(value).toBe(1));\n`,
			);
			const command: GateCommand = {
				label: "test/fork packages/a/resolution.test.ts",
				argv: [process.execPath, "test", "resolution.test.ts", "--bail=1"],
				cwd: directory,
				...(scenario === "module-require-installed" || scenario === "module-alias-require-installed"
					? { env: { FIXTURE_DEP: "fixture-leaf" } }
					: {}),
			};
			await Bun.write(
				path.join(root, "packages/b/independent.test.ts"),
				'import { test, expect } from "bun:test"; test("independent consumer", () => expect(1).toBe(1));\n',
			);
			const independent: GateCommand = {
				label: "test/fork packages/b/independent.test.ts",
				argv: [process.execPath, "test", "independent.test.ts", "--bail=1"],
				cwd: path.join(root, "packages/b"),
			};
			const commands = [command, independent];
			expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
			const unchanged = await batch(root, commands, "fulltest");
			expect(unchanged.exitCode).toBe(0);
			expect(unchanged.targets.map(target => target.status)).toEqual(["cached", "cached"]);
			const changedContents = scenario.startsWith("resource-")
				? scenario === "resource-directory"
					? "1\n"
					: "2\n"
				: scenario === "extension"
					? "export const value = 2;\n"
					: scenario === "structured-literal-argv"
						? "console.log(2);\n"
						: "exports.value = 2;\n";
			await Bun.write(changed, changedContents);
			const invalidated = await batch(root, commands, "fulltest");
			expect(invalidated.exitCode).not.toBe(0);
			if (restoredContents !== undefined) await Bun.write(changed, restoredContents);
			else if (scenario === "nested-installed") await Bun.write(changed, "exports.value = 1;\n");
			else if (scenario === "resource-edit") await Bun.write(changed, "1\n");
			else await fs.unlink(changed);
			const restored = await batch(root, commands, "fulltest");
			expect(restored.exitCode).toBe(0);
			expect(restored.targets.find(target => target.label === independent.label)?.status).toBe("cached");
			expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
				"cached",
				"cached",
			]);
		} finally {
			await cleanup(root);
		}
	}, 240_000);
}

test("resource fast paths preserve anchored syntax, literal inputs and opaque loading", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-syntax");
	const filename = path.join(root, "packages/a/source.ts");
	const inventory = new Set(["packages/a/fixtures/value.json", "packages/a/worker.ts"]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	for (const anchor of [
		"import . meta . url",
		"import /* anchor */ . meta . url",
		"import // anchor\n . meta . url",
	]) {
		expect(scan(`readFile(new URL("./fixtures/value.json", ${anchor}));`).files).toEqual([
			"packages/a/fixtures/value.json",
		]);
		expect(scan(`new Worker(new URL("./worker.ts", ${anchor}));`).entries).toEqual(["packages/a/worker.ts"]);
		expect(scan(`readFile(new URL(runtimePath, ${anchor}));`).fallback).toBe(true);
	}
	for (const directory of ["__dirname", "__dir\\u006eame"]) {
		expect(scan(`readFile(${directory} + "/fixtures/value.json");`).files).toEqual([
			"packages/a/fixtures/value.json",
		]);
		expect(scan(`readFile(${directory} + runtimePath);`).fallback).toBe(true);
	}
	expect(scan('readFile("./fixtures/value.json");').files).toEqual(["packages/a/fixtures/value.json"]);
	expect(scan('Bun.spawn({cmd: ["bun", "./worker.ts"], cwd: "../b"});').repositoryFallback).toBe(true);
	expect(scan("const target = getTarget(); import(target);").fallback).toBe(true);
	expect(
		scan(
			'import { createRequire as loadFactory } from "node:module"; const load = loadFactory(import.meta.url); load(target);',
		).fallback,
	).toBe(true);
	expect(scan('export const data = { name: "pure data", values: [1, 2, 3] };')).toEqual({
		files: [],
		entries: [],
		fallback: false,
		repositoryFallback: false,
	});
});

test("resource contents and child output do not widen their declared path inputs", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-data");
	const filename = path.join(root, "packages/a/source.ts");
	const inventory = new Set(["packages/a/fixtures/value.json", "packages/a/worker.ts"]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	for (const source of [
		'const contents = await Bun.file(import.meta.dir + "/fixtures/value.json").text(); parse(contents);',
		'import { readFile as read } from "node:fs/promises"; const contents = await read(import.meta.dir + "/fixtures/value.json"); parse(contents);',
		'import * as fs from "node:fs"; const contents = fs.readFileSync(import.meta.dir + "/fixtures/value.json"); parse(contents);',
	]) {
		const result = scan(source);
		expect(result.files).toEqual(["packages/a/fixtures/value.json"]);
		expect(result.fallback).toBe(false);
	}
	for (const source of [
		'const child = Bun.spawn(["bun", import.meta.dir + "/worker.ts"], { cwd: import.meta.dir }); forward(child.stdout);',
		'import { spawn } from "node:child_process"; const child = spawn("bun", [import.meta.dir + "/worker.ts"], { cwd: import.meta.dir }); forward(child.stdout);',
	]) {
		const result = scan(source);
		expect(result.entries).toEqual(["packages/a/worker.ts"]);
		expect(result.fallback).toBe(false);
	}
	expect(
		scan("const contents = await Bun.file(import.meta.dir + runtimePath).text(); parse(contents);").fallback,
	).toBe(true);
	expect(scan("readFile(resolvePath(import.meta.dir, runtimePath));").fallback).toBe(true);
});

test("finite copy loops and structured subprocess plans retain their actual module inputs", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-plans");
	const filename = path.join(root, "packages/a/source.ts");
	const inventory = new Set([
		"packages/a/fixtures/one.json",
		"packages/a/fixtures/two.json",
		"packages/a/first.ts",
		"packages/a/second.ts",
	]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	const helper = 'function command(plan) { return { argv: ["bun", temporaryStub, JSON.stringify(plan)] }; }';
	const result = scan(`${helper}
		for (const name of ["one.json", "two.json"])
			copyFile(import.meta.dir + "/fixtures/" + name, temporaryTarget);
		function first() {
			const entry = import.meta.dir + "/first.ts";
			gate.run(command({ argv: ["bun", entry] }));
		}
		function second() {
			const entry = import.meta.dir + "/second.ts";
			Bun.spawn(["bun", temporaryStub, JSON.stringify({ runtime: entry })]);
		}`);
	expect(result.files).toEqual([...inventory].sort());
	expect(result.entries).toEqual(["packages/a/first.ts", "packages/a/second.ts"]);
	expect(result.fallback).toBe(false);
	expect(scan(`${helper} gate.run(command({ runtime: import.meta.dir + unknownPath }));`).fallback).toBe(true);
	expect(scan("for (const name of runtimeNames) copyFile(import.meta.dir + name, temporaryTarget);").fallback).toBe(
		true,
	);
	expect(
		scan(
			"function derive(base, name) { return { path: base + name }; } readFile(derive(import.meta.dir, unknownPath));",
		).fallback,
	).toBe(true);
	expect(scan('const report = {dir: import.meta.dir + "/runs/" + runId}; writeReport(report);').fallback).toBe(false);
});

test("Bun shell output remains data while static command inputs are retained", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-shell");
	const filename = path.join(root, "packages/a/source.ts");
	const inventory = new Set(["packages/a/worker.ts"]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	const result = scan(
		'import { $ } from "bun"; const child = await $`bun ./worker.ts`.cwd(import.meta.dir).quiet().nothrow(); forward(child.stdout);',
	);
	expect(result.files).toEqual(["packages/a/worker.ts"]);
	expect(result.entries).toEqual(["packages/a/worker.ts"]);
	expect(result.fallback).toBe(false);
	expect(scan('import { $ } from "bun"; $`bun ${runtimePath}`.cwd(import.meta.dir);').fallback).toBe(true);
	expect(scan('import { $ } from "bun"; $`bun "./worker.ts"`.cwd(import.meta.dir);').fallback).toBe(true);
	expect(scan('import { $ } from "bun"; $`bun ./worker.ts`.cwd("../b");').repositoryFallback).toBe(true);
});

test("known Node temporary shell cwd excludes runtime probes but retains source boundaries", () => {
	const root = path.join(path.parse(os.tmpdir()).root, "gate-resource-temporary-shell");
	const filename = path.join(root, "packages/a/source.ts");
	const worker = path.join(root, "packages/a/worker.ts").replaceAll("\\", "/");
	const inventory = new Set(["packages/a/worker.ts"]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	for (const [declaration, expression] of [
		['import * as operatingSystem from "node:os";', "operatingSystem.tmpdir()"],
		['import operatingSystem from "os";', "operatingSystem.tmpdir()"],
		['import { tmpdir as temporaryDirectory } from "node:os";', "temporaryDirectory()"],
	]) {
		const source = `import { $ } from "bun"; ${declaration}`;
		expect(scan(`${source} $\`bun --version\`.cwd(${expression});`)).toEqual({
			files: [],
			entries: [],
			fallback: false,
			repositoryFallback: false,
		});
		const absolute = scan(`${source} $\`bun ${worker}\`.cwd(${expression});`);
		expect(absolute.entries).toEqual(["packages/a/worker.ts"]);
		expect(absolute.repositoryFallback).toBe(false);
		for (const relative of ["./worker.ts", "../a/worker.ts"])
			expect(scan(`${source} $\`bun ${relative}\`.cwd(${expression});`).repositoryFallback).toBe(true);
	}
	expect(
		scan(`
import { $ } from "bun";
import * as os from "node:os";
function getBinaryName() {
 let os: string;
 os = "platform";
 return os;
}
async function npmSupportsReleaseAgeOverride() {
 return await $\`npm config get min-release-age\`.cwd(os.tmpdir()).quiet().nothrow();
}
`),
	).toEqual({ files: [], entries: [], fallback: false, repositoryFallback: false });
	for (const source of [
		'import { $ } from "bun"; $`bun --version`.cwd(runtimeDirectory());',
		'import { $ } from "bun"; const os = { tmpdir: runtimeDirectory }; $`bun --version`.cwd(os.tmpdir());',
		'import { $ } from "bun"; import os from "node:os"; function probe(os) { $`bun --version`.cwd(os.tmpdir()); }',
		'import { $ } from "bun"; import { tmpdir } from "node:os"; function probe(tmpdir) { $`bun --version`.cwd(tmpdir()); }',
	])
		expect(scan(source).repositoryFallback).toBe(true);
});

test("generated wrapper outputs do not hide undeclared cached inputs or actual compiler sources", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-outputs");
	const filename = path.join(root, "scripts/runtime.ts");
	const inventory = new Set(["scripts/compiler.rs", "node_modules/.cache/omp-gate-wrappers/prebuilt.exe"]);
	const scan = (text: string) => gateResources(filename, text, inventory, root);
	const result = scan(`
		import * as path from "node:path";
		import { randomUUID } from "node:crypto";
		const directory = path.resolve(import.meta.dir, "../node_modules/.cache/omp-gate-wrappers", \`\${process.platform}-\${process.arch}\`);
		mkdirSync(directory);
		const temporary = path.join(directory, \`launcher-\${randomUUID()}.exe\`);
		const image = path.join(directory, "compiler.exe");
		const source = path.join(import.meta.dir, "compiler.rs");
		Bun.spawn(["rustc", source, "-o", temporary]);
		renameSync(temporary, image);
		readFileSync(image);
		readFileSync(path.resolve(import.meta.dir, "../node_modules/.cache/omp-gate-wrappers/prebuilt.exe"));
	`);
	expect(result.files).toEqual(["node_modules/.cache/omp-gate-wrappers/prebuilt.exe", "scripts/compiler.rs"]);
	expect(result.fallback).toBe(false);
	expect(
		scan(`
		import * as path from "node:path";
		const directory = path.resolve(import.meta.dir, "../node_modules/.cache/omp-gate-wrappers");
		const output = path.join(directory, runtimeName);
		writeFileSync(output, "");
		readFileSync(output);
	`).fallback,
	).toBe(true);
	expect(scan("const repo = { require(cwd) {} }; repo.require(runtimeCwd);").fallback).toBe(false);
	expect(scan("require(runtimeModule);").fallback).toBe(true);
});

test("quoted command plans retain source tools while worker and timer handles remain data", () => {
	const root = path.resolve(os.tmpdir(), "gate-resource-command-format");
	const filename = path.join(root, "scripts/runtime.ts");
	const scan = (text: string) => gateResources(filename, text, new Set(["scripts/compiler.ts"]), root);
	const result = scan(`
		import * as path from "node:path";
		const wrapper = [process.execPath, path.join(import.meta.dir, "compiler.ts"), "--go"]
			.map(arg => {
				if (arg.includes("'") && arg.includes('"')) throw new Error("cannot quote");
				return arg.includes("'") ? \`"\${arg}"\` : \`'\${arg}'\`;
			}).join(" ");
		Bun.spawn(["go", "test", \`-toolexec=\${wrapper}\`]);
		const worker = new Worker(new URL("./compiler.ts", import.meta.url));
		forward(worker);
		const timer = setInterval(() => readFile(import.meta.dir + unknownPath), 1000);
		clearInterval(timer);
	`);
	expect(result.entries).toEqual(["scripts/compiler.ts"]);
	// The genuinely opaque read in the callback is scanned independently.
	expect(result.fallback).toBe(true);
	expect(
		scan(`
		const worker = new Worker(new URL("./compiler.ts", import.meta.url)); forward(worker);
		const timer = setInterval(() => import.meta.dir, 1000); clearInterval(timer);
	`).fallback,
	).toBe(false);
	const formatted = scan(`
		import * as path from "node:path";
		const wrapper = [process.execPath, path.join(import.meta.dir, "compiler.ts")]
			.map(arg => \`"\${arg}"\`).join(" ");
		Bun.spawn(["go", \`-toolexec=\${wrapper}\`]);
	`);
	expect(formatted.entries).toEqual(["scripts/compiler.ts"]);
	expect(formatted.fallback).toBe(false);
});

test.skipIf(process.platform !== "win32")(
	"resource watches canonicalize Win32 aliases before native discovery",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resource-alias-"));
		try {
			const directory = path.join(root, "packages/a");
			await fs.mkdir(path.join(directory, "ignored-resources"), { recursive: true });
			await fs.writeFile(path.join(directory, "ignored-resources/value.local-asset"), "1");
			const watched: string[] = [];
			const resources = gateResources(
				path.join(directory, "index.ts"),
				`readFile(import.meta.dir + "/ignored-resources. /value.local-asset. ");
readFile(import.meta.dir + "/ignored-resources. /absent.local-asset. ");
readFile(import.meta.dir + "/../../../outside.local-asset. ");
display("       ▓█   "); display("ordinary caption... "); display("   "); display("...");
display("invalid:caption? ");`,
				new Set<string>(),
				root,
				absolute => watched.push(absolute),
			);
			expect(resources.files).toEqual(["packages/a/ignored-resources/value.local-asset"]);
			expect(resources.fallback).toBe(false);
			expect(watched).toContain(path.join(directory, "ignored-resources/value.local-asset"));
			expect(watched).toContain(path.join(directory, "ignored-resources/absent.local-asset"));
			expect(watched).toContain(path.join(directory, "       ▓█"));
			for (const absolute of watched) {
				const relative = path.relative(root, absolute);
				expect(relative.startsWith("..")).toBe(false);
				expect(relative).not.toMatch(/[<>:"|?*\x00-\x1f]/);
				expect(relative.split(path.sep).some(component => /[. ]$/.test(component))).toBe(false);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

test("resource enumeration stats local and installed assets outside inventory", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resource-stat-"));
	try {
		for (const relative of ["packages/a", "node_modules/resource-fixture"]) {
			const directory = path.join(root, relative);
			await fs.mkdir(path.join(directory, "resources/empty"), { recursive: true });
			await fs.writeFile(path.join(directory, "asset.json"), "{}");
			await fs.writeFile(path.join(directory, "resources/.hidden"), "asset");
			const resource = gateResources(
				path.join(directory, "index.js"),
				'readFile("./asset.json"); readFile("./asset.json"); readdirSync("./resources"); inspect("not-an-input"); inspect("\\0");',
				new Set<string>(),
				root,
			);
			expect(resource.files).toEqual([`${relative}/asset.json`, `${relative}/resources/.hidden`]);
			expect(resource.fallback).toBe(false);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("package script subprocess consumers track recursive manifests and CLI entries without widening unrelated targets", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		const runs = path.join(root, ".state/script-consumer.runs");
		const independentRuns = path.join(root, ".state/script-independent.runs");
		await Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({
				scripts: { dev: "bun --cwd=packages/dependency run inner", test: "bun packages/dependency/script-test.ts" },
			}),
		);
		await Bun.write(
			path.join(root, "packages/dependency/package.json"),
			JSON.stringify({
				name: "@fixture/dependency",
				scripts: { inner: "bun cli.ts" },
			}),
		);
		await Bun.write(
			path.join(root, "packages/dependency/cli.ts"),
			'import { value } from "./value"; console.log(value);\n',
		);
		await Bun.write(path.join(root, "packages/dependency/value.ts"), 'export const value = "42";\n');
		await Bun.write(path.join(root, "packages/dependency/script-test.ts"), 'console.log("script test");\n');
		await Bun.write(
			path.join(root, "packages/b/builtin.test.ts"),
			'import { test, expect } from "bun:test"; test("nested builtin", () => expect(6 * 7).toBe(42));\n',
		);
		await Bun.write(
			path.join(root, "packages/a/script.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
test("package script", async () => {
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
 const child = Bun.spawn({cmd:[process.execPath, "run", "dev"], cwd:path.resolve(import.meta.dir, "../.."), stdout:"pipe", stderr:"inherit"});
 expect((await new Response(child.stdout).text()).trim()).toBe("42");
 expect(await child.exited).toBe(0);
 const script = Bun.spawn({cmd:[process.execPath, "run", "test"], cwd:path.resolve(import.meta.dir, "../.."), stdout:"pipe", stderr:"inherit"});
 expect((await new Response(script.stdout).text()).trim()).toBe("script test");
 expect(await script.exited).toBe(0);
});
`,
		);
		await Bun.write(
			path.join(root, "packages/b/script-independent.test.ts"),
			`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
test("independent builtin test", async () => {
 const child = Bun.spawn({cmd:[process.execPath, "test", path.resolve(import.meta.dir, "builtin.test.ts")], cwd:path.resolve(import.meta.dir, "../.."), stdout:"pipe", stderr:"pipe"});
 expect(await child.exited).toBe(0);
 mkdirSync(${JSON.stringify(path.dirname(independentRuns))}, {recursive:true});
 appendFileSync(${JSON.stringify(independentRuns)}, "run\\n");
});
`,
		);
		const commands: GateCommand[] = [
			{
				label: "test/fork packages/a/script.test.ts",
				argv: [process.execPath, "test", "script.test.ts"],
				cwd: path.join(root, "packages/a"),
			},
			{
				label: "test/fork packages/b/script-independent.test.ts",
				argv: [process.execPath, "test", "script-independent.test.ts"],
				cwd: path.join(root, "packages/b"),
			},
		];
		expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		await Bun.write(path.join(root, "packages/dependency/value.ts"), 'export const value = "4" + "2";\n');
		const changed = await batch(root, commands, "fulltest");
		expect(changed.exitCode).toBe(0);
		expect(changed.targets[0]?.status).not.toBe("cached");
		expect(changed.targets[1]?.status).toBe("cached");
		expect(await Bun.file(runs).text()).toBe("run\nrun\n");
		await Bun.write(
			path.join(root, "packages/dependency/cli.ts"),
			'import { value } from "./value"; console.log(String(value));\n',
		);
		const cliChanged = await batch(root, commands, "fulltest");
		expect(cliChanged.exitCode).toBe(0);
		expect(cliChanged.targets[0]?.status).not.toBe("cached");
		expect(cliChanged.targets[1]?.status).toBe("cached");
		await Bun.write(
			path.join(root, "packages/dependency/package.json"),
			JSON.stringify({
				name: "@fixture/dependency",
				scripts: { inner: "bun ./cli.ts" },
			}),
		);
		const scriptChanged = await batch(root, commands, "fulltest");
		expect(scriptChanged.exitCode).toBe(0);
		expect(scriptChanged.targets[0]?.status).not.toBe("cached");
		expect(scriptChanged.targets[1]?.status).toBe("cached");
		expect(await Bun.file(runs).text()).toBe("run\nrun\nrun\nrun\n");
		await Bun.write(path.join(root, "packages/dependency/script-test.ts"), 'console.log("script " + "test");\n');
		const explicitTestChanged = await batch(root, commands, "fulltest");
		expect(explicitTestChanged.exitCode).toBe(0);
		expect(explicitTestChanged.targets.map(target => target.status)).toEqual(["new", "cached"]);
		expect(await Bun.file(runs).text()).toBe("run\nrun\nrun\nrun\nrun\n");
		expect(await Bun.file(independentRuns).text()).toBe("run\n");
		await Bun.write(
			path.join(root, "packages/b/builtin.test.ts"),
			'import { test, expect } from "bun:test"; test("nested builtin", () => expect(40 + 2).toBe(42));\n',
		);
		const builtinTestChanged = await batch(root, commands, "fulltest");
		expect(builtinTestChanged.exitCode).toBe(0);
		expect(builtinTestChanged.targets.map(target => target.status)).toEqual(["cached", "new"]);
		expect(await Bun.file(runs).text()).toBe("run\nrun\nrun\nrun\nrun\n");
		expect(await Bun.file(independentRuns).text()).toBe("run\nrun\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);

test("script discovery and temporary fixture proofs fail closed for dynamic paths and mixed require calls", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resource-precision-"));
	try {
		const dir = path.join(root, "packages/a");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({
				scripts: {
					dev: "bun --cwd=packages/a run inner",
					predev: "bun packages/a/pre.ts",
					postdev: "bun packages/a/post.ts",
					cycle: "bun run cycle",
					test: "bun packages/a/pre.ts",
					build: "bun packages/a/post.ts",
					builtinBuild: "bun build packages/a/cli.ts",
					dynamic: "bun $ENTRY",
				},
			}),
		);
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { inner: "bun cli.ts" } }));
		for (const file of ["cli.ts", "pre.ts", "post.ts", "local.js"])
			await Bun.write(path.join(dir, file), "export {};\n");
		await Bun.write(path.join(dir, "launcher.rs"), "fn main() {}\n");
		const filename = path.join(dir, "source.ts");
		const scan = (text: string) => gateResources(filename, text, new Set<string>(), root);
		for (const spawn of [
			'Bun.spawn([process.execPath, "run", "dev"], {cwd: root});',
			'Bun.spawn({cmd: [process.execPath, "run", "dev"], cwd: root});',
		]) {
			const result = scan(
				`import path from "node:path"; const root = path.resolve(import.meta.dir, "../.."); ${spawn}`,
			);
			expect(result.entries).toEqual(["packages/a/cli.ts", "packages/a/post.ts", "packages/a/pre.ts"]);
			expect(result.files).toContain("package.json");
			expect(result.files).toContain("packages/a/package.json");
			expect(result.repositoryFallback).toBe(false);
		}
		const shell = scan(
			'import { $ } from "bun"; import path from "node:path"; $`bun run dev`.cwd(path.resolve(import.meta.dir, "../.."));',
		);
		expect(shell.entries).toEqual(["packages/a/cli.ts", "packages/a/post.ts", "packages/a/pre.ts"]);
		expect(shell.repositoryFallback).toBe(false);
		const childProcess = scan(
			'import { spawn } from "node:child_process"; import path from "node:path"; spawn("bun", ["run", "dev"], {cwd:path.resolve(import.meta.dir, "../..")});',
		);
		expect(childProcess.entries).toEqual(["packages/a/cli.ts", "packages/a/post.ts", "packages/a/pre.ts"]);
		expect(childProcess.repositoryFallback).toBe(false);
		for (const command of ["test", "build"]) {
			const sourceBuiltin = scan(
				`Bun.spawn(["bun", "${command}", "packages/a/cli.ts"], {cwd: ${JSON.stringify(root)}});`,
			);
			expect(sourceBuiltin.repositoryFallback).toBe(false);
			expect(sourceBuiltin.entries).toContain("packages/a/cli.ts");
			expect(sourceBuiltin.entries).not.toContain(command === "test" ? "packages/a/pre.ts" : "packages/a/post.ts");
			const shellBuiltin = scan(
				`import { $ } from "bun"; $\`bun ${command} packages/a/cli.ts\`.cwd(${JSON.stringify(root)});`,
			);
			expect(shellBuiltin.repositoryFallback).toBe(false);
			expect(shellBuiltin.entries).toContain("packages/a/cli.ts");
			expect(shellBuiltin.entries).not.toContain(command === "test" ? "packages/a/pre.ts" : "packages/a/post.ts");
			const explicit = scan(`Bun.spawn(["bun", "run", "${command}"], {cwd: ${JSON.stringify(root)}});`);
			expect(explicit.repositoryFallback).toBe(false);
			expect(explicit.entries).toContain(command === "test" ? "packages/a/pre.ts" : "packages/a/post.ts");
		}
		const nestedBuiltin = scan(`Bun.spawn(["bun", "run", "builtinBuild"], {cwd: ${JSON.stringify(root)}});`);
		expect(nestedBuiltin.repositoryFallback).toBe(false);
		expect(nestedBuiltin.entries).toContain("packages/a/cli.ts");
		expect(nestedBuiltin.entries).not.toContain("packages/a/post.ts");
		const nodeBuiltin = scan(`Bun.spawn(["node", "--test", "packages/a/cli.ts"], {cwd: ${JSON.stringify(root)}});`);
		expect(nodeBuiltin.repositoryFallback).toBe(false);
		expect(nodeBuiltin.entries).toContain("packages/a/cli.ts");
		expect(nodeBuiltin.entries).not.toContain("packages/a/pre.ts");
		const nodeRun = scan(`Bun.spawn(["node", "--run", "test"], {cwd: ${JSON.stringify(root)}});`);
		expect(nodeRun.repositoryFallback).toBe(false);
		expect(nodeRun.entries).toContain("packages/a/pre.ts");
		for (const source of [
			'const python = process.platform === "win32" ? "python" : "python3"; Bun.spawnSync([python, "-c", verifier, run.dir]);',
			'const compiler = env.RUSTC || "rustc"; Bun.spawn([compiler, "--version"]);',
			'Bun.spawn(["bun", ...args], {cwd: process.cwd()});',
			"Bun.spawn([process.execPath, process.env.INDIRECT_SOURCE], {cwd: process.cwd()});",
			'Bun.spawn(["git", "--version"], {cwd: "../runtime"});',
		]) {
			const result = scan(source);
			expect(result.fallback).toBe(false);
			expect(result.repositoryFallback).toBe(false);
		}
		const compiler = scan(
			'import path from "node:path"; const compiler = env.RUSTC || "rustc"; const source = path.join(import.meta.dir, "launcher.rs"); Bun.spawn([compiler, "--edition=2021", "-o", temporary, source]);',
		);
		expect(compiler.repositoryFallback).toBe(false);
		expect(compiler.files).toContain("packages/a/launcher.rs");
		expect(scan('Bun.spawn(["bun", "test", "./cli.ts"], {cwd: "../unknown"});').repositoryFallback).toBe(true);
		expect(scan('Bun.spawn([unknownCommand, "./cli.ts"], {cwd: "../unknown"});').repositoryFallback).toBe(true);
		expect(scan('Bun.spawn(["bun", "run", script], {cwd: import.meta.dir});').repositoryFallback).toBe(true);
		for (const script of ["cycle", "dynamic", "missing"])
			expect(
				scan(`Bun.spawn(["bun", "run", "${script}"], {cwd: ${JSON.stringify(root)}});`).repositoryFallback,
			).toBe(true);
		expect(scan('Bun.spawn(["bun", "run", script], {cwd: "../unknown"});').repositoryFallback).toBe(true);
		const imports =
			'import { $ } from "bun"; import os from "node:os"; import path from "node:path"; import { mkdtempSync } from "node:fs";';
		const helper =
			'function fixture() { const temp = mkdtempSync(path.join(os.tmpdir(), "fixture-")); const root = path.join(temp, "project"); return {temp, root}; }';
		expect(
			scan(`${imports} ${helper} const {root} = fixture(); const alias = root; $\`git add entry.py\`.cwd(alias);`)
				.repositoryFallback,
		).toBe(false);
		expect(
			scan(`${imports} ${helper} const {root} = fixture(); $\`bun ./worker.ts\`.cwd(root);`).repositoryFallback,
		).toBe(true);
		expect(
			scan(
				`${imports} function fixture() { return {root: path.join(os.tmpdir(), "..", "outside")}; } const {root} = fixture(); $\`bun --version\`.cwd(root);`,
			).repositoryFallback,
		).toBe(true);
		expect(
			scan(
				`${imports} function fixture(flag) { if (flag) return {root: os.tmpdir()}; return {root: process.cwd()}; } const {root} = fixture(true); $\`bun --version\`.cwd(root);`,
			).repositoryFallback,
		).toBe(true);
		expect(
			scan(`${imports} ${helper} let {root} = fixture(); root = other; $\`bun --version\`.cwd(root);`)
				.repositoryFallback,
		).toBe(true);
		expect(
			scan(`${imports} function probe(os) { const root = os.tmpdir(); $\`bun --version\`.cwd(root); }`)
				.repositoryFallback,
		).toBe(true);
		expect(
			scan(`${imports} ${helper} const {root} = fixture(); Bun.spawn(["bun", "./worker.ts"], {cwd: root});`)
				.repositoryFallback,
		).toBe(true);
		expect(scan('Bun.spawn([unknownCommand, "run", "dev"], {cwd: import.meta.dir});').repositoryFallback).toBe(true);
		expect(
			scan(`${imports} ${helper} const {root} = fixture(); $\`bun \${unknownModule}\`.cwd(root);`).fallback,
		).toBe(true);
		const loader =
			'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const alias = load;';
		expect(scan(`${loader} alias("bun:ffi"); alias("node:fs");`).fallback).toBe(false);
		expect(scan(`${loader} alias("bun:ffi"); alias(dynamicName);`).fallback).toBe(true);
		expect(scan(`${loader} alias("node:not-a-builtin");`).fallback).toBe(true);
		expect(scan(`${loader} function shadow(alias) { alias("bun:ffi"); } alias(dynamicName);`).fallback).toBe(true);
		const local = scan(`${loader} alias("./local.js");`);
		expect(local.entries).toContain("packages/a/local.js");
		expect(local.fallback).toBe(false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"Dev TUI native tool changes invalidate only its consumer and a missing tool fails explicitly",
	async () => {
		const root = await fixture();
		try {
			await copyReporter(root);
			const toolDir = path.join(root, ".state/tui-bin");
			await fs.mkdir(toolDir, { recursive: true });
			const tool = path.join(toolDir, "tui-test.exe");
			await fs.copyFile(process.execPath, tool);
			const runs = path.join(root, ".state/tui-consumer.runs");
			const otherRuns = path.join(root, ".state/tui-independent.runs");
			await Bun.write(path.join(root, "packages/coding-agent/package.json"), '{"name":"fixture-coding-agent"}');
			await Bun.write(
				path.join(root, "packages/coding-agent/test/spec-driven/tui.e2e.test.ts"),
				`import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("native tool", async () => {
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
 const child = Bun.spawn(["tui-test", "--version"], {env:process.env, stdout:"pipe", stderr:"inherit"});
 expect((await new Response(child.stdout).text()).trim()).toBe(Bun.version);
 expect(await child.exited).toBe(0);
});
`,
			);
			await Bun.write(
				path.join(root, "packages/b/tui-independent.test.ts"),
				`import { test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("independent", () => {
 mkdirSync(${JSON.stringify(path.dirname(otherRuns))}, {recursive:true});
 appendFileSync(${JSON.stringify(otherRuns)}, "run\\n");
});
`,
			);
			const label = "test/fork packages/coding-agent/test/spec-driven/tui.e2e.test.ts";
			const command: GateCommand = {
				label,
				argv: [process.execPath, "test", "test/spec-driven/tui.e2e.test.ts"],
				cwd: path.join(root, "packages/coding-agent"),
				env: { PATH: `${toolDir};${process.env.PATH ?? process.env.Path ?? ""}` },
			};
			const independent: GateCommand = {
				label: "test/fork packages/b/tui-independent.test.ts",
				argv: [process.execPath, "test", "tui-independent.test.ts"],
				cwd: path.join(root, "packages/b"),
			};
			const commands = [command, independent];
			expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
			expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
				"cached",
				"cached",
			]);
			await fs.appendFile(tool, Buffer.from([0]));
			const changed = await batch(root, commands, "fulltest");
			expect(changed.exitCode).toBe(0);
			expect(changed.targets[0]?.status).not.toBe("cached");
			expect(changed.targets[1]?.status).toBe("cached");
			expect(await Bun.file(runs).text()).toBe("run\nrun\n");
			expect(await Bun.file(otherRuns).text()).toBe("run\n");
			let missing: unknown;
			const result = await runGate("fulltest", async gate => {
				try {
					await runBazelCommands(gate, [{ ...command, env: { PATH: "" } }], {
						root,
						concurrency: 2,
						serverIdleSeconds: fixtureServerIdleSeconds,
					});
				} catch (error) {
					missing = error;
					throw error;
				}
			});
			expect(result.exitCode).not.toBe(0);
			expect(missing).toBeInstanceOf(GateCommandError);
			expect(missing).toMatchObject({
				message: `tui-test is required for ${label}`,
				status: "MISSING_TOOL",
				exitCode: 127,
			});
			expect((await batch(root, [independent], "fulltest")).targets[0]?.status).toBe("cached");
		} finally {
			await cleanup(root);
		}
	},
	120_000,
);

test("builtin-only require consumers stay cached while a mixed dynamic loader retains its package boundary", async () => {
	const root = await fixture();
	try {
		await copyReporter(root);
		for (const [pkg, dynamic] of [
			["a", false],
			["b", true],
		] as const) {
			const runs = path.join(root, `.state/require-${pkg}.runs`);
			await Bun.write(
				path.join(root, `packages/${pkg}/require.test.ts`),
				`import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
const load = createRequire(import.meta.url);
const alias = load;
test("loader boundary", () => {
 mkdirSync(${JSON.stringify(path.dirname(runs))}, {recursive:true});
 appendFileSync(${JSON.stringify(runs)}, "run\\n");
 const {read, ptr} = alias("bun:ffi");
 const bytes = Uint8Array.of(42);
 expect(read.u8(ptr(bytes))).toBe(42);
 ${dynamic ? 'const name = process.env.FIXTURE_MODULE ?? "node:fs"; expect(JSON.parse(alias(name).readFileSync(new URL("./payload.json", import.meta.url), "utf8")).value).toBe(42);' : ""}
});
`,
			);
			await Bun.write(path.join(root, `packages/${pkg}/unrelated.ts`), "export const unrelated = 1;\n");
			if (dynamic) await Bun.write(path.join(root, `packages/${pkg}/payload.json`), JSON.stringify({ value: 42 }));
		}
		const commands: GateCommand[] = ["a", "b"].map(pkg => ({
			label: `test/fork packages/${pkg}/require.test.ts`,
			argv: [process.execPath, "test", "require.test.ts"],
			cwd: path.join(root, `packages/${pkg}`),
		}));
		expect((await batch(root, commands, "fulltest")).exitCode).toBe(0);
		expect((await batch(root, commands, "fulltest")).targets.map(target => target.status)).toEqual([
			"cached",
			"cached",
		]);
		for (const pkg of ["a", "b"])
			await Bun.write(path.join(root, `packages/${pkg}/unrelated.ts`), "export const unrelated = 2;\n");
		const changed = await batch(root, commands, "fulltest");
		expect(changed.exitCode).toBe(0);
		expect(changed.targets[0]?.status).toBe("cached");
		expect(changed.targets[1]?.status).not.toBe("cached");
		expect(await Bun.file(path.join(root, ".state/require-a.runs")).text()).toBe("run\n");
		expect(await Bun.file(path.join(root, ".state/require-b.runs")).text()).toBe("run\nrun\n");
	} finally {
		await cleanup(root);
	}
}, 120_000);
