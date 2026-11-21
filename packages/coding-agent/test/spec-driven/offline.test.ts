import { expect, it } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CLAUDE_TRACE_DEBUG_CERT, CLAUDE_TRACE_DEBUG_KEY } from "../../src/cli/claude-trace-cli";

it("keeps explicit offline checks on the configured HTTPS mirror without enabling telemetry", async () => {
	await using temp = await TempDir.create("@omp-openspec-offline-");
	let redirectConnections = 0;
	// Count even a TCP connection, not just a successful HTTPS request.
	const redirectTarget = net.createServer(socket => {
		redirectConnections++;
		socket.destroy();
	});
	const listening = Promise.withResolvers<void>();
	redirectTarget.once("error", listening.reject);
	redirectTarget.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = redirectTarget.address();
	if (!address || typeof address === "string") throw new Error("Missing loopback redirect target port");
	try {
		const sameOriginPath = "/within-mirror";
		const mirrorPaths: string[] = [];
		using mirror = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: CLAUDE_TRACE_DEBUG_CERT, key: CLAUDE_TRACE_DEBUG_KEY },
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				mirrorPaths.push(pathname);
				const location = pathname === sameOriginPath ? `https://127.0.0.1:${address.port}/latest` : sameOriginPath;
				return new Response(null, { status: 302, headers: { Location: location } });
			},
		});
		const mirrorHops = ["/@fission-ai/openspec/latest", sameOriginPath];
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
					NODE_TLS_REJECT_UNAUTHORIZED: "0", // Self-signed loopback fixture only.
					CI: "false",
					OPENSPEC_TELEMETRY: "1",
					DO_NOT_TRACK: "0",
					OPENSPEC_NO_UPDATE_CHECK: undefined,
					npm_config_registry: mirror.url.origin,
				},
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(`OpenSpec exited with ${code}: ${stderr}`);
			return JSON.parse(stdout);
		}
		expect((await report(" on ", probe)).update.status).toBe("offline");
		expect(
			(await report("true", path.join(packageRoot, "src/cli.ts"), ["openspec", "version", "--check", "--json"]))
				.update.status,
		).toBe("offline");
		expect(mirrorPaths.splice(0)).toEqual([...mirrorHops, ...mirrorHops]);
		expect(redirectConnections).toBe(0);
		expect((await report("false", probe)).update.status).toBe("offline");
		expect(mirrorPaths).toEqual(mirrorHops);
		expect(redirectConnections).toBe(1);
		// Opting in through the inherited environment/config must not create an anonymous telemetry ID.
		expect(await Bun.file(configPath).text()).toBe(config);
	} finally {
		const closed = Promise.withResolvers<void>();
		redirectTarget.close(error => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	}
}, 30_000);
