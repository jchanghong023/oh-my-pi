// Real process/DLL lifetime boundaries require real timers (ts-no-test-timers exception).
import { describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

const packageRoot = path.resolve(import.meta.dir, "../..");
const nativeDir = path.resolve(packageRoot, "../natives/native");

async function createHost(root: string): Promise<string> {
	const filenames = await fs.readdir(nativeDir);
	const filename = filenames.find(
		name => name.startsWith(`pi_natives.${process.platform}-${process.arch}`) && name.endsWith(".node"),
	);
	if (!filename)
		throw new Error(`Build the current-platform native addon before running this regression: ${nativeDir}`);
	const image = await fs.readFile(path.join(nativeDir, filename));
	const compressed = path.join(root, "image.zst");
	await fs.writeFile(compressed, Bun.zstdCompressSync(image));
	const host = path.join(root, "native-host.ts");
	const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.resolve(packageRoot, relative)).href);
	await fs.mkdir(path.join(root, "smoke-tmp"));
	await fs.writeFile(
		host,
		`
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { declareWorkerHostEntry } from ${moduleUrl("../utils/src/index.ts")};
import { extractEmbeddedAddons, prepareNativeVersionDir } from ${moduleUrl("../natives/native/loader-state.js")};
import { closeDaemonClient, daemonClient, isolateDaemonForSmokeTest, probeDaemon, smokeTestDaemon } from ${moduleUrl("src/daemon/client.ts")};
import { startDaemonFromEnvironment } from ${moduleUrl("src/daemon/server.ts")};
import { DAEMON_WORKER_ARG } from ${moduleUrl("src/daemon/protocol.ts")};
declareWorkerHostEntry();
const mode = process.argv[2];
const input = Bun.stdin.stream().getReader();
if (mode === "cold") {
	process.stdout.write("ready\\n");
	await input.read();
}
const root = process.env.PI_NATIVES_DIR;
if (!root) throw new Error("Missing native owner");
prepareNativeVersionDir(root);
extractEmbeddedAddons({ files: [{ filename: ${JSON.stringify(filename)}, size: ${image.length}, zstdPath: ${JSON.stringify(compressed)} }], targetDir: root });
const binding = createRequire(import.meta.url)(path.join(root, ${JSON.stringify(filename)}));
if (typeof binding.ipcEndpoint(root, "native-probe") !== "string") throw new Error("Real native binding did not load");
if (mode === DAEMON_WORKER_ARG) {
	await fs.writeFile(${JSON.stringify(path.join(root, "daemon-native-root"))}, root);
	await fs.writeFile(${JSON.stringify(path.join(root, "daemon-pid"))}, String(process.pid));
	await startDaemonFromEnvironment();
} else if (mode === "cold") {
	process.stdout.write("loaded\\n");
	await input.read();
} else if (mode === "smoke") {
	const cleanup = await isolateDaemonForSmokeTest();
	try {
		await smokeTestDaemon();
	} finally {
		await cleanup();
	}
	process.stdout.write("smoke-complete\\n");
	await input.read();
} else {
	const client = mode === "observer" ? await probeDaemon() : await daemonClient();
	if (!client) throw new Error("No daemon to observe");
	await client.request({ op: "ping" });
	process.stdout.write("connected\\n");
	await input.read();
	if (mode === "observer") {
		await client.request({ op: "ping" });
		process.stdout.write("still-connected\\n");
		await input.read();
		client.close();
	} else {
		await closeDaemonClient();
	}
}
`,
	);
	return host;
}

interface NativeHost {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	stderr: Promise<string>;
}

