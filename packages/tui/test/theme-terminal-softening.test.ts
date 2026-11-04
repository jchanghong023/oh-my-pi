import { describe, expect, it } from "bun:test";
import { loadTheme } from "../src/theme/loader";

describe("optional dark-terminal semantic softening", () => {
	// Resolve the real built-in palette through the same loader used by the TUI.
	it("softens semantic success and error without recoloring independent syntax or surfaces", async () => {
		const terminal = await loadTheme("dark-terminal", { mode: "truecolor" });
		for (const token of ["accent", "borderAccent", "success", "toolDiffAdded", "statusLineGitClean"] as const) {
			expect(terminal.getColorHex(token), token).toBe("#89d281");
		}
		for (const token of ["error", "toolDiffRemoved", "thinkingXhigh"] as const) {
			expect(terminal.getColorHex(token), token).toBe("#fc3a4b");
		}
		expect(terminal.fg("success", "完成")).toBe("\x1b[38;2;137;210;129m完成\x1b[39m");
		expect(terminal.fg("error", "失败")).toBe("\x1b[38;2;252;58;75m失败\x1b[39m");
		for (const [token, color] of [
			["mdHeading", "#00ff00"],
			["mdCode", "#00cc00"],
			["syntaxString", "#ff0000"],
			["syntaxNumber", "#00ff00"],
			["syntaxType", "#00ff00"],
			["border", "#00aaff"],
			["warning", "#ffff00"],
		] as const)
			expect(terminal.getColorHex(token), token).toBe(color);
		expect(terminal.getBgHex("statusLineBg")).toBe("#111111");
		expect(terminal.getBgHex("userMessageBg")).toBe("#050505");
		expect(terminal.getBgHex("toolSuccessBg")).toBe("#001100");
		expect(terminal.getBgHex("toolErrorBg")).toBe("#110000");
	});

	it("does not apply the optional terminal palette to Titanium or mutate another loaded theme", async () => {
		const titanium = await loadTheme("titanium", { mode: "truecolor" });
		const before = titanium.fg("success", "success") + titanium.fg("error", "error");
		await loadTheme("dark-terminal", { mode: "truecolor" });
		expect(titanium.getAccentColorHex()).toBe("#00b4ff");
		expect(titanium.getColorHex("success")).toBe("#00ff88");
		expect(titanium.getColorHex("error")).toBe("#ff4757");
		expect(titanium.getBgHex("statusLineBg")).toBe("#0f1216");
		expect(titanium.fg("success", "success") + titanium.fg("error", "error")).toBe(before);
	});
});
