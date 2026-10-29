import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { theme } from "../src/theme";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("readToolRenderer hyperlinks", () => {
	it("links local-style read titles to the resolved filesystem path and selected line", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const handoffPath = path.resolve("/tmp/omp-local/handoff.md");
		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "second line" }],
				details: {
					resolvedPath: handoffPath,
					displayContent: { text: "second line", startLine: 2 },
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://handoff.md:2" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		const handoffUri = url.pathToFileURL(path.resolve(handoffPath)).href;
		expect(extractLinkUris(rendered)).toContain(handoffUri);
		expect(extractLinkTexts(rendered)).toContain("local://handoff.md");
		expect(extractLinkTexts(rendered)).not.toContain("local://handoff.md:2");
	});

	it("links absolute read call paths to file URIs with selector lines", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/example.ts");
		const component = readToolRenderer.renderCall(
			{ path: `${examplePath}:10-12` },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		const exampleUri = url.pathToFileURL(path.resolve(examplePath)).href;
		expect(extractLinkUris(rendered)).toContain(exampleUri);
		expect(extractLinkTexts(rendered)).toContain(examplePath);
		expect(extractLinkTexts(rendered)).not.toContain(`${examplePath}:10-12`);
	});

	it("links HTTP read result headers to the final URL", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\nhello" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("example.com /final");
		expect(extractLinkUris(rendered)).toContain("http://example.com/final");
	});
});

describe("readToolRenderer markdown content", () => {
	it("renders text/markdown details through the markdown renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("Heading");
		expect(stripped).toContain("This is bold text.");
		expect(stripped).not.toContain("# Heading");
		expect(stripped).not.toContain("**bold**");
	});

	it("keeps untagged markdown source in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});

	it("keeps raw markdown selector reads in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "# Heading\n\nThis is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md:raw" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});
});

describe("readToolRenderer error sanitization", () => {
	it("strips Windows CRLF and expands tabs in ssh failure output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		// Windows ssh emits CRLF; a raw CR styled inside the color wrap rides
		// past output-block trimming (it trims after wrapping) and moves the
		// terminal cursor mid-row, tearing the framed block.
		const component = readToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: "Failed to start SSH master for can.internal: The fingerprint for the ED25519 key sent by the remote host is\r\nSHA256:abc\tdef\r\nAdd correct host key in /root/.ssh/known_hosts to get rid of this message.\r\nHost key verification failed.",
					},
				],
				isError: true,
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "ssh://can.internal/root/arc-smp-values.yaml" },
		);

		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		const stripped = Bun.stripANSI(raw);
		expect(stripped).toContain("SHA256:abc");
		expect(stripped).toContain("Host key verification failed.");
	});

	it("sanitizes URL read errors the same way", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "fetch failed:\tconn reset\r\nby peer" }],
				isError: true,
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/file" },
		);

		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		expect(Bun.stripANSI(raw)).toContain("fetch failed:");
	});
});

describe("readToolRenderer success-path sanitization", () => {
	it("expands tabs in URL content previews", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\ncol1\tcol2\nrow2" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const raw = component.render(200).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		expect(Bun.stripANSI(raw)).toContain("col1");
	});

	it("expands tabs in image detail lines", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [
					{ type: "text", text: "a\tb" },
					{ type: "image", data: "", mimeType: "image/png" },
				],
				details: { contentType: "image/png" },
				isError: false,
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://shot.png" },
		);

		const raw = component.render(100).join("\n");
		expect(raw).not.toContain("\t");
		expect(raw).not.toContain("\r");
		expect(Bun.stripANSI(raw)).toContain("a");
	});

	it("shortens the home directory in resolved path notices", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const notesPath = path.join(os.homedir(), "notes.txt");
		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "note contents" }],
				details: {
					resolvedPath: notesPath,
					displayContent: { text: "note contents", startLine: 1 },
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://notes.txt" },
		);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		// `shortenPath` normalizes separators to `/`, so the notice reads the same
		// on Windows.
		expect(rendered).toContain("Resolved path: ~/notes.txt");
		expect(rendered).not.toContain(os.homedir());
	});
});

