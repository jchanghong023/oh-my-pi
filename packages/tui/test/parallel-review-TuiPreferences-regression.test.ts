import { beforeAll, expect, test } from "bun:test";
import { getComposerStyle } from "../src/components/composer";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

test("box status moves below the editor when chrome consumes its entire top-border budget", () => {
	const status = createStartupStatusLine({
		settings: {
			preset: "custom",
			leftSegments: ["status"],
			rightSegments: [],
			showHookStatus: false,
			sessionAccent: false,
		},
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
	try {
		status.setComposerStyle(getComposerStyle("box"));
		status.setHookStatus("job", "OK");
		status.setTopBorderWidthProvider(() => 0);

		expect(status.getTopBorder(0).content).toBe("");
		const wrapped = status.render(6);
		expect(Bun.stripANSI(wrapped.join("\n"))).toContain("OK");
		expect(wrapped.every(line => visibleWidth(line) <= 6)).toBe(true);

		status.setTopBorderWidthProvider(() => 20);
		expect(Bun.stripANSI(status.getTopBorder(20).content)).toContain("OK");
		expect(status.render(20)).toEqual([]);
	} finally {
		status.dispose();
	}
});
