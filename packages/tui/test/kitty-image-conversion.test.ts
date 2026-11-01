import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import * as terminalCapabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Container } from "@oh-my-pi/pi-tui/tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";

const IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/jpeg",
};
// Conversion results are process-wide; keep fixtures unique to this test run.
const fixtureId = crypto.randomUUID();
function distinctImage(image: ImageContent, label: string): ImageContent {
	const bytes = Buffer.concat([Buffer.from(image.data, "base64"), Buffer.from(`${fixtureId}:${label}`)]);
	return { ...image, data: bytes.toString("base64") };
}

let preferences: typeof chatTranscriptDisplayPreferences;
let previousProtocol: typeof TERMINAL.imageProtocol;
let previousNativeRendering: boolean;

beforeEach(() => {
	preferences = { ...chatTranscriptDisplayPreferences };
	previousProtocol = TERMINAL.imageProtocol;
	previousNativeRendering = isNativeRendering();
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false, showImages: true });
	setNativeRendering(false);
	setTerminalImageProtocol(ImageProtocol.Kitty);
});

afterEach(() => {
	setChatTranscriptDisplayPreferences(preferences);
	setTerminalImageProtocol(previousProtocol);
	setNativeRendering(previousNativeRendering);
});

describe("Tool image rendering", () => {
	let restorePng: () => void;
	let pngCalls: () => number;
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		const spy = vi.spyOn(Bun.Image.prototype, "png").mockImplementation(() => {
			throw new TypeError("synchronous image conversion failure");
		});
		restorePng = () => spy.mockRestore();
		pngCalls = () => spy.mock.calls.length;
	});

	afterEach(() => {
		restorePng();
	});

	it("omits restored tool-result images when conversion throws synchronously", () => {
		let imageUpdates = 0;
		const component = new AssistantMessageComponent(undefined, false, () => imageUpdates++);

		component.setToolResultImages("restored-read", [distinctImage(IMAGE, "failure-restored")]);
		expect(pngCalls()).toBe(1);
		expect(imageUpdates).toBe(0);
	});

	it("omits live tool-result images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent("read", { path: "repro.jpg" }, {}, undefined, {
			requestRender,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});

		component.updateResult({ content: [distinctImage(IMAGE, "failure-live")] }, false);
		expect(pngCalls()).toBe(1);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("surfaces images returned through xdev write results", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image" },
			{ showImages: true },
			undefined,
			{
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				resetDisplay: vi.fn(),
			},
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Generated 1 image" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						inner: {
							images: [{ data: IMAGE.data, mimeType: "image/png" }],
						},
					},
				},
			},
			false,
		);

		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});
});

