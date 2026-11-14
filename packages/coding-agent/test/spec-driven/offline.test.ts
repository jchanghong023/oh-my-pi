import { expect, it } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("blocks explicit registry checks offline without enabling telemetry or disabling online checks", async () => {
	await using temp = await TempDir.create("@omp-openspec-offline-");
	let connections = 0;
	const registry = net.createServer(socket => {
		connections++;
		socket.destroy();
	});
	const listening = Promise.withResolvers<void>();
	registry.once("error", listening.reject);
	registry.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = registry.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback registry port");
	const port = address.port;
	try {
		const packageRoot = path.resolve(import.meta.dir, "../..");
		const probe = temp.join("probe.ts");
		await Bun.write(
			probe,
			`import {runOpenSpec} from ${JSON.stringify(path.join(packageRoot, "src/spec-driven/resources.ts"))}; const result=await runOpenSpec(["version","--check","--json"],process.cwd()); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode=result.exitCode;`,
		);
		const configPath = temp.join("config/openspec/config.json");
		const config = JSON.stringify({ telemetry: { enabled: true } });
		await Bun.write(configPath, config);
		async function report(offline: string, entry: string, args: string[] = []) {
			const child = Bun.spawn([process.execPath, entry, ...args], {
				cwd: temp.path(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OMP_OFFLINE: offline,
					OMP_CONFIG_ROOT: temp.join("omp"),
					PI_CODING_AGENT_DIR: temp.join("omp/agent"),
					PI_COMPILED: "false",
					PI_BUNDLED: "false",
					HOME: temp.join("home"),
					USERPROFILE: temp.join("home"),
					APPDATA: temp.join("appdata"),
					LOCALAPPDATA: temp.join("localappdata"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: temp.join("bun-cache"),
					NODE_ENV: "production",
					NODE_TLS_REJECT_UNAUTHORIZED: "1",
					CI: "false",
					OPENSPEC_TELEMETRY: "1",
					DO_NOT_TRACK: "0",
					OPENSPEC_NO_UPDATE_CHECK: undefined,
					npm_config_registry: `https://127.0.0.1:${port}`,
				},
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			return JSON.parse(stdout);
		}
		expect((await report(" on ", probe)).update.status).toBe("disabled");
		expect(
			(await report("true", path.join(packageRoot, "src/cli.ts"), ["openspec", "version", "--check", "--json"]))
				.update.status,
		).toBe("disabled");
		expect(connections).toBe(0);
		expect((await report("false", probe)).update.status).toBe("offline");
		expect(connections).toBe(1);
		// Opting in through the inherited environment/config must not create an anonymous telemetry ID.
		expect(await Bun.file(configPath).text()).toBe(config);
	} finally {
		const closed = Promise.withResolvers<void>();
		registry.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	}
}, 30_000);
