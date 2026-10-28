import { expect } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { v4ConversationRowsRangeResultSchema } from "../../src/modes/zcode/schema";
import { fixture, GATE_BUDGET, isConversation, PublicPeer, test } from "./process-fixture";
import { contentText, createProviderFixture, MARKER, REQUIREMENT, respond, rolePayload } from "./provider-fixture";

test("CLI Dev executor receives an asynchronous child through native wait", async () => {
	await using root = await TempDir.create("@omp-dev-wait-smoke-");
	const release = Promise.withResolvers<void>();
	const marker = "OMP_DEV_WAIT_SMOKE_CHILD";
	const childResult = "OMP_DEV_WAIT_SMOKE_RESULT";
	let dispatched = false;
	let requestedWait = false;
	await using provider = createProviderFixture({
		async reply(request) {
			if (request.messages.some(message => message.role === "user" && contentText(message.content).includes(`Complete assignment thoroughly:\n\n${marker}`))) {
				await release.promise;
				return { text: childResult };
			}
			if (rolePayload(request)?.specDrivenRole !== "executor") return respond(request);
			if (!dispatched) {
				dispatched = true;
				return { tool: { name: "task", args: {
					context: "Wait for a background child through the native wait tool.",
					tasks: [{ name: "SmokeWaitChild", task: marker, solutionSpace: "return a result" }],
				} } };
			}
			if (!requestedWait) {
				requestedWait = true;
				return { tool: { name: "wait", args: {} } };
			}
			return { text: "OMP_DEV_WAIT_SMOKE_DONE" };
		},
	});
	const config = await fixture(root, provider.baseUrl);
	await Bun.write(path.join(config.env.PI_CODING_AGENT_DIR!, "config.yml"),
		"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ntools:\n  xdev: false\nasync:\n  enabled: true\n");
	await using peer = new PublicPeer(config.cwd, config.env, provider);
	try {
		await peer.ready();
		const session = await peer.create(config.cwd);
		await peer.send(session, "/dev");
		let since = await peer.send(session, `/dev new ${MARKER}: ${REQUIREMENT}`);
		for (const phase of ["requirements", "solution", "planning"]) {
			const current = await peer.stage(session, phase);
			const stageId = current.spec.interaction?.recipient?.sessionId;
			if (!stageId) throw new Error("Native stage session missing");
			await peer.settled(stageId, since);
			since = await peer.send(session, phase === "solution" ? "/dev next pure" : "/dev next");
		}
		const current = await peer.stage(session, "executing", false);
		const stageId = current.spec.interaction?.recipient?.sessionId;
		if (!stageId) throw new Error("Native executor session missing");
		await peer.request("v4/conversation/subscribe", {
			topic: `conversation/${stageId}`, connectionId: crypto.randomUUID(), clientMode: "desktop-continuous",
		});
		await peer.next(async frame => {
			if (!isConversation(frame, stageId)) return false;
			const rows = v4ConversationRowsRangeResultSchema.parse(await peer.request("v4/conversation/rowsRange", { sessionId: stageId, limit: 200 })).rows;
			return rows.some(row => row.kind === "toolCall" && row.toolName === "wait" && row.status === "running");
		}, since);
		console.log("CLI smoke: observed native wait running while the child result is held");
		release.resolve();
		await peer.settled(stageId, since);
		const rows = v4ConversationRowsRangeResultSchema.parse(await peer.request("v4/conversation/rowsRange", { sessionId: stageId, limit: 200 })).rows;
		const tools = rows.filter(row => row.kind === "toolCall");
		expect(tools.map(row => row.toolName)).toEqual(["task", "wait"]);
		expect(tools.find(row => row.toolName === "wait")?.status).toBe("success");
		const executor = provider.requests.filter(request => rolePayload(request)?.specDrivenRole === "executor");
		expect(executor.some(request => request.messages.some(message => message.role === "tool" && contentText(message.content).includes(childResult)))).toBe(true);
		expect(provider.failures).toEqual([]);
		console.log("CLI smoke: task -> wait -> real child result; wait=success; status polls=0; provider=local mock");
	} finally {
		release.resolve();
	}
}, GATE_BUDGET);
