import { expect, it } from "bun:test";
import * as path from "node:path";

interface PresetProbe {
	icons: (string | null)[];
	gear?: string;
	fast?: string;
	tokens: string;
	hook: string;
	raw: string[];
	original: string[];
}

interface IconProbe {
	unicode: PresetProbe;
	nerd: PresetProbe;
	ascii: PresetProbe;
	custom: { tokens: string; clear: string; hook: string };
}

it.each([
	{ offline: "0", expected: ["🧹", "🩺", "🧩", "🧭", "⏻", "🪙", "🪝"] },
	{ offline: "1", expected: ["×", "✚", "⊞", "→", "■", "#", "↪"] },
])(
	"limits legacy command, token, and Hook glyph replacements to offline Unicode mode ($offline)",
	({ offline, expected }) => {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
			import { initThemeSync, theme } from "./packages/tui/src/theme/theme.ts";
			import { getSlashCommandTypeIcon } from "./packages/tui/src/theme/tui-adapters.ts";
			import { Theme } from "./packages/tui/src/theme/theme-class.ts";
			import { SYMBOL_PRESETS } from "./packages/tui/src/theme/symbols.ts";
			const names = ["eraser", "stethoscope", "extension", "compass", "power"];
			const keys = [...names.map(name => "cmd." + name), "icon.tokens", "icon.extensionHook"];
			const result = {};
			for (const preset of ["unicode", "nerd", "ascii"]) {
				initThemeSync(preset);
				result[preset] = {
					icons: names.map(name => getSlashCommandTypeIcon(name)),
					raw: keys.map(key => theme.symbol(key)),
					original: keys.map(key => SYMBOL_PRESETS[preset][key]),
					gear: getSlashCommandTypeIcon("gear"),
					fast: getSlashCommandTypeIcon("fast"),
					tokens: theme.icon.tokens,
					hook: theme.icon.extensionHook,
				};
			}
			const custom = new Theme({}, {}, "truecolor", "unicode", {
				"icon.tokens": "T", "cmd.eraser": "C", "icon.extensionHook": "H",
			});
			result.custom = { tokens: custom.icon.tokens, clear: custom.cmd.eraser, hook: custom.icon.extensionHook };
			console.log(JSON.stringify(result));
			`,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { ...process.env, OMP_OFFLINE: offline },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		const result: IconProbe = JSON.parse(child.stdout.toString());
		expect(result.unicode.icons).toEqual(expected.slice(0, 5));
		expect(result.unicode.raw).toEqual(expected.slice());
		expect([result.unicode.tokens, result.unicode.hook]).toEqual(expected.slice(5));
		expect(result.unicode.gear).toBe("⚙");
		expect(result.unicode.fast).toBe("⚡");
		expect(result.nerd.raw).toEqual(result.nerd.original);
		expect(result.nerd.icons).toEqual(result.nerd.original.slice(0, 5));
		expect([result.nerd.tokens, result.nerd.hook]).toEqual(result.nerd.original.slice(5));
		expect(result.ascii.raw).toEqual(result.ascii.original);
		expect(result.ascii.icons).toEqual([null, null, null, null, null]);
		expect([result.ascii.tokens, result.ascii.hook]).toEqual(["tok:", "HK"]);
		expect(result.custom).toEqual({ tokens: "T", clear: "C", hook: "H" });
	},
);
