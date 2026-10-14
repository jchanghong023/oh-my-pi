import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "omp.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "omp.welcome.mark" },
					c: [
						{ p: { role: "omp.welcome.wordmark" } },
						{ p: { role: "omp.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("selects the font reminder only below 10% under the unicode preset", () => {
		const preset = vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");
		const random = vi.spyOn(Math, "random").mockReturnValue(0.099);
		const welcome = new WelcomeComponent("1.0.0");
		const fontReminder = welcome.tip;

		preset.mockReturnValue("nerd");
		const standardTip = welcome.tip;
		expect(standardTip).not.toBe(fontReminder);

		preset.mockReturnValue("unicode");
		expect(welcome.tip).toBe(fontReminder);
		random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.099);
		expect(new WelcomeComponent("1.0.0").tip).toBe(standardTip);
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const welcome = new WelcomeComponent("1.0.0");
		const rows = welcome.render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The lockup is one block: the logo's bar starts it, the wordmark row ends it.
		const bar = rows.find(row => row.includes("████████████")) ?? "";
		const word = rows.find(row => row.includes("▄▀▀▄")) ?? "";
		expectCentered(indent(bar), columns - visibleWidth(word));

		// Each tip line centers on its own.
		const tipStart = rows.indexOf("");
		expect(tipStart).toBeGreaterThanOrEqual(0);
		const below = rows.slice(tipStart).filter(row => row.length > 0);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("renders expanded tip content only when the terminal meets its width boundary", () => {
		const welcome = new WelcomeComponent("1.0.0");
		Object.defineProperty(welcome, "tip", { value: "TipBoundary {tap:left}" });
		const wide = Bun.stripANSI(welcome.render(50).join("\n"));
		const narrow = Bun.stripANSI(welcome.render(49).join("\n"));
		expect(wide).toContain("TipBoundary");
		expect(wide).not.toContain("{tap:left}");
		expect(narrow).not.toContain("TipBoundary");
		expect(narrow).toContain("v1.0.0");
	});

	it("sets the version under the wordmark while the lockup fits, else keeps the logo alone", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));

		// The lockup needs 12 logo + 4 gap + 15 wordmark columns inside the 2-column margin.
		const fits = rows(33);
		const word = fits.find(row => row.includes("▄▀▀▄"));
		const version = fits.find(row => row.includes("v1.0.0"));
		expect(fits.some(row => row.includes("████████████"))).toBe(true);
		expect(version?.indexOf("v1.0.0")).toBe(word?.indexOf("▄▀▀▄"));

		const narrow = rows(32).join("\n");
		expect(narrow).toContain("████████████");
		expect(narrow).not.toContain("▄▀▀▄");
		expect(narrow).not.toContain("v1.0.0");
	});
});
