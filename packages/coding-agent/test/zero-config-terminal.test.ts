import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ZeroConfigRequest,
	zeroConfigAnthropicReply,
	zeroConfigHasToolResult,
} from "./fixtures/zero-config-anthropic";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

describe("zero-OMP-config offline terminal entry", () => {
	// The actual interactive CLI, native PTY and filesystem tools remain real;
	// only the company's authenticated model service is replaced by loopback.
	it("sends typed input, renders a model response and writes through the native tool without OMP config files", async () => {
		await using root = await TempDir.create("@zero-config-terminal-");
		const cwd = root.join("workspace");
		const home = root.join("home");
		const configRoot = root.join("omp-config");
		const claudeDir = path.join(home, ".claude");
		await fs.mkdir(cwd, { recursive: true });
		const token = "terminal-existing-claude-credential";
		const requests: ZeroConfigRequest[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages"))
					return new Response("Unexpected discovery", { status: 500 });
				if (
					request.headers.get("authorization") !== `Bearer ${token}` &&
					request.headers.get("x-api-key") !== token
				) {
					return Response.json(
						{ error: { type: "authentication_error", message: "Missing Claude credential" } },
						{ status: 401 },
					);
				}
				const body = (await request.json()) as ZeroConfigRequest;
				requests.push(body);
				const main = body.tools?.some(tool => tool.name === "write") === true;
				return zeroConfigAnthropicReply(body.model, main && !zeroConfigHasToolResult(body));
			},
		});
		const pty = new PtySession();
		let running: Promise<{ exitCode?: number; cancelled: boolean; timedOut: boolean }> | undefined;
		let output = "";
		let ptyError: Error | undefined;
		let exited = false;
		const waitFor = async (predicate: () => boolean, label: string) => {
			const deadline = Date.now() + 30_000;
			while (!predicate()) {
				if (ptyError) throw ptyError;
				if (exited || Date.now() >= deadline)
					throw new Error(`Terminal did not reach ${label}: ${Bun.stripANSI(output).slice(-4000)}`);
				await Bun.sleep(20);
			}
		};
		try {
			await Bun.write(
				path.join(claudeDir, "settings.json"),
				JSON.stringify({
					env: {
						ANTHROPIC_BASE_URL: server.url.origin,
						ANTHROPIC_AUTH_TOKEN: token,
					},
				}),
			);
			expect(await Bun.file(path.join(configRoot, "agent", "config.yml")).exists()).toBe(false);
			expect(await Bun.file(path.join(configRoot, "agent", "models.yml")).exists()).toBe(false);
			const env = Object.fromEntries(
				Object.entries({
					...process.env,
					TERM: "xterm-256color",
					HOME: home,
					USERPROFILE: home,
					XDG_CONFIG_HOME: path.join(home, ".config"),
					APPDATA: path.join(home, "appdata"),
					LOCALAPPDATA: path.join(home, "localappdata"),
					OMP_CONFIG_ROOT: configRoot,
					PI_CODING_AGENT_DIR: "",
					PI_CONFIG_FILES: "",
					OMP_PROFILE: "",
					PI_PROFILE: "",
					CLAUDE_CONFIG_DIR: claudeDir,
					OMP_OFFLINE: "1",
					PI_TEST_RUNTIME: "",
					NO_PROXY: "127.0.0.1,localhost",
				}).map(([key, value]) => [key, value ?? ""]),
			);
			running = pty.startArgv(
				{
					application: process.execPath,
					args: [cli, "--cwd", cwd, "--auto-approve", "--no-session"],
					cwd,
					cols: 120,
					rows: 30,
					env,
				},
				(error, chunk) => {
					if (error) ptyError = error;
					else output += chunk;
				},
				error => {
					if (error) ptyError = error;
				},
			);
			void running
				.finally(() => {
					exited = true;
				})
				.catch(() => {});
			await waitFor(() => Bun.stripANSI(output).includes("GLM-5.3-public"), "company-model startup");
			pty.write("ZERO_CONFIG_REQUEST: write proof.txt then finish.\r");
			await waitFor(() => requests.some(zeroConfigHasToolResult), "native write tool result");
			await waitFor(() => Bun.stripANSI(output).includes("ZERO_CONFIG_COMPLETE"), "rendered model completion");
			expect(await fs.readFile(path.join(cwd, "proof.txt"), "utf8")).toBe("ZERO_CONFIG_TOOL_EFFECT");
			const main = requests.filter(request => request.tools?.some(tool => tool.name === "write"));
			expect(main.some(request => JSON.stringify(request.messages).includes("ZERO_CONFIG_REQUEST"))).toBe(true);
			expect(new Set(main.map(request => request.model))).toEqual(new Set(["GLM-5.3-public"]));
			pty.write("\x04");
			await waitFor(() => exited, "normal terminal exit");
			expect(await running).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
		} finally {
			if (running && !exited) {
				pty.kill();
			}
			if (running) await running;
			await server.stop(true);
		}
	}, 120_000);
});
