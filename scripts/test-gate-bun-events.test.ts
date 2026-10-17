import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { BunTestFailureObserver } from "./test-gate-failure-events";
import type { GateCommandError } from "./test-gate-runtime";

it("notifies on the first complete Bun case marker without waiting for stream end", () => {
	const failures: GateCommandError[] = [];
	const observer = new BunTestFailureObserver(error => failures.push(error));
	const bytes = new TextEncoder().encode("\x1b[31m(fail) suite > first_测试 [1.25ms]\x1b[0m\r\n");
	for (const byte of bytes) observer.push(new Uint8Array([byte]));
	expect(failures).toHaveLength(1);
	expect(failures[0].message).toBe("Bun test failed: suite > first_测试");
	expect(failures[0].exitCode).toBe(1);
	observer.push(new TextEncoder().encode("(fail) second [2.00ms]\n"));
	observer.end();
	expect(failures).toHaveLength(1);
});

it("does not mistake error diagnostics, passing cases, totals or quoted markers for case failures", () => {
	const failures: GateCommandError[] = [];
	const observer = new BunTestFailureObserver(error => failures.push(error));
	observer.push(
		new TextEncoder().encode(
			[
				"error: this is expected test output",
				"(pass) catches error [0.25ms]",
				"1 fail",
				"(fail) example without a runner duration",
				"  (fail) indented example [1.00ms]",
				'"(fail) quoted example [1.00ms]"',
				"prefix (fail) embedded example [1.00ms]",
			].join("\n"),
		),
	);
	observer.end();
	expect(failures).toEqual([]);
});

