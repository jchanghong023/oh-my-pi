import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol, commandAckSchema } from "../../src/modes/zcode/schema";
import {
	create,
	definition,
	disposeWorkflowPeers,
	fixture,
	savedRuns,
	start,
	WorkflowPeer,
} from "./zcode-workflow-process-helpers";

afterEach(disposeWorkflowPeers);

describe("ZCode saved workflows through actual app-server process", () => {
	test("definition file operations preserve script bytes and move without overwriting", async () => {
		await using root = TempDir.createSync("@zcode-workflow-files-");
		await using config = await fixture(root);
		const script = 'return { text: "逐字节", n: 7 };\n';
		const globalFile = path.join(config.globalDir, "move-proof.dwf.ts");
		const projectFile = path.join(config.projectDir, "move-proof.dwf.ts");
		await fs.writeFile(globalFile, definition(script));
		await using peer = new WorkflowPeer(config.cwd, config.env);
		await peer.ready.promise;
		const workspace = config.workspace;
		const before = await peer.request("session/list", { workspace });
		const listed = LegacyProtocol.zcodeWorkflowsListResultSchema.parse(
			await peer.request("workflows/list", { workspace, scope: "global" }),
		);
		expect(listed.invalid).toEqual([]);
		expect(listed.workflows).toContainEqual(
			expect.objectContaining({ name: "move-proof", scope: "global", path: globalFile }),
		);
		const meta = {
			description: "Edited only metadata",
			whenToUse: "Before release",
			args: { topic: { type: "string", required: true } },
		};
		expect(
			LegacyProtocol.zcodeWorkflowsUpdateMetaResultSchema.parse(
				await peer.request("workflows/updateMeta", { workspace, scope: "global", name: "move-proof", meta }),
			),
		).toEqual({ ok: true, path: globalFile });
		const updated = LegacyProtocol.zcodeWorkflowsGetResultSchema.parse(
			await peer.request("workflows/get", { workspace, scope: "global", name: "move-proof" }),
		);
		expect(updated).toMatchObject({ ok: true, script, meta });
		const bytes = await fs.readFile(globalFile);
		await fs.writeFile(projectFile, "existing target\n");
		expect(await peer.request("workflows/move", { workspace, name: "move-proof" })).toMatchObject({
			ok: false,
			reason: "target_exists",
		});
		expect(await fs.readFile(globalFile)).toEqual(bytes);
		expect(await fs.readFile(projectFile, "utf8")).toBe("existing target\n");
		await fs.unlink(projectFile);
		expect(
			LegacyProtocol.zcodeWorkflowsMoveResultSchema.parse(
				await peer.request("workflows/move", { workspace, name: "move-proof" }),
			),
		).toEqual({ ok: true, from: globalFile, to: projectFile });
		expect(await fs.readFile(projectFile)).toEqual(bytes);
		await expect(fs.access(globalFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			LegacyProtocol.zcodeWorkflowsDeleteResultSchema.parse(
				await peer.request("workflows/delete", { workspace, name: "move-proof" }),
			),
		).toEqual({ ok: true, path: projectFile });
		await expect(fs.access(projectFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			LegacyProtocol.zcodeWorkflowsListResultSchema.parse(await peer.request("workflows/list", { workspace }))
				.workflows,
		).toEqual([]);
		expect(await peer.request("session/list", { workspace })).toEqual(before);
		expect(config.requests).toEqual([]);
		await peer.close();
	}, 120_000);
	test("compile, arguments and unavailable named models reject without orphaning the Hub launch session", async () => {
		await using root = TempDir.createSync("@zcode-workflow-preflight-");
		await using config = await fixture(root);
		for (const [name, script] of [
			["bad-types", 'const value: number = "not a number";\nreturn value;\n'],
			["bad-model", 'agent("judge", { model: "no-such-workflow-model" });\nreturn 1;\n'],
			["required-args", "return args.topic;\n"],
		])
			await fs.writeFile(path.join(config.projectDir, `${name}.dwf.ts`), definition(script!));
		await using peer = new WorkflowPeer(config.cwd, config.env);
		await peer.ready.promise;
		const workspace = config.workspace;
		const before = await peer.request("session/list", { workspace });
		for (const [name, args, reason] of [
			["bad-types", { topic: "types" }, "compile_failed"],
			["bad-model", { topic: "models" }, "compile_failed"],
			["required-args", {}, "invalid_args"],
		] as const) {
			const sessionId = await create(peer, workspace);
			const ack = await start(peer, sessionId, name, args);
			expect(ack).toMatchObject({
				status: "rejected",
				reasonCode: `fault.command.savedWorkflowStartRejected.${reason}`,
			});
			if (name === "bad-model") {
				expect(JSON.stringify(ack)).toContain("9011");
				expect(JSON.stringify(ack)).toContain("no-such-workflow-model");
			}
			expect((await savedRuns(peer, workspace, name)).runs).toEqual([]);
			// Match the actual Hub launcher: a rejected start reclaims its newly created target.
			expect(
				commandAckSchema.parse(
					await peer.request("v4/command", {
						commandId: crypto.randomUUID(),
						clientId: "workflow-process",
						sessionId,
						type: "deleteSession",
						payload: {},
						issuedAt: Date.now(),
					}),
				),
			).toMatchObject({ status: "accepted" });
			expect(await peer.request("session/list", { workspace })).toEqual(before);
		}
		expect(config.requests).toEqual([]);
		await peer.close();
	}, 120_000);
});