describe("Kitty PNG conversion cache", () => {
	// Each test owns payload sizes nothing else converts: the conversion cache is
	// process-wide by design, so shared fixtures would arrive pre-warmed.
	const SEED_PNG = Buffer.from(IMAGE.data, "base64");
	const images: ImageContent[] = [];
	let rebuildImage: ImageContent;
	let liveImage: ImageContent;
	let evictedImage: ImageContent;
	let toolRetirementImage: ImageContent;
	let assistantRetirementImage: ImageContent;
	const floodImages: ImageContent[] = [];
	let encodes = 0;
	let originalPng: typeof Bun.Image.prototype.png;
	let restorePng: () => void;
	/** When set, conversions publish this base64 payload instead of the real PNG. */
	let oversizedPng: string | undefined;

	function finishedMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** Resolves once `count` conversions have published their result. */
	function converted(count: number): { promise: Promise<void>; notify: () => void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		let seen = 0;
		return {
			promise,
			notify: () => {
				if (++seen >= count) resolve();
			},
		};
	}

	async function webpImage(edge: number): Promise<ImageContent> {
		const webp = await new Bun.Image(SEED_PNG).resize(edge, edge).webp().bytes();
		return distinctImage(
			{ type: "image", data: Buffer.from(webp).toString("base64"), mimeType: "image/webp" },
			`${edge}`,
		);
	}

	beforeAll(async () => {
		await initTheme();
		for (const edge of [137, 139, 141]) images.push(await webpImage(edge));
		rebuildImage = await webpImage(143);
		liveImage = await webpImage(145);
		evictedImage = await webpImage(147);
		toolRetirementImage = await webpImage(157);
		assistantRetirementImage = await webpImage(159);
		for (const edge of [149, 151]) floodImages.push(await webpImage(edge));
	});

	beforeEach(() => {
		encodes = 0;
		oversizedPng = undefined;
		originalPng = Bun.Image.prototype.png;
		const spy = vi.spyOn(Bun.Image.prototype, "png").mockImplementation(function (this: Bun.Image) {
			encodes++;
			const encoder = originalPng.call(this);
			if (oversizedPng === undefined) return encoder;
			const payload = oversizedPng;
			return Object.assign(Object.create(encoder), { toBase64: async () => payload });
		});
		restorePng = () => spy.mockRestore();
	});

	afterEach(() => {
		restorePng();
	});

	it("converts each tool-result image once across re-delivery and rebuilt components", async () => {
		const first = converted(images.length);
		const component = new AssistantMessageComponent(undefined, false, first.notify);
		component.setToolResultImages("call-1", images);
		await first.promise;
		expect(encodes).toBe(images.length);

		// Read-result replay delivers the same images again for one toolCallId.
		component.setToolResultImages("call-1", images);
		expect(encodes).toBe(images.length);

		// Transcript rebuilds (resume, rewind, /tree) construct fresh components.
		for (let rebuild = 0; rebuild < 2; rebuild++) {
			new AssistantMessageComponent(undefined, false, () => {}).setToolResultImages("call-1", images);
		}
		expect(encodes).toBe(images.length);
	});

	it("renders an already-converted image on a rebuilt component without waiting for a conversion", async () => {
		const warmed = converted(1);
		const warm = new AssistantMessageComponent(undefined, false, warmed.notify);
		warm.setToolResultImages("call-1", [rebuildImage]);
		await warmed.promise;

		const rebuilt = new AssistantMessageComponent(finishedMessage(), false, () => {});
		rebuilt.setToolResultImages("call-1", [rebuildImage]);

		// Synchronous: no await between delivery and render.
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});

	it("keeps a displayed conversion after the shared cache evicts it", async () => {
		const shown = converted(1);
		const component = new AssistantMessageComponent(finishedMessage(), false, shown.notify);
		component.setToolResultImages("call-1", [evictedImage]);
		await shown.promise;

		// Flood the bounded shared cache with conversions past its byte ceiling.
		oversizedPng = "A".repeat(20 * 1024 * 1024);
		const flooded = converted(floodImages.length);
		new AssistantMessageComponent(undefined, false, flooded.notify).setToolResultImages("call-2", floodImages);
		await flooded.promise;

		// A theme change re-renders every component synchronously.
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});

	it("converts a live tool-result image once across repeated results and rebuilt components", async () => {
		const displayed = converted(1);
		const ui = {
			requestRender: vi.fn(() => displayed.notify()),
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		};
		const component = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		component.updateResult({ content: [liveImage] }, false);
		await displayed.promise;
		expect(encodes).toBe(1);

		component.updateResult({ content: [liveImage] }, false);
		const rebuilt = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		rebuilt.updateResult({ content: [liveImage] }, false);
		expect(encodes).toBe(1);
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});

	it("holds a restored tool card until its WebP image can enter scrollback", async () => {
		const landed = Promise.withResolvers<void>();
		const ui = {
			requestRender: () => {
				if (!card.isTranscriptBlockPending()) landed.resolve();
			},
			requestComponentRender: () => {},
			resetDisplay: () => {},
		};
		const card = new ToolExecutionComponent(
			"eval",
			{ language: "js", code: "await tab.screenshot()" },
			{ useBuiltInRenderer: true, showImages: true },
			undefined,
			ui,
		);
		card.updateResult({ content: [{ type: "text", text: "Screenshot captured" }, toolRetirementImage] }, false);
		const transcript = new TranscriptContainer();
		transcript.addChild(card);
		for (let i = 0; i < 10; i++) transcript.addChild(new Text(`Later message ${i}`, 0, 0));

		expect(card.isTranscriptBlockPending()).toBe(true);
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		await landed.promise;
		expect(card.isTranscriptBlockPending()).toBe(false);
		const batch = transcript.peekFinalizedBatch(80, 5);
		expect(batch?.rows.join("\n")).toContain("\x1b_G");
	});

	it("holds a restored assistant image until its WebP conversion enters scrollback", async () => {
		const landed = converted(1);
		const message = finishedMessage();
		message.content = [assistantRetirementImage, { type: "text", text: "Screenshot preview" }];
		const assistant = new AssistantMessageComponent(message, false, landed.notify);
		const transcript = new TranscriptContainer();
		transcript.addChild(assistant);
		for (let i = 0; i < 10; i++) transcript.addChild(new Text(`Later message ${i}`, 0, 0));

		expect(assistant.isTranscriptBlockPending()).toBe(true);
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		await landed.promise;
		expect(assistant.isTranscriptBlockPending()).toBe(false);
		const batch = transcript.peekFinalizedBatch(80, 5);
		expect(batch?.rows.join("\n")).toContain("\x1b_G");
	});
});

