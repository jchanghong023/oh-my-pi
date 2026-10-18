import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { StatusLineComponent } from "../src/status-line/component";
import { parseGitStatus } from "../src/status-line/git-utils";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

function statusLine(settings: StatusLineSettings, gitEnabled = false): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

/** The `seg` facts of the composer's extras, in order. */
function facts(line: StatusLineComponent): { key: string; props: TspProps<"seg"> }[] {
	const extras = line.describeComposerFacts().extras;
	expect(extras.k).toBe("status");
	return (extras.c ?? [])
		.filter(isNode)
		.flatMap(child =>
			child.k === "seg" && child.key !== undefined ? [{ key: child.key, props: child.p ?? {} }] : [],
		);
}

function expectGitDisplay(
	branch: string | null,
	status: SegmentContext["git"]["status"],
	options: SegmentContext["options"]["git"],
	expected: string,
	dirty = true,
): void {
	const ctx = { git: { branch, status, pr: null }, options: { git: options } } as SegmentContext;
	const rendered = renderSegment("git", ctx);
	const native = describeSegment("git", ctx);
	expect(stripVTControlCharacters(rendered.content)).toBe(expected);
	expect(rendered.visible).toBe(expected.length > 0);
	if (!expected) {
		expect(native).toBeNull();
		return;
	}
	const color = dirty ? "statusLineGitDirty" : "statusLineGitClean";
	expect(rendered.content).toBe(theme.fg(color, expected));
	expect(native).toEqual({
		spans: [{ t: expected, s: color }],
		...(dirty ? { tone: "warning" } : {}),
	});
	expect(native).not.toHaveProperty("icon");
}

describe("native composer facts", () => {
	it("keeps the configured segments without another home, outer edges dropping last", () => {
		setNativeRendering(true);
		const segs = facts(
			statusLine({
				preset: "custom",
				leftSegments: ["hostname", "path", "session", "model"],
				rightSegments: ["session_name", "time", "context_pct", "cost"],
			}),
		);

		// Path goes to Tern's pane header, the session name to the tab title, the
		// model to its chip, context and cost to the hairline and usage text.
		expect(segs.map(seg => seg.key)).toEqual(["hostname", "session", "time"]);
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.hostname!).toBeGreaterThan(priority.session!);
	});

	it("reorders priorities when the configured order changes", () => {
		setNativeRendering(true);
		const segs = facts(statusLine({ preset: "custom", leftSegments: ["session", "hostname"], rightSegments: [] }));
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.session!).toBeGreaterThan(priority.hostname!);
	});

	it("keeps the git branch by the model chip, outlasting the other facts and opening /git", () => {
		setNativeRendering(true);
		const originalProjectDir = getProjectDir();
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-composer-git-"));
		try {
			// The repository's on-disk shape, written without invoking git (no hooks, signing or user config).
			const gitDir = path.join(repo, ".git");
			for (const dir of ["objects", path.join("refs", "heads")])
				fs.mkdirSync(path.join(gitDir, dir), { recursive: true });
			fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/parity\n");
			fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
			setProjectDir(repo);

			const segs = facts(
				statusLine(
					{ preset: "custom", leftSegments: ["hostname", "model", "path", "git"], rightSegments: [] },
					true,
				),
			);
			expect(segs.map(seg => seg.key)).toEqual(["hostname", "git"]);
			const [hostname, branch] = segs;
			expect(branch!.props).toMatchObject({
				spans: [{ t: "git feature/parity", s: "statusLineGitClean" }],
				actions: { click: "status.git" },
			});
			expect(branch!.props).not.toHaveProperty("icon");
			expect(branch!.props.priority!).toBeGreaterThan(hostname!.props.priority!);
		} finally {
			setProjectDir(originalProjectDir);
			removeSyncWithRetries(repo);
		}
	});

	// Two staged and three unstaged files share one path, plus one untracked file.
	const overlappingStatus = parseGitStatus("M  staged\0MM shared\0 M unstaged-a\0 M unstaged-b\0?? untracked\0");

	it.each([
		{ options: {}, expected: "git main · 改动5" },
		{ options: { showStaged: false }, expected: "git main · 改动4" },
		{ options: { showUnstaged: false }, expected: "git main · 改动3" },
		{ options: { showUntracked: false }, expected: "git main · 改动4" },
		{ options: { showStaged: false, showUnstaged: false }, expected: "git main · 改动1" },
		{ options: { showStaged: false, showUntracked: false }, expected: "git main · 改动3" },
		{ options: { showUnstaged: false, showUntracked: false }, expected: "git main · 改动2" },
		{ options: { showStaged: false, showUnstaged: false, showUntracked: false }, expected: "git main" },
	])("counts the selected file union without icons in ANSI and native: $options", ({ options, expected }) => {
		expectGitDisplay("main", overlappingStatus, options, expected);
	});

	it("shows untracked-only changes and honors their visibility option", () => {
		const status = parseGitStatus("?? one\0?? two\0");
		expectGitDisplay("main", status, {}, "git main · 改动2");
		expectGitDisplay("main", status, { showUntracked: false }, "git main");
		expectGitDisplay("main", status, { showBranch: false }, "git 改动2");
	});

	it("keeps counts without a branch and hides the segment when no selected text remains", () => {
		expectGitDisplay("main", overlappingStatus, { showBranch: false }, "git 改动5");
		expectGitDisplay(null, overlappingStatus, {}, "git 改动5");
		expectGitDisplay(
			"main",
			overlappingStatus,
			{ showBranch: false, showStaged: false, showUnstaged: false, showUntracked: false },
			"",
		);
	});

	it("omits zero counts and uses clean styling in both renderers", () => {
		const cleanStatus = parseGitStatus("");
		expectGitDisplay("main", cleanStatus, {}, "git main", false);
		expectGitDisplay("main", null, {}, "git main", false);
		expectGitDisplay("main", cleanStatus, { showBranch: false }, "", false);
		expectGitDisplay(null, cleanStatus, {}, "", false);
		expectGitDisplay(null, null, {}, "", false);
	});

	it("describes spans without ANSI escapes or separator glyphs", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "full", separator: "powerline" });
		const json = JSON.stringify(line.describeComposerFacts());
		expect(json).not.toContain("\\u001b");
		for (const glyph of ["\ue0b0", "\ue0b2", "\ue0b1", "\ue0b3", "─", "│"]) expect(json).not.toContain(glyph);
		expect(facts(line).length).toBeGreaterThan(0);
	});

	it("returns the same facts while nothing changed and new ones after a change", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: ["path", "mode"], rightSegments: [] });
		const first = line.describeComposerFacts();
		expect(line.describeComposerFacts()).toBe(first);

		line.setPlanModeStatus({ enabled: true, paused: false });
		expect(line.describeComposerFacts()).not.toBe(first);
		expect(facts(line).map(seg => seg.key)).toEqual(["mode"]);
	});
});
