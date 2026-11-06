import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunningCommand {
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	result: Promise<CommandResult>;
}

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Collab CLI process boundary timed out")), 15_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function launch(args: string[], dir: TempDir, offline: boolean, onStdout?: (output: string) => void): RunningCommand {
	// An allowlist, rather than inherited env, excludes real credentials, profiles,
	// company settings and proxies. The empty cwd also excludes project .env files.
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		COMSPEC: process.env.COMSPEC,
		PATHEXT: process.env.PATHEXT,
		HOME: dir.path(),
		USERPROFILE: dir.path(),
		APPDATA: dir.join("appdata"),
		LOCALAPPDATA: dir.join("localappdata"),
		OMP_CONFIG_ROOT: dir.join("config"),
		OMP_OFFLINE: offline ? "1" : "0",
		NO_COLOR: "1",
	};
	const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "collab", ...args], {
		cwd: dir.path(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = (async () => {
		const decoder = new TextDecoder();
		let output = "";
		for await (const chunk of child.stdout) {
			output += decoder.decode(chunk, { stream: true });
			onStdout?.(output);
		}
		return output + decoder.decode();
	})();
	const stderr = new Response(child.stderr).text();
	return {
		child,
		result: Promise.all([child.exited, stdout, stderr]).then(([code, out, err]) => ({
			code,
			stdout: Bun.stripANSI(out),
			stderr: Bun.stripANSI(err),
		})),
	};
}

async function dispose(command: RunningCommand): Promise<void> {
	if (command.child.exitCode === null && command.child.signalCode === null) command.child.kill("SIGKILL");
	await command.result;
}

async function run(args: string[], dir: TempDir, offline: boolean): Promise<CommandResult> {
	const command = launch(args, dir, offline);
	try {
		return await within(command.result);
	} finally {
		await dispose(command);
	}
}

describe("omp collab serve process boundary", () => {
	it("keeps serve unavailable and absent from help outside offline mode", async () => {
		const dir = await TempDir.create("@omp-collab-serve-online-");
		try {
			const help = await run(["--help"], dir, false);
			expect(help.code, help.stderr).toBe(0);
			expect(help.stdout).not.toMatch(/\bserve\b/);

			const unsupported = await run(["serve"], dir, false);
			expect(unsupported.code, unsupported.stdout + unsupported.stderr).toBe(1);
			expect(unsupported.stdout + unsupported.stderr).toContain("serve");
			expect(unsupported.stdout).not.toContain("listening on");
		} finally {
			await dir.remove();
		}
	}, 45_000);

	it("serves a real offline lookup without model or company setup and releases its port on termination", async () => {
		const dir = await TempDir.create("@omp-collab-serve-offline-");
		let command: RunningCommand | undefined;
		try {
			const help = await run(["--help"], dir, true);
			expect(help.code, help.stderr).toBe(0);
			expect(help.stdout).toMatch(/\bserve\b/);

			const listening = Promise.withResolvers<string>();
			command = launch(["serve", "--host", "127.0.0.1", "--port", "0"], dir, true, output => {
				const match = /listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(output);
				if (match) listening.resolve(match[1]!);
			});
			const url = await within(
				Promise.race([
					listening.promise,
					command.result.then(result => {
						throw new Error(`Relay exited before listening (${result.code}): ${result.stdout}${result.stderr}`);
					}),
				]),
			);
			const endpoint = new URL("/collab/users/unshared-fixture-user", url.replace(/^ws:/, "http:"));
			const response = await fetch(endpoint, {
				headers: { Connection: "close" },
				signal: AbortSignal.timeout(5_000),
			});
			await response.text();
			expect(response.status).toBe(404);

			command.child.kill("SIGTERM");
			await within(command.result);
			// Signal exit codes vary by runtime; completed shutdown and a closed port
			// are the observable termination contract.
			let reachable = false;
			try {
				const socket = await Bun.connect({
					hostname: endpoint.hostname,
					port: Number(endpoint.port),
					socket: { data() {} },
				});
				try {
					reachable = true;
				} finally {
					socket.end();
				}
			} catch (error) {
				// A refused TCP connection, not an HTTP status, proves the listener is gone.
				expect(error).toMatchObject({ code: "ECONNREFUSED" });
			}
			expect(reachable).toBe(false);
		} finally {
			try {
				if (command) await dispose(command);
			} finally {
				await dir.remove();
			}
		}
	}, 60_000);
});
