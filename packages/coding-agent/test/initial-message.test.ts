import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildInitialMessage } from "@oh-my-pi/pi-coding-agent/cli/initial-message";

function createArgs(messages: string[]): Args {
	return {
		messages,
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

describe("buildInitialMessage", () => {
	it("combines stdin, file text, and the first CLI message", () => {
		const parsed = createArgs(["first", "second"]);
		const images: ImageContent[] = [{ type: "image", data: "abc123", mimeType: "image/png" }];

		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin",
			fileText: "file-",
			fileImages: images,
		});

		expect(result.initialMessage).toBe("stdin\nfile-first");
		expect(result.initialImages).toEqual(images);
		expect(parsed.messages).toEqual(["second"]);
	});

	it("leaves plain CLI messages untouched when there is no initial file or stdin input", () => {
		const parsed = createArgs(["first", "second"]);

		const result = buildInitialMessage({ parsed });

		expect(result.initialMessage).toBeUndefined();
		expect(result.initialImages).toBeUndefined();
		expect(parsed.messages).toEqual(["first", "second"]);
	});

	it("keeps a slash command as a CLI message when @file is empty", () => {
		const message = "/review file.ts";
		const parsed = createArgs([message, "second"]);

		const result = buildInitialMessage({ parsed, fileText: "", fileImages: [] });

		expect(result.initialMessage).toBeUndefined();
		expect(result.initialImages).toBeUndefined();
		expect(parsed.messages).toEqual([message, "second"]);
	});

	it("still combines the first CLI message with images when @file text is empty", () => {
		const parsed = createArgs(["first", "second"]);
		const images: ImageContent[] = [{ type: "image", data: "abc123", mimeType: "image/png" }];

		const result = buildInitialMessage({ parsed, fileText: "", fileImages: images });

		expect(result.initialMessage).toBe("first");
		expect(result.initialImages).toEqual(images);
		expect(parsed.messages).toEqual(["second"]);
	});
});
