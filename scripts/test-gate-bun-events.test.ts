import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
