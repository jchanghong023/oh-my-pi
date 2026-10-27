import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { v4ConversationRowsRangeResultSchema } from "../../src/modes/zcode/schema";
import {
	fixture,
	GATE_BUDGET,
	isConversation,
	PublicPeer,
	registerInvalidFileTests,
	test,
	textValues,
} from "./process-fixture";
import { registerPackagedSkillTest } from "./process-packaged-skills-fixture";
import { createProviderFixture, MARKER, REQUIREMENT, rolePayload } from "./provider-fixture";

describe("spec-driven actual OMP public entry", () => {
	test(
		"ordinary sessions retain native read, write and Task outside /dev",
		async () => {
			await using root = await TempDir.create("@omp-spec-ordinary-control-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			const since = await peer.send(
				session,
				"OMP_SPEC_ORDINARY_CONTROL: exercise ordinary native read, write and Task.",
			);
			await peer.next(
				frame =>
					isConversation(frame, session) &&
					textValues(frame).some(text => text.includes("OMP_SPEC_ORDINARY_CONTROL_DONE")),
				since,
			);
			expect(await fs.readFile(path.join(config.cwd, "ordinary-note.txt"), "utf8")).toBe(
				"ordinary session remains writable\n",
			);
			expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
			const native = provider.requests
				.flatMap(request => request.messages)
				.flatMap(message => message.tool_calls ?? [])
				.filter(isRecord);
			expect(
				native.some(
					call =>
						isRecord(call.function) &&
						typeof call.function.name === "string" &&
						call.function.name.replace(/^_/u, "") === "task",
				),
			).toBe(true);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);
	test(
		"first Dev entry binds the native recipient before its first reply and keeps root history independent",
		async () => {
			await using root = await TempDir.create("@omp-dev-native-first-entry-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const session = await peer.create(config.cwd);
			await peer.send(session, "/dev");
			const since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
			const current = await peer.stage(session, "requirements", false);
			const stageId = current.spec.interaction?.recipient?.sessionId;
			if (!stageId) throw new Error("Native stage session missing");
			expect(stageId).not.toBe(session);
			await peer.settled(stageId, since);
			const read = (id: string) =>
				peer
					.request("v4/conversation/rowsRange", { sessionId: id, limit: 200 })
					.then(value => v4ConversationRowsRangeResultSchema.parse(value));
			const stage = await read(stageId);
			expect(stage.rows.some(row => row.kind === "toolCall" && row.status === "success")).toBe(true);
			expect(JSON.stringify(stage.rows)).toContain("文件已写入。");
			expect(JSON.stringify((await read(session)).rows)).not.toContain("文件已写入。");
			const feedback = "Keep the current requirements; explain their whitespace rule.";
			const replySince = peer.seen.length;
			const nativeCommand = {
				commandId: crypto.randomUUID(),
				clientId: "omp-spec-acceptance",
				sessionId: stageId,
				type: "sendText",
				payload: { text: feedback },
				baseRevision: (await read(stageId)).atRevision,
				issuedAt: Date.now(),
			};
			expect(await peer.request("v4/command", nativeCommand)).toMatchObject({ status: "accepted" });
			await peer.next(
				frame =>
					isConversation(frame, stageId) &&
					textValues(frame).some(text => text.includes(`${MARKER}_REQUIREMENTS_DIALOGUE`)),
				replySince,
			);
			expect(JSON.stringify((await read(stageId)).rows)).toContain(feedback);
			expect(JSON.stringify((await read(session)).rows)).not.toContain(`${MARKER}_REQUIREMENTS_DIALOGUE`);
			const replyCount = provider.requests.length;
			expect(await peer.request("v4/command", nativeCommand)).toMatchObject({ status: "duplicate" });
			const key = { sessionId: stageId, commandId: nativeCommand.commandId };
			expect(await peer.request("v4/commands/query", { commands: [key] })).toMatchObject({
				results: [{ key, result: { status: "accepted" } }],
			});
			expect(provider.requests.length).toBe(replyCount);
			await peer.send(session, "/dev");
			const ordinarySince = await peer.send(session, "ordinary conversation after Dev exit");
			await peer.next(
				frame =>
					isConversation(frame, session) && textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
				ordinarySince,
			);
			expect(JSON.stringify((await read(stageId)).rows)).not.toContain(`${MARKER}_CHAT_READY`);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

	registerInvalidFileTests(["requirements", "executor"]);

	registerPackagedSkillTest(true);
});
