import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import type { IModelSelectionService } from "../../../../packages/dev-frontend/packages/services/src/model-provider/providerFacadeServices";
import type { IPromptAttachmentTransferService } from "../../../../packages/dev-frontend/packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer";
import type {
	IZCodeAgentService,
	ZCodeAgentConversationCommandParams,
} from "../../../../packages/dev-frontend/packages/services/src/zcode-agent/zcodeAgent";
import { VSBuffer } from "../../../../packages/dev-frontend/packages/rpc/src/buffer";
import { ChannelClient } from "../../../../packages/dev-frontend/packages/rpc/src/channelClient";
import { Emitter, Event } from "../../../../packages/dev-frontend/packages/rpc/src/foundation";
import { SocketProtocol } from "../../../../packages/dev-frontend/packages/rpc/src/protocol";
import { ProxyChannel } from "../../../../packages/dev-frontend/packages/rpc/src/proxy-channel";
import {
	V4_WIRE_PROTOCOL_VERSION,
	clientHelloSchema,
	commandAckSchema,
	helloMessageSchema,
	v4ConversationRowsRangeResultSchema,
} from "../../../../packages/dev-frontend/packages/shared/src/zcode-protocol-v4";
import type { DevNativeSessionRef } from "../../src/dev-workbench/workflow-types";
import {
	WORKFLOW_VISION_MODEL,
	WorkflowConsumerFixture,
	type WorkflowConsumerProcess,
	pollWorkflow,
} from "../dev-workbench/workflow-fixture";
import { contentText } from "./provider-fixture";

async function nativeConnection(process: WorkflowConsumerProcess, ref: DevNativeSessionRef) {
	const url = new URL("ws", process.url);
	url.protocol = new URL(process.url).protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("clientId", process.clientId);
	url.searchParams.set("projectId", ref.projectId);
	url.searchParams.set("irId", ref.irId);
	if (ref.srId) url.searchParams.set("srId", ref.srId);
	url.searchParams.set("sessionId", ref.sessionId);
	url.searchParams.set("phase", ref.phase);
	url.searchParams.set("round", String(ref.round));
	const socket = new WebSocket(url, {
		headers: { cookie: process.cookie, origin: new URL(process.url).origin, "X-Dev-Client": process.clientId },
	});
	socket.binaryType = "arraybuffer";
	const data = new Emitter<VSBuffer>();
	const closed = new Emitter<void>();
	const disconnected = Promise.withResolvers<void>();
	const protocol = new SocketProtocol({
		onData: data.event,
		onClose: closed.event,
		onEnd: Event.None,
		write: buffer => socket.send(buffer.buffer),
		end: () => socket.close(),
		drain: async () => {},
		dispose: () => socket.close(),
	});
	const client = new ChannelClient(protocol);
	socket.addEventListener("message", event => {
		if (typeof event.data === "string") return;
		data.fire(VSBuffer.wrap(new Uint8Array(event.data)));
	});
	socket.addEventListener("close", event => {
		closed.fire();
		client.dispose();
		disconnected.resolve();
	});
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve(), { once: true });
	socket.addEventListener("error", () => opened.reject(new Error("Native Dev RPC failed to open")), { once: true });
	await opened.promise;
	const agent = ProxyChannel.toService<IZCodeAgentService>(client.getChannel("zcode-agent"));
	const hello = helloMessageSchema.parse(await agent.helloConversationV4());
	expect(hello.capabilities.binaryFrames).toBe(true);
	await agent.initializeConversationV4(
		clientHelloSchema.parse({
			kind: "clientHello",
			protocolVersion: V4_WIRE_PROTOCOL_VERSION,
			clientId: "native-consumer",
			clientKind: "web",
			appVersion: "acceptance",
		}),
	);
	return {
		agent,
		disconnected: disconnected.promise,
		modelSelection: ProxyChannel.toService<IModelSelectionService>(client.getChannel("model-selection")),
		attachments: ProxyChannel.toService<IPromptAttachmentTransferService>(
			client.getChannel("prompt-attachment-transfer"),
		),
		[Symbol.dispose]() {
			client.dispose();
			protocol.dispose();
			socket.close();
			data.dispose();
			closed.dispose();
		},
	};
}