describe("compact grouped read warnings", () => {
	it("projects corrected paths and conflict counts consistently across terminal and native views", () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		try {
			const cases = [
				{ intent: "", details: {}, summary: "input", warning: false },
				{ intent: "Inspect source", details: {}, summary: "Inspect source", warning: false },
				{
					intent: "",
					details: { suffixResolution: { from: "src/input", to: "src/input.ts" } },
					summary: "src/input.ts · corrected from src/input",
					warning: true,
				},
				{
					intent: "Inspect source",
					details: { suffixResolution: { from: "src/input", to: "src/input.ts" }, conflictCount: 1 },
					summary: "src/input.ts · corrected from src/input · 1 conflict · Inspect source",
					warning: true,
				},
				{
					intent: "",
					details: { conflictCount: 1 },
					summary: "src/input · 1 conflict",
					warning: true,
				},
				{
					intent: "Inspect source",
					details: { conflictCount: 2 },
					summary: "src/input · 2 conflicts · Inspect source",
					warning: true,
				},
			];
			for (const test of cases) {
				const group = new ReadToolGroupComponent();
				const args = { path: "src/input", i: test.intent };
				group.updateArgs(args, "read");
				group.updateResult(
					{ content: [{ type: "text", text: "file contents" }], details: test.details },
					false,
					"read",
				);
				const ansi = group.render(200).join("\n");
				const fallback = JSON.stringify(
					group.describe({
						cols: 200,
						reduceMotion: false,
						dark: true,
						supports: () => false,
						feature: () => false,
					}),
				);
				const dataFirst = JSON.stringify(
					group.describe({
						cols: 200,
						reduceMotion: false,
						dark: true,
						supports: () => true,
						feature: () => true,
					}),
				);
				expect(Bun.stripANSI(ansi)).toContain(test.summary);
				expect(fallback).toContain(test.summary);
				expect(dataFirst).toContain(test.summary);
				if (test.warning) {
					expect(ansi).toContain(theme.fg("warning", "警告 · "));
					expect(fallback).toContain('"warning"');
					expect(dataFirst).toContain('"tone":"warning"');
				} else {
					expect(Bun.stripANSI(ansi)).toContain("完成");
					expect(dataFirst).not.toContain('"tone":"warning"');
				}
			}
			const narrow = new ReadToolGroupComponent({ showContentPreview: true });
			narrow.updateArgs({ path: "src/deep/input" }, "read");
			narrow.updateResult(
				{
					content: [{ type: "text", text: "full source content" }],
					details: { suffixResolution: { from: "src/deep/input", to: "src/deep/input.ts" } },
				},
				false,
				"read",
			);
			expect(Bun.stripANSI(narrow.render(20).join("\n"))).not.toContain("full source content");
			narrow.setExpanded(true);
			expect(Bun.stripANSI(narrow.render(80).join("\n"))).toContain("full source content");
		} finally {
			setChatTranscriptDisplayPreferences(preferences);
		}
	});

	it("hides ordinary grouped read errors until expanded", () => {
		const preferences = { ...chatTranscriptDisplayPreferences };
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		try {
			const group = new ReadToolGroupComponent({ showContentPreview: true });
			const args = { path: "src/missing", i: "Inspect source" };
			group.updateArgs(args, "read");
			group.updateResult(
				{
					content: [{ type: "text", text: "READ FAILURE: original diagnostic" }],
					details: { suffixResolution: { from: "src/missing", to: "src/missing.ts" }, conflictCount: 1 },
					isError: true,
				},
				false,
				"read",
			);
			expect(Bun.stripANSI(group.render(200).join("\n"))).not.toContain("READ FAILURE: original diagnostic");
			expect(
				JSON.stringify(
					group.describe({
						cols: 200,
						reduceMotion: false,
						dark: true,
						supports: () => true,
						feature: () => true,
					}),
				),
			).not.toContain("READ FAILURE: original diagnostic");
			group.setExpanded(true);
			expect(Bun.stripANSI(group.render(200).join("\n"))).toContain("READ FAILURE: original diagnostic");
		} finally {
			setChatTranscriptDisplayPreferences(preferences);
		}
	});
});