describe("hidden tool image loading", () => {
	const png = IMAGE.data;

	function image(label: string): ImageContent {
		return distinctImage({ type: "image", data: png, mimeType: "image/webp" }, label);
	}

	function message(content: AssistantMessage["content"] = [{ type: "text", text: "Answer" }]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function deferredConversion() {
		const gate = Promise.withResolvers<string>();
		const original = Bun.Image.prototype.png;
		const encode = vi.spyOn(Bun.Image.prototype, "png").mockImplementation(function (this: Bun.Image) {
			const encoder = original.call(this);
			return Object.assign(Object.create(encoder), { toBase64: () => gate.promise });
		});
		cleanups.push(() => encode.mockRestore());
		return { gate, encode };
	}

	let cleanups: (() => void)[];

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		cleanups = [];
	});

	afterEach(() => {
		for (const cleanup of cleanups) cleanup();
	});

	for (const mode of ["compact", "clean", "images-off"] as const) {
		it(`defers a ${mode} tool card image until it becomes visible`, async () => {
			setChatTranscriptDisplayPreferences({
				compactToolActivity: mode === "compact",
				hideToolActivity: mode !== "images-off",
			});
			const { gate, encode } = deferredConversion();
			const dimensions = vi.spyOn(terminalCapabilities, "getImageDimensions");
			cleanups.push(() => dimensions.mockRestore());
			const landed = Promise.withResolvers<void>();
			const ui = {
				requestRender: () => landed.resolve(),
				requestComponentRender: () => {},
				resetDisplay: () => {},
			};
			const picture = image(`card-${mode}`);
			const card = new ToolExecutionComponent("example", {}, { showImages: mode !== "images-off" }, undefined, ui);
			if (mode !== "images-off") card.setToolActivityVisible(false);
			card.updateResult({ content: [{ type: "text", text: "Done" }, picture] }, false);
			card.render(80);
			expect(encode).not.toHaveBeenCalled();
			expect(dimensions).not.toHaveBeenCalled();
			expect(card.isTranscriptBlockPending()).toBe(false);

			setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
			card.setToolActivityVisible(true);
			if (mode === "images-off") card.setShowImages(true);
			card.render(80);
			expect(encode).toHaveBeenCalledTimes(1);
			expect(card.isTranscriptBlockPending()).toBe(true);
			gate.resolve(png);
			await landed.promise;
			expect(card.isTranscriptBlockPending()).toBe(false);
			expect(card.render(80).join("\n")).toContain("\x1b_G");

			const rebuilt = new ToolExecutionComponent("example", {}, {}, undefined, ui);
			rebuilt.updateResult({ content: [picture] }, false);
			expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
			expect(encode).toHaveBeenCalledTimes(1);
		});
	}

	it("keeps hidden grouped images out of pending and the streaming fast path, then restores them", async () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		const { gate, encode } = deferredConversion();
		const landed = Promise.withResolvers<void>();
		const component = new AssistantMessageComponent(message(), false, () => landed.resolve());
		const picture = image("group-compact");
		component.setToolResultImages("read-1", [picture]);
		const content = component.children[0] as Container;
		const prose = content.children[0];
		component.updateContent(message([{ type: "text", text: "Answer continues" }]), { transient: true });
		expect(content.children[0]).toBe(prose);
		expect(encode).not.toHaveBeenCalled();
		expect(component.isTranscriptBlockPending()).toBe(false);

		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		component.render(80);
		expect(encode).toHaveBeenCalledTimes(1);
		expect(component.isTranscriptBlockPending()).toBe(true);
		gate.resolve(png);
		await landed.promise;
		expect(component.isTranscriptBlockPending()).toBe(false);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
		const rebuilt = new AssistantMessageComponent(message());
		rebuilt.setToolResultImages("read-1", [picture]);
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
		expect(encode).toHaveBeenCalledTimes(1);
	});
	for (const mode of ["clean", "images-off", "tool-images-off"] as const) {
		it(`lazily restores grouped images rebuilt in ${mode} mode`, async () => {
			setChatTranscriptDisplayPreferences({ hideToolActivity: mode === "clean" });
			const { gate, encode } = deferredConversion();
			const picture = image(`group-${mode}`);
			const landed = Promise.withResolvers<void>();
			const makeComponent = () => {
				const component = new AssistantMessageComponent(message(), false, () => landed.resolve());
				if (mode === "images-off") component.setImagesVisible(false);
				if (mode === "tool-images-off") component.setToolResultImagesVisible(false);
				component.setToolResultImages("read", [picture]);
				component.render(80);
				return component;
			};
			const original = makeComponent();
			const rebuilt = makeComponent();
			expect(encode).not.toHaveBeenCalled();
			expect(original.isTranscriptBlockPending()).toBe(false);
			expect(rebuilt.isTranscriptBlockPending()).toBe(false);
			const transcript = new TranscriptContainer();
			transcript.addChild(rebuilt);
			for (let i = 0; i < 10; i++) transcript.addChild(new Text(`Later message ${i}`, 0, 0));
			expect(transcript.peekFinalizedBatch(80, 5)).toBeDefined();

			setChatTranscriptDisplayPreferences({ hideToolActivity: false });
			if (mode === "images-off") rebuilt.setImagesVisible(true);
			if (mode === "tool-images-off") rebuilt.setToolResultImagesVisible(true);
			rebuilt.render(80);
			expect(encode).toHaveBeenCalledTimes(1);
			expect(rebuilt.isTranscriptBlockPending()).toBe(true);
			gate.resolve(png);
			await landed.promise;
			expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
			if (mode === "images-off") original.setImagesVisible(true);
			if (mode === "tool-images-off") original.setToolResultImagesVisible(true);
			expect(original.render(80).join("\n")).toContain("\x1b_G");
			expect(encode).toHaveBeenCalledTimes(1);
		});
	}

	it("does not hold a tool card in scrollback while its in-flight image is compacted", async () => {
		const { gate, encode } = deferredConversion();
		const landed = Promise.withResolvers<void>();
		const card = new ToolExecutionComponent("example", {}, {}, undefined, {
			requestRender: () => landed.resolve(),
			requestComponentRender: () => {},
			resetDisplay: () => {},
		});
		card.updateResult({ content: [{ type: "text", text: "Done" }, image("card-in-flight")] }, false);
		expect(card.isTranscriptBlockPending()).toBe(true);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: true });
		card.setToolActivityVisible(false);
		expect(card.isTranscriptBlockPending()).toBe(false);
		const transcript = new TranscriptContainer();
		transcript.setToolActivityVisible(false);
		transcript.addChild(card);
		for (let i = 0; i < 10; i++) transcript.addChild(new Text(`Later message ${i}`, 0, 0));
		expect(transcript.peekFinalizedBatch(80, 5)).toBeDefined();
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		card.setToolActivityVisible(true);
		expect(card.isTranscriptBlockPending()).toBe(true);
		gate.resolve(png);
		await landed.promise;
		expect(card.render(80).join("\n")).toContain("\x1b_G");
		expect(encode).toHaveBeenCalledTimes(1);
	});

	it("stops awaiting an in-flight hidden tool image without ignoring a visible assistant image", async () => {
		const { gate, encode } = deferredConversion();
		const assistantImage = image("assistant-native");
		const toolImage = image("assistant-tool");
		const updates = Promise.withResolvers<void>();
		let completed = 0;
		const component = new AssistantMessageComponent(message([assistantImage]), false, () => {
			if (++completed === 2) updates.resolve();
		});
		component.setToolResultImages("read-2", [toolImage]);
		expect(encode).toHaveBeenCalledTimes(2);
		expect(component.isTranscriptBlockPending()).toBe(true);
		component.setToolResultImagesVisible(false);
		expect(component.isTranscriptBlockPending()).toBe(true);
		component.updateContent(message([{ type: "text", text: "No assistant image" }]));
		expect(component.isTranscriptBlockPending()).toBe(false);
		component.updateContent(message([assistantImage]));
		expect(component.isTranscriptBlockPending()).toBe(true);
		component.setImagesVisible(false);
		expect(component.isTranscriptBlockPending()).toBe(false);
		component.setImagesVisible(true);
		expect(component.isTranscriptBlockPending()).toBe(true);
		gate.resolve(png);
		await updates.promise;
		expect(component.isTranscriptBlockPending()).toBe(false);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
		component.setToolResultImagesVisible(true);
		expect(
			component
				.render(80)
				.join("\n")
				.match(/\x1b_G/g)?.length,
		).toBeGreaterThanOrEqual(2);
		expect(encode).toHaveBeenCalledTimes(2);
	});
});
