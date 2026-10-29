import { beforeAll, describe, expect, it } from "bun:test";
import { renderComposerShapePreview } from "../src/overlays/composer-shape-preview";
import { getComposerShapeOptions, installExtensionComposerShape } from "../src/overlays/composer-shape-registry";
import { initTheme, setTheme } from "../src/theme/theme";
import { type ComposerStyle, visibleWidth } from "../src/index";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	it("resolves transparent composer preview text away from the terminal default", async () => {
		// The built-in `light` theme leaves `text` empty; a transparent shape must
		// still emit an explicit contrast foreground instead of ESC[39m, matching
		// the live editor so the preview stays readable on a light terminal.
		await setTheme("light");
		const lines = renderComposerShapePreview("box", 80);
		const term = new VirtualTerminal(80, 5);
		term.write(lines.join("\r\n"));
		// The box's content starts after its border and padding, regardless of
		// the localized preview text. Inspect the actual terminal cell, not SGR
		// text adjacent to a particular translation.
		const contentColumn = 3;
		expect(Array.from(Bun.stripANSI(term.getViewport()[1] ?? ""))[contentColumn]?.trim()).toBeTruthy();
		expect(term.getViewportRowForegroundColumns(1)).toContain(contentColumn);
		expect(term.getViewportRowBackgroundColumns(1)).not.toContain(contentColumn);
	});

	it("borrows status rows from the live status source per shape layout", async () => {
		await setTheme("dark");
		// Echo mocks: the stand-in title must be forwarded as a prop to every
		// title-bearing status call, not glued onto the rendered content.
		const status = {
			getTopBorder: (_width: number, previewTitle?: string) => {
				const content = `TOPBAR ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getStandaloneTopBorder: (_width: number, previewTitle?: string) => {
				const content = `CHIP ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getBandTopBorder: (_width: number, previewTitle?: string) => {
				const content = `BAND ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			renderBottomBar: (_width: number, groups: "left" | "full", previewTitle?: string) =>
				`BOTTOM-${groups.toUpperCase()} ${previewTitle ?? ""}`,
		};

		const box = renderComposerShapePreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR"); // embedded in the top border
		expect(box).toContain("omp"); // stand-in title forwarded to the status source
		expect(box).not.toContain("BOTTOM"); // box has no standalone bottom bar
		const band = renderComposerShapePreview("band", 80, status).join("\n");
		expect(band).toContain("BAND"); // flush band row above the prompt
		expect(band).toContain("omp");
		expect(band).not.toContain("BOTTOM"); // the band replaces the bottom bar

		const claude = renderComposerShapePreview("claude", 80, status).join("\n");
		expect(claude).toContain("CHIP"); // right group chips onto the top rule
		expect(claude).toContain("omp");
		expect(claude).toContain("BOTTOM-LEFT"); // left group only on the bottom bar

		const rule = renderComposerShapePreview("rule", 80, status);
		expect(rule.join("\n")).toContain("CHIP");
		expect(rule.join("\n")).toContain("omp");
		expect(rule.join("\n")).toContain("BOTTOM-LEFT");
		expect(rule[rule.length - 2]).toBe(""); // spacer row: rule has no bottom chrome

		const pi = renderComposerShapePreview("pi", 80, status);
		expect(pi.join("\n")).not.toContain("CHIP");
		expect(pi.join("\n")).toContain("omp");
		expect(pi.join("\n")).toContain("BOTTOM-FULL"); // both groups on the bottom bar
		expect(pi[pi.length - 2]).not.toBe(""); // bottom rule already separates the bar

		const borderless = renderComposerShapePreview("borderless", 80, status).join("\n");
		expect(borderless).toContain("omp");
		expect(borderless).toContain("BOTTOM-FULL");

		for (const shape of ["field", "rail"]) {
			const rendered = renderComposerShapePreview(shape, 80, status);
			expect(rendered.join("\n")).not.toContain("CHIP");
			expect(rendered.join("\n")).toContain("omp");
			expect(rendered.join("\n")).toContain("BOTTOM-FULL");
			expect(rendered[rendered.length - 2]).toBe(""); // spacer row before the bar
		}
	});

	it("installs extension shapes into both selectors and live rendering", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: context => context.borderColor("=".repeat(context.width)),
			renderRow: context => [context.gutter + context.text + context.pad],
			renderBottom: () => undefined,
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});

		try {
			expect(getComposerShapeOptions().some(option => option.value === style.id)).toBe(true);
			const rendered = renderComposerShapePreview("extension-dock", 76);
			expect(Bun.stripANSI(rendered[0]!)).toBe("=".repeat(76));
		} finally {
			dispose();
		}

		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});

	it("uses the full overlay width instead of clipping the status band (issue #12500)", async () => {
		await setTheme("dark");
		const status = {
			getTopBorder: (width: number) => ({ content: "", width }),
			getStandaloneTopBorder: (width: number) => ({ content: "", width }),
			getBandTopBorder: (width: number) => ({ content: " ".repeat(width - 6) + "STATUS", width }),
			renderBottomBar: () => "",
		};

		const [statusBand] = renderComposerShapePreview("band", 200, status);

		expect(visibleWidth(statusBand ?? "")).toBe(200);
		expect(statusBand).toEndWith("STATUS");
	});
});
