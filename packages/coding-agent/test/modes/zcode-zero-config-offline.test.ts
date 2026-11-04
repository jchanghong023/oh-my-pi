import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol } from "../../src/modes/zcode/schema";
import { command, finishedOutput, ProcessPeer, subscribe, workspace } from "./zcode-process-harness";

import {
	type ZeroConfigRequest as RequestBody,
	zeroConfigAnthropicReply as anthropicReply,
} from "../fixtures/zero-config-anthropic";

describe("zero-OMP-config offline desktop entry", () => {
	// Authentication exists only in the user's existing Claude configuration.
	// No OMP models/settings file is created to make the model or tools work.
	test("uses company defaults to send a message, receive a model reply and execute a real tool", async () => {
		await using root = await TempDir.create("@zcode-zero-config-");
		const cwd = root.join("workspace");
		const home = root.join("home");
		const configRoot = root.join("omp-config");
		const claudeDir = path.join(home, ".claude");
		await fs.mkdir(cwd, { recursive: true });
		const requests: RequestBody[] = [];
		const token = "zero-config-existing-credential";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/messages")) {
					return new Response("Unexpected model discovery request", { status: 500 });
				}
				const body = (await request.json()) as RequestBody;
				requests.push(body);
				const main = body.tools?.some(tool => tool.name === "write") === true;
				const hasResult = body.messages.some(
					message =>
						Array.isArray(message.content) &&
						message.content.some(
							block => block?.type === "tool_result" && block.tool_use_id === "zero_config_write",
						),
				);
				if (
					request.headers.get("authorization") !== `Bearer ${token}` &&
					request.headers.get("x-api-key") !== token
				) {
					return Response.json(
						{ error: { type: "authentication_error", message: "Missing existing Claude credential" } },
						{ status: 401 },
					);
				}
				return anthropicReply(body.model, main && !hasResult);
			},
		});
		try {
			await Bun.write(
				path.join(claudeDir, "settings.json"),
				JSON.stringify({
					env: { ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_AUTH_TOKEN: token },
				}),
			);
			expect(await Bun.file(path.join(configRoot, "agent", "config.yml")).exists()).toBe(false);
			expect(await Bun.file(path.join(configRoot, "agent", "models.yml")).exists()).toBe(false);
			await using peer = new ProcessPeer(cwd, {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				TMP: root.path(),
				TEMP: root.path(),
				TMPDIR: root.path(),
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				APPDATA: path.join(home, "appdata"),
				LOCALAPPDATA: path.join(home, "localappdata"),
				CLAUDE_CONFIG_DIR: claudeDir,
				OMP_CONFIG_ROOT: configRoot,
				OMP_OFFLINE: "1",
				NO_PROXY: "127.0.0.1,localhost",
			});
			await peer.ready();
			const created = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
				await peer.request("session/create", {
					workspace: workspace(cwd),
					titleGenerationEnabled: false,
				}),
			);
			const id = created.session.sessionId;
			await subscribe(peer, id);
			expect(await command(peer, id, "switchCollaborationMode", { mode: "yolo" })).toMatchObject({
				status: "accepted",
			});
			expect(
				await command(peer, id, "sendText", { text: "ZERO_CONFIG_REQUEST: write proof.txt then finish." }),
			).toMatchObject({ status: "accepted" });
			await finishedOutput(peer, id, "ZERO_CONFIG_COMPLETE");
			expect(await fs.readFile(path.join(cwd, "proof.txt"), "utf8")).toBe("ZERO_CONFIG_TOOL_EFFECT");
			const main = requests.filter(request => request.tools?.some(tool => tool.name === "write"));
			expect(main.length).toBeGreaterThanOrEqual(2);
			expect(new Set(main.map(request => request.model))).toEqual(new Set(["GLM-5.3-public"]));
			expect(main.some(request => JSON.stringify(request.messages).includes("ZERO_CONFIG_REQUEST"))).toBe(true);
			expect(
				main.some(request =>
					request.messages.some(
						message =>
							Array.isArray(message.content) &&
							message.content.some(
								block => block?.type === "tool_result" && block.tool_use_id === "zero_config_write",
							),
					),
				),
			).toBe(true);
			expect(await peer.eof()).toBe(0);
		} finally {
			await server.stop(true);
		}
	}, 120_000);
});
