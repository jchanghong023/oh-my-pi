import { afterEach, expect, test } from "bun:test";
import { isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import type { HostFrame, ImageContent } from "@oh-my-pi/pi-wire";
import { closePublicWorkbenches, WorkbenchFixture, eventually } from "../dev-workbench/fixture";
import { contentText, rolePayload } from "./provider-fixture";
afterEach(closePublicWorkbenches);

test("native input receipts bind the real session and preserve attachments without replay", async () => {
	// The default V4.0 fixture has a text-only wire contract despite declaring image input.
	await using fixture = await WorkbenchFixture.create({ model: { provider: "deepseek", id: "deepseek-flash" } });
	await fixture.start();
	const snapshot = await fixture.developUntil("requirements");
	const runtime = snapshot.runtime;
	if (!runtime?.recipient) throw new Error("Native requirements recipient missing");
	const target = {
		requirementId: snapshot.record.requirementId,
		sessionId: runtime.recipient.sessionId,
		generation: runtime.generation,
	};
	const prepared = await fixture.request<{ requestId: string }>("input-preview", target);
	const images: ImageContent[] = [
		{
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
		},
	];
	const text = "Explain whitespace; do not approve or advance. Exact input 中文";
	expect(await fixture.request("input", { requestId: prepared.requestId, text, images })).toMatchObject({
		kind: "accepted",
	});
	await eventually(
		async () =>
			fixture.provider.requests.findLast(request =>
				request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
			),
		value => value !== undefined,
	);
	const waitForIdle = () =>
		eventually(
			() =>
				fixture.request<HostFrame[]>(
					`native-snapshot?${new URLSearchParams({
						requirementId: target.requirementId,
						sessionId: target.sessionId,
						generation: String(target.generation),
					})}`,
				),
			frames =>
				frames.some(
					frame => frame.t === "welcome" && !frame.state.isStreaming && frame.state.queuedMessageCount === 0,
				),
		);
	await waitForIdle();
	const count = fixture.provider.requests.length;
	expect(await fixture.request(`inputs/${prepared.requestId}`)).toMatchObject({ kind: "accepted" });
	expect(await fixture.request("input", { requestId: prepared.requestId, text, images })).toMatchObject({
		kind: "accepted",
	});
	const frames = await waitForIdle();
	expect(fixture.provider.requests).toHaveLength(count);
	const observed = fixture.provider.requests.findLast(request =>
		request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
	);
	if (!observed) throw new Error("Input never reached the real native provider");
	const delivered = observed.messages.filter(
		message => message.role === "user" && contentText(message.content).includes(text),
	);
	expect(delivered).toHaveLength(1);
	const content = delivered[0]!.content;
	if (!Array.isArray(content)) throw new Error("Native image input reached the provider as text-only content");
	// contentText joins non-text parts as empty lines; extract text blocks before comparing the user's text.
	expect(contentText(content.filter(part => isRecord(part) && part.type === "text"))).toBe(text);
	const wireImages = content.filter(part => isRecord(part) && part.type === "image_url");
	expect(wireImages).toHaveLength(1);
	expect(
		fixture.provider.requests.filter(request =>
			request.messages.some(message => message.role === "user" && contentText(message.content).includes(text)),
		),
	).toHaveLength(1);
	const persisted = frames
		.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries : []))
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && contentText(entry.message.content).includes(text)
				? [entry.message]
				: [],
		);
	expect(persisted).toHaveLength(1);
	const persistedContent = persisted[0]!.content;
	if (!Array.isArray(persistedContent)) throw new Error("Native image input was persisted as text-only content");
	expect(contentText(persistedContent.filter(part => part.type === "text"))).toBe(text);
	const persistedImages = persistedContent.filter((part): part is ImageContent => part.type === "image");
	expect(persistedImages).toHaveLength(1);
	const normalized = persistedImages[0]!;
	// Normalization precedes persistence and transport; verify real image metadata, not the original encoding.
	const metadata = parseImageMetadata(Buffer.from(normalized.data, "base64"));
	if (!metadata) throw new Error("Native attachment has no decodable image metadata");
	expect(normalized.mimeType).toBe(metadata.mimeType);
	expect(metadata.width).toBeGreaterThan(0);
	expect(metadata.height).toBeGreaterThan(0);
	expect(wireImages).toEqual([
		{ type: "image_url", image_url: { url: `data:${normalized.mimeType};base64,${normalized.data}` } },
	]);
	expect((await fixture.get(snapshot.record.requirementId)).recordVersion).toBe(snapshot.recordVersion);
	expect(rolePayload(observed)?.specDrivenRole).toBe("requirements");
}, 180_000);

test("forged native target and late UI response cannot control unrelated sessions", async () => {
	await using fixture = await WorkbenchFixture.create();
	await fixture.start();
	const snapshot = await fixture.developUntil("requirements");
	const runtime = snapshot.runtime;
	if (!runtime?.recipient) throw new Error("Native requirements recipient missing");
	const count = fixture.provider.requests.length;
	const response = await fixture.response("input-preview", {
		requirementId: snapshot.record.requirementId,
		sessionId: "unrelated-native-session",
		generation: runtime.generation,
	});
	expect(response.ok).toBe(false);
	const ui = await fixture.response("native-ui-response", {
		requestId: "expired",
		requirementId: snapshot.record.requirementId,
		sessionId: runtime.recipient.sessionId,
		generation: runtime.generation - 1,
		value: true,
	});
	if (ui.ok) expect(await ui.json()).toMatchObject({ accepted: false });
	else expect(ui.status).toBeGreaterThanOrEqual(400);
	expect(fixture.provider.requests).toHaveLength(count);
	expect((await fixture.get(snapshot.record.requirementId)).recordVersion).toBe(snapshot.recordVersion);
}, 180_000);