it("the Bun reporter emits a dedicated failure event while afterAll is still running", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-first-failure-"));
	const eventFile = path.join(directory, "events");
	const fixture = path.join(directory, "first-failure.test.ts");
	await fs.writeFile(
		fixture,
		`import { afterAll, expect, it } from "bun:test";
afterAll(async () => {
	process.stderr.write("OMP_FIXTURE_TEARDOWN_READY\\n");
	await new Response(Bun.stdin).text();
});
it("visible first failure", () => expect(1).toBe(2));
`,
	);
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-report-bun.ts"), fixture], {
		cwd: directory,
		env: {
			...process.env,
			OMP_GATE_EVENT_TOKEN: "bun-first-failure-fixture",
			OMP_GATE_EVENT_FILE: eventFile,
			OMP_TEST_REPORT_DIR: path.join(directory, "reports"),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const teardown = Promise.withResolvers<void>();
	const stderrOutput = (async () => {
		const decoder = new TextDecoder();
		let text = "";
		for await (const bytes of child.stderr) {
			text += decoder.decode(bytes, { stream: true });
			if (text.includes("OMP_FIXTURE_TEARDOWN_READY")) teardown.resolve();
		}
		return text + decoder.decode();
	})();
	const output = Promise.all([new Response(child.stdout).text(), stderrOutput]);
	try {
		await Promise.race([
			teardown.promise,
			child.exited.then(code => {
				throw new Error(`Bun reporter exited ${code} before its teardown barrier`);
			}),
		]);
		const event = await fs.readFile(eventFile, "utf8");
		expect(event).toContain("OMP_GATE_EVENT bun-first-failure-fixture ");
		expect(event).toContain('"kind":"failure"');
		expect(event).toContain("visible first failure");
		expect(child.exitCode).toBeNull();
		child.stdin.end();
		expect(await child.exited).toBe(1);
		const [, stderr] = await output;
		expect(stderr).toContain("(fail) visible first failure");
	} finally {
		if (child.exitCode === null) {
			child.stdin.end();
			child.kill();
		}
		await child.exited;
		await output;
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 15_000);

it("the sequential TS runner reports a failing case before its afterAll barrier exits", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sequential-first-failure-"));
	const eventFile = path.join(directory, "events");
	const release = path.join(directory, "release");
	const fixture = path.join(directory, "sequential-failure.test.ts");
	await fs.writeFile(
		fixture,
		`import { afterAll, expect, it } from "bun:test";
import { existsSync, watch } from "node:fs";
afterAll(async () => {
	const released = Promise.withResolvers();
	const watcher = watch(${JSON.stringify(directory)}, () => {
		if (existsSync(${JSON.stringify(release)})) released.resolve();
	});
	// Windows directory watchers alone may not keep Bun's subprocess alive.
	// This handle holds the barrier; its timer never determines test success.
	const keepAlive = setInterval(() => {}, 60_000);
	process.stderr.write("OMP_SEQUENTIAL_TEARDOWN_READY\\n");
	try {
		if (!existsSync(${JSON.stringify(release)})) await released.promise;
	} finally {
		clearInterval(keepAlive);
		watcher.close();
	}
}, 60_000);
it("sequential first_测试 failure", () => expect(1).toBe(2));
`,
	);
	const source = `
import { runTestCommand } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "ci-test-ts.ts")).href)};
try {
  await runTestCommand({
    label: "sequential fixture",
    cwd: ${JSON.stringify(path.relative(path.join(import.meta.dir, ".."), directory))},
    command: ${JSON.stringify([process.execPath, "test", fixture])},
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;
	const child = Bun.spawn([process.execPath, "--eval", source], {
		env: {
			...process.env,
			OMP_GATE_EVENT_TOKEN: "sequential-first-failure",
			OMP_GATE_EVENT_FILE: eventFile,
			OMP_TEST_REPORT_DIR: path.join(directory, "reports"),
			OMP_TEST_CHUNK_TIMEOUT: "60",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const teardown = Promise.withResolvers<void>();
	const stderrOutput = (async () => {
		const decoder = new TextDecoder();
		let text = "";
		for await (const bytes of child.stderr) {
			text += decoder.decode(bytes, { stream: true });
			if (text.includes("OMP_SEQUENTIAL_TEARDOWN_READY")) teardown.resolve();
		}
		return text + decoder.decode();
	})();
	const output = Promise.all([new Response(child.stdout).text(), stderrOutput]);
	try {
		await Promise.race([
			teardown.promise,
			child.exited.then(async code => {
				const [, stderr] = await output;
				throw new Error(`Sequential runner exited ${code} before its teardown barrier:\n${stderr}`);
			}),
		]);
		const event = await fs.readFile(eventFile, "utf8");
		expect(event).toContain("OMP_GATE_EVENT sequential-first-failure ");
		expect(event).toContain('"kind":"failure"');
		expect(event).toContain("sequential first_测试 failure");
		expect(child.exitCode).toBeNull();
		await fs.writeFile(release, "release");
		expect(await child.exited).toBe(1);
		const [, stderr] = await output;
		expect(stderr).toContain("(fail) sequential first_测试 failure");
	} finally {
		await fs.writeFile(release, "release");
		if (child.exitCode === null) child.kill();
		await child.exited;
		await output;
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 15_000);

it.each(["rejection", "exception"])(
	"notifies on an unhandled %s before standalone fatal cleanup completes",
	async kind => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unhandled-first-failure-"));
		const eventFile = path.join(directory, "events");
		const source = `
import { postmortem } from "@oh-my-pi/pi-utils";
import { observeGateUnhandledFailures } from ${JSON.stringify(path.join(import.meta.dir, "test-gate-failure-events.ts"))};
observeGateUnhandledFailures();
postmortem.register("fixture-cleanup-barrier", async () => {
	process.stdout.write("OMP_FIXTURE_CLEANUP_READY\\n");
	await new Response(Bun.stdin).text();
});
${kind === "rejection" ? 'Promise.reject(new Error("fixture unhandled rejection"));' : 'queueMicrotask(() => { throw new Error("fixture uncaught exception"); });'}
`;
		const child = Bun.spawn([process.execPath, "--eval", source], {
			cwd: path.join(import.meta.dir, ".."),
			env: { ...process.env, OMP_GATE_EVENT_TOKEN: "fatal-fixture", OMP_GATE_EVENT_FILE: eventFile },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const cleanup = Promise.withResolvers<void>();
		const stdoutOutput = (async () => {
			const decoder = new TextDecoder();
			let text = "";
			for await (const bytes of child.stdout) {
				text += decoder.decode(bytes, { stream: true });
				if (text.includes("OMP_FIXTURE_CLEANUP_READY")) cleanup.resolve();
			}
			return text + decoder.decode();
		})();
		const output = Promise.all([stdoutOutput, new Response(child.stderr).text()]);
		try {
			await Promise.race([
				cleanup.promise,
				child.exited.then(code => {
					throw new Error(`Fatal fixture exited ${code} before its cleanup barrier`);
				}),
			]);
			const event = await fs.readFile(eventFile, "utf8");
			expect(event).toContain("OMP_GATE_EVENT fatal-fixture ");
			expect(event).toContain('"kind":"failure"');
			expect(event).toContain(kind === "rejection" ? "fixture unhandled rejection" : "fixture uncaught exception");
			expect(child.exitCode).toBeNull();
			child.stdin.end();
			expect(await child.exited).toBe(1);
			await output;
		} finally {
			if (child.exitCode === null) {
				child.stdin.end();
				child.kill();
			}
			await child.exited;
			await output;
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	15_000,
);