function startHost(host: string, mode: string, nativeRoot: string): NativeHost {
	const proc = Bun.spawn([process.execPath, host, mode], {
		cwd: packageRoot,
		env: {
			...process.env,
			PI_NATIVES_DIR: nativeRoot,
			OMP_CONFIG_ROOT: path.join(path.dirname(host), "config"),
			OMP_DAEMON_DIR: path.join(path.dirname(host), "runtime"),
			OMP_DAEMON_TCP: "",
			OMP_OFFLINE: "0",
			...(mode === "smoke"
				? Object.fromEntries(
						["TMPDIR", "TEMP", "TMP"].map(name => [name, path.join(path.dirname(host), "smoke-tmp")]),
					)
				: {}),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, stderr: new Response(proc.stderr).text() };
}

async function expectLine(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	expected: string,
	host: NativeHost,
): Promise<void> {
	const result = await reader.read();
	if (result.done) {
		const [code, stderr] = await Promise.all([host.proc.exited, host.stderr]);
		throw new Error(`Native host exited before "${expected}" (exit ${code}):\n${stderr}`);
	}
	expect(new TextDecoder().decode(result.value)).toBe(`${expected}\n`);
}

async function expectExit(host: NativeHost): Promise<void> {
	const [code, stderr] = await Promise.all([host.proc.exited, host.stderr]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
}

describe("daemon native cache ownership", () => {
	it("removes the public smoke runtime after the real embedded daemon exits", async () => {
		using temp = TempDir.createSync("@omp-broker-smoke-native-");
		const root = temp.path();
		const host = await createHost(root);
		const worker = startHost(host, "smoke", path.join(root, "creator-natives"));
		const stdout = worker.proc.stdout.getReader();
		try {
			// Daemon re-entry loads the real native image. A mapped DLL prevents
			// recursive cleanup on Windows until the process exits.
			await expectLine(stdout, "smoke-complete", worker);
			expect(await fs.readdir(path.join(root, "smoke-tmp"))).toEqual([]);
		} finally {
			worker.proc.stdin.end();
			await expectExit(worker);
		}
	}, 30_000);

	it("isolates the creator's native leaf where required without stopping the shared daemon", async () => {
		using temp = TempDir.createSync("@omp-broker-native-");
		const root = temp.path();
		const host = await createHost(root);
		const creatorLeaf = path.join(root, "creator-natives");
		const runtime = path.join(root, "runtime");
		const creator = startHost(host, "creator", creatorLeaf);
		const stdout = creator.proc.stdout.getReader();
		let observer: NativeHost | undefined;
		let daemonExit: Promise<boolean> | undefined;
		try {
			await expectLine(stdout, "connected", creator);
			const nativeRoot = await fs.readFile(path.join(root, "daemon-native-root"), "utf8");
			expect(nativeRoot).toBe(process.platform === "linux" ? creatorLeaf : path.join(runtime, "natives"));
			observer = startHost(host, "observer", path.join(root, "observer-natives"));
			const observerOutput = observer.proc.stdout.getReader();
			await expectLine(observerOutput, "connected", observer);
			const pid = Number(await fs.readFile(path.join(root, "daemon-pid"), "utf8"));
			expect(pid).toBeGreaterThan(0);
			const daemon = Process.fromPid(pid);
			if (!daemon) throw new Error("Shared daemon disappeared while the creator was connected");
			daemonExit = daemon.waitForExit({ timeoutMs: 15_000 });
			creator.proc.stdin.end();
			await expectExit(creator);
			// On Windows a mapped creator DLL makes this fail with EPERM.
			if (process.platform !== "linux") await fs.rm(creatorLeaf, { recursive: true });
			observer.proc.stdin.write("check\n");
			await expectLine(observerOutput, "still-connected", observer);
		} finally {
			creator.proc.stdin.end();
			observer?.proc.stdin.end();
			await creator.proc.exited;
			if (observer) await expectExit(observer);
			if (daemonExit) expect(await daemonExit).toBe(true);
		}
		if (process.platform !== "linux") await fs.rm(path.join(runtime, "natives"), { recursive: true });
	}, 30_000);

	it("loads two simultaneous cold native images without changing a published DLL", async () => {
		using temp = TempDir.createSync("@omp-native-cold-");
		const root = temp.path();
		const host = await createHost(root);
		const cache = path.join(root, "shared-natives");
		const workers = [startHost(host, "cold", cache), startHost(host, "cold", cache)];
		const readers = workers.map(worker => worker.proc.stdout.getReader());
		try {
			await Promise.all(readers.map((reader, index) => expectLine(reader, "ready", workers[index]!)));
			for (const worker of workers) worker.proc.stdin.write("go\n");
			await Promise.all(readers.map((reader, index) => expectLine(reader, "loaded", workers[index]!)));
			const [filename] = (await fs.readdir(cache)).filter(name => name.endsWith(".node"));
			expect(await fs.readFile(path.join(cache, filename!))).toEqual(
				await fs.readFile(path.join(nativeDir, filename!)),
			);
			expect((await fs.readdir(cache)).filter(name => name.includes(".tmp."))).toEqual([]);
		} finally {
			for (const worker of workers) worker.proc.stdin.end();
			await Promise.all(workers.map(expectExit));
		}
		await fs.rm(cache, { recursive: true });
	}, 30_000);
});