async function conversation(fixture: WorkflowConsumerFixture) {
	const process = await fixture.start();
	const projects = await process.view();
	const root = await fs.realpath(fixture.project);
	const projectId = projects.projects.find(project => project.root === root)?.id;
	if (!projectId) throw new Error("Public Dev did not register its actual --cwd project");
	let view = await process.view(projectId);
	expect(
		(
			await process.command({
				type: "createRelease",
				projectId,
				title: "Native interactions",
				operationId: crypto.randomUUID(),
				expectedRevision: view.revision,
			})
		).response.ok,
	).toBe(true);
	view = await process.view(projectId);
	const draft = await process.command({
		type: "createLocalDraft",
		projectId,
		releaseId: view.releases.at(-1)!.id,
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
	});
	expect(draft.response.ok).toBe(true);
	const irId = draft.result.irId!;
	expect(
		(
			await process.request("workflow/bind", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ projectId, irId }),
			})
		).ok,
	).toBe(true);
	view = await process.view(projectId);
	const operationId = crypto.randomUUID();
	const response = await process.request("workflow/input", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			irId,
			text: "Establish this native conversation without formal output",
			operationId,
			expectedRevision: view.revision,
		}),
	});
	expect(response.ok).toBe(true);
	const ref = ((await response.json()) as { session: DevNativeSessionRef }).session;
	await pollWorkflow(
		async () => {
			const current = await process.view(projectId);
			const receipt = current.operations.find(operation => operation.operationId === operationId);
			if (receipt?.status === "failed") throw new Error(`Initial native input failed: ${JSON.stringify(receipt)}`);
			return current;
		},
		value => fixture.provider.requests.length > 0 && value.running.length === 0,
		"Initial native conversation",
	);
	view = await process.view(projectId);
	return {
		process,
		projectId,
		irId,
		ref,
		view,
		workspacePath: view.drafts.find(group => group.id === irId)!.worktree!.path,
	};
}

test("native binary RPC receipts preserve exact text and normalized image bytes once", async () => {
	await using fixture = await WorkflowConsumerFixture.create({
		model: WORKFLOW_VISION_MODEL,
		input: ["text", "image"],
		reply: () => ({ text: "Native response without approval." }),
	});
	const { process, projectId, ref, view, workspacePath } = await conversation(fixture);
	using rpc = await nativeConnection(process, ref);
	const models = await rpc.modelSelection.getView({ sessionId: ref.sessionId, selection: null });
	expect(models.nativeSession).toMatchObject({
		sessionId: ref.sessionId,
		workspacePath,
		chatAvailable: true,
	});
	expect(models.preferredSelection).toBeDefined();
	expect(models.nativeSession!.models).toContainEqual(expect.objectContaining(models.preferredSelection!));
	const vision = models.nativeSession!.models.find(
		model => `${model.providerId}/${model.modelId}` === WORKFLOW_VISION_MODEL,
	);
	if (!vision) throw new Error("The fixture did not advertise its image-capable native model");
	if (!rpc.modelSelection.setSessionModel) throw new Error("Native session model selection is unavailable");
	const selected = await rpc.modelSelection.setSessionModel({
		sessionId: ref.sessionId,
		providerId: vision.providerId,
		modelId: vision.modelId,
	});
	expect(selected.preferredSelection).toEqual({ providerId: vision.providerId, modelId: vision.modelId });
	expect(selected.nativeSession).toMatchObject({
		sessionId: ref.sessionId,
		workspacePath,
		chatAvailable: true,
	});
	const agent = rpc.agent;
	const bytesBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
	const attachment = await rpc.attachments.stage({
		operationId: crypto.randomUUID(),
		sessionId: ref.sessionId,
		workspacePath,
		localPath: "",
		fileName: "pixel.png",
		mime: "image/png",
		bytesBase64,
		sizeBytes: Buffer.from(bytesBase64, "base64").length,
	});
	expect(attachment).toMatchObject({ staged: true, bytes: Buffer.from(bytesBase64, "base64").length });
	const text = "Explain whitespace; do not approve or advance. Exact input 中文";
	const command = {
		workspacePath,
		envelope: {
			commandId: crypto.randomUUID(),
			clientId: "native-consumer",
			sessionId: ref.sessionId,
			type: "sendText",
			issuedAt: Date.now(),
			payload: {
				text,
				attachments: [{ ref: attachment.ref, bytes: attachment.bytes, fileName: "pixel.png", mime: "image/png" }],
			},
		},
	} satisfies ZCodeAgentConversationCommandParams;
	const receipt = commandAckSchema.parse(await agent.sendConversationCommandV4(command));
	expect(receipt).toMatchObject({
		commandId: command.envelope.commandId,
		status: "accepted",
		result: { type: "inputAccepted", delivery: "startNow", inputId: command.envelope.commandId },
	});
	await pollWorkflow(
		() => process.view(projectId),
		value =>
			value.running.length === 0 &&
			fixture.provider.requests.some(request =>
				request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
			),
		"Native image input settlement",
	);
	const history = await pollWorkflow(
		async () =>
			v4ConversationRowsRangeResultSchema.parse(
				await agent.conversationRowsRangeV4({
					workspacePath,
					sessionId: ref.sessionId,
					residency: "resident-only",
					limit: 200,
				}),
			),
		value => {
			const input = value.rows.find(
				row =>
					row.kind === "userInput" &&
					row.sourceCommandId === command.envelope.commandId &&
					row.clientId === command.envelope.clientId,
			);
			return (
				!!input &&
				value.rows.some(
					row =>
						row.rowId > input.rowId &&
						row.turnId === input.turnId &&
						row.kind === "assistantText" &&
						row.text === "Native response without approval." &&
						row.state === "complete",
				)
			);
		},
		"Native composer reply history",
	);
	const inputs = history.rows.filter(
		row => row.kind === "userInput" && row.sourceCommandId === command.envelope.commandId,
	);
	expect(inputs).toHaveLength(1);
	const input = inputs[0]!;
	if (input.kind !== "userInput") throw new Error("Native command history did not retain a user input row");
	expect(input.clientId).toBe(command.envelope.clientId);
	expect(input.attachments).toEqual(command.envelope.payload.attachments);
	// Native image loading appends attachment context; the original input must remain an exact, untrimmed prefix.
	expect(input.text.slice(0, text.length)).toBe(text);
	expect(input.text.slice(text.length, text.length + 2)).toBe("\n\n");
	expect(history.rows).toContainEqual(
		expect.objectContaining({
			kind: "assistantText",
			text: "Native response without approval.",
			state: "complete",
		}),
	);
	const count = fixture.provider.requests.length;
	expect(commandAckSchema.parse(await agent.sendConversationCommandV4(command))).toEqual(receipt);
	expect(fixture.provider.requests).toHaveLength(count);
	const request = fixture.provider.requests.findLast(request =>
		request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
	)!;
	expect(request.model).toBe(vision.modelId);
	const delivered = request.messages.filter(
		message => message.role === "user" && contentText(message.content).includes(text),
	);
	expect(delivered).toHaveLength(1);
	expect(contentText(delivered[0]!.content)).toBe(input.text);
	if (!Array.isArray(delivered[0]!.content)) throw new Error("Image input reached the provider as text only");
	const wireImages = delivered[0]!.content.filter(part => isRecord(part) && part.type === "image_url");
	expect(wireImages).toHaveLength(1);
	const entries = (await fs.readFile(ref.sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	const persisted = entries.filter(
		entry =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			entry.message.sourceCommand?.commandId === command.envelope.commandId,
	);
	expect(persisted).toHaveLength(1);
	expect(persisted[0].message.inputClientId).toBe(command.envelope.clientId);
	expect(persisted[0].message.attachments).toEqual(command.envelope.payload.attachments);
	const normalized = persisted[0].message.content.find((part: { type: string }) => part.type === "image");
	expect(normalized).toBeDefined();
	const metadata = parseImageMetadata(Buffer.from(normalized.data, "base64"));
	expect(metadata?.width).toBeGreaterThan(0);
	expect(metadata?.height).toBeGreaterThan(0);
	expect(normalized.mimeType).toBe(metadata!.mimeType);
	expect(wireImages).toEqual([
		{ type: "image_url", image_url: { url: `data:${normalized.mimeType};base64,${normalized.data}` } },
	]);
	expect(contentText(persisted[0].message.content)).toBe(input.text);
	const after = await process.view(projectId);
	// Durable input-operation receipts advance the project revision, not formal business authority.
	expect(after.drafts).toEqual(view.drafts);
	expect(after.groups).toEqual(view.groups);
	expect(after.srs).toEqual(view.srs);
	expect(after.materials).toEqual(view.materials);
	expect(after.sessions).toEqual(view.sessions);
	expect(after.selected).toEqual(view.selected);
	expect(after.activeSrId).toBe(view.activeSrId);
}, 180_000);

test("forged native targets and a late UI answer cannot control a rebound browser", async () => {
	await using fixture = await WorkflowConsumerFixture.create({
		reply: () => ({ text: "Native response without approval." }),
	});
	const { process, projectId, irId, ref, view, workspacePath } = await conversation(fixture);
	using rpc = await nativeConnection(process, ref);
	const agent = rpc.agent;
	const count = fixture.provider.requests.length;
	await expect(agent.getSessionLifecycle({ workspacePath, sessionId: "unrelated-native-session" })).rejects.toThrow(
		"Native history does not belong to this exact Dev object/session",
	);
	const forged = await process.request("workflow/input", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			irId,
			sessionId: "unrelated-native-session",
			round: ref.round,
			text: "Do not deliver",
			expectedRevision: view.revision,
			operationId: crypto.randomUUID(),
		}),
	});
	expect(forged.status).toBe(409);
	expect(await forged.json()).toMatchObject({
		category: "dev-workflow",
		error: "Native session/round binding changed",
	});
	const rebound = await process.command({
		type: "createLocalDraft",
		projectId,
		releaseId: view.releases.at(-1)!.id,
		operationId: crypto.randomUUID(),
		expectedRevision: view.revision,
	});
	expect(rebound.response.ok).toBe(true);
	const reboundIrId = rebound.result.irId;
	if (!reboundIrId) throw new Error("The second real draft was not created");
	expect(reboundIrId).not.toBe(irId);
	const binding = await process.request("workflow/bind", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, irId: reboundIrId }),
	});
	expect(binding.ok).toBe(true);
	expect(await binding.json()).toMatchObject({ binding: { projectId, irId: reboundIrId } });
	const beforeStale = await process.view(projectId);
	// The old connection still names its genuine session and workspace, not a forged target.
	// Valid text must be refused too, independently of the late interaction's expired ID.
	for (const input of [
		{ type: "sendText", payload: { text: "Do not deliver from the previously selected object" } },
		{ type: "resolveInteraction", payload: { interactionId: "expired", answer: { optionId: "approve" } } },
	] as const) {
		const outcome = await agent
			.sendConversationCommandV4({
				workspacePath,
				envelope: {
					commandId: crypto.randomUUID(),
					clientId: "native-consumer",
					sessionId: ref.sessionId,
					issuedAt: Date.now(),
					...input,
				},
			})
			.then(
				value => ({ kind: "receipt" as const, value }),
				(error: unknown) => ({ kind: "transportError" as const, error }),
			);
		if (outcome.kind === "transportError") {
			if (!(outcome.error instanceof Error)) throw outcome.error;
			expect([
				{ name: "ConnectionClosed", message: "ChannelClient disposed" },
				{ name: "Error", message: "ChannelClient is disposed" },
			]).toContainEqual({ name: outcome.error.name, message: outcome.error.message });
			// A transport error is not an ACK: require the actual old WebSocket to have closed.
			await rpc.disconnected;
		} else {
			const receipt = commandAckSchema.parse(outcome.value);
			expect(receipt.status).toBe("rejected");
			expect(receipt.result).toBeUndefined();
		}
	}
	expect(fixture.provider.requests).toHaveLength(count);
	const after = await process.view(projectId);
	expect(after.revision).toBe(beforeStale.revision);
	expect(after.drafts).toEqual(beforeStale.drafts);
	expect(after.groups).toEqual(beforeStale.groups);
	expect(after.srs).toEqual(beforeStale.srs);
	expect(after.materials).toEqual(beforeStale.materials);
	expect(after.sessions).toEqual(beforeStale.sessions);
	expect(after.selected).toEqual(beforeStale.selected);
	expect(after.activeSrId).toBe(beforeStale.activeSrId);
}, 180_000);
