/**
 * `composer/welcome` corpus: tip rolls, version changes and the intro animation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, jsx, onCleanup } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { CORPUS_DIR, CORPUS_NOW, type CorpusCase, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { TspText } from "@oh-my-pi/pi-wire";
import "../../../src/ui/styles/welcome";
import { welcomeTip } from "../../../src/ui/welcome/tips";
import { Welcome, WelcomeModel } from "../../../src/ui/welcome/welcome";
import { caseFiles, checkStagedCase } from "../status/corpus-suite";

interface WelcomeInputs {
	readonly version: string;
	/** `{ nagRoll, tipRoll }`, or one roll for both. */
	readonly random: number | { readonly nagRoll: number; readonly tipRoll: number };
	/** Historical capture steps for the removed automatic self-updater. */
	readonly updates?: readonly [string, unknown][];
}

const SCREEN = "composer/welcome";
// Captured on macOS (modifier keycaps) under the unicode symbol preset, classic renderer.
const keys = () => ({ preset: "unicode", platform: "darwin" }) as const;

interface CapturedNode {
	readonly p?: { readonly role?: string; readonly text?: string; readonly spans?: { readonly t: string }[] };
	readonly c?: readonly CapturedNode[];
}

function childWithRole(native: unknown, role: string): CapturedNode | undefined {
	if (!native || typeof native !== "object") return undefined;
	return (native as CapturedNode).c?.find(child => child.p?.role === role);
}

function englishTipStart(rows: readonly string[]): number {
	return rows.findIndex(row => Bun.stripANSI(row).trimStart().startsWith("Tip: "));
}

function isEnglishCapture(corpus: CorpusCase): boolean {
	return corpus.stages.some(stage => {
		const tip = childWithRole(stage.native, "omp.welcome.tip");
		const body = childWithRole(tip, "omp.welcome.tip-text")?.p;
		const text = body?.text ?? body?.spans?.map(span => span.t).join("");
		return (
			(!!text && !/\p{Script=Han}/u.test(text)) || Object.values(stage.rows).some(rows => englishTipStart(rows) >= 0)
		);
	});
}

// Historical tips are covered with the current rendered text below. Keep the
// exact lockup, version and animation comparisons on the untranslated captures.
function withoutEnglishTips(corpus: CorpusCase): CorpusCase {
	return {
		...corpus,
		stages: corpus.stages.map(stage => {
			const tip = childWithRole(stage.native, "omp.welcome.tip");
			const native = stage.native as CapturedNode;
			const rows = Object.fromEntries(
				Object.entries(stage.rows).map(([width, lines]) => {
					const start = englishTipStart(lines);
					if (start < 0) return [width, lines];
					// The blank row immediately before the label separates the tip from the lockup.
					const separator = start > 0 && !Bun.stripANSI(lines[start - 1]!).trim() ? start - 1 : start;
					return [width, lines.slice(0, separator)];
				}),
			);
			return {
				...stage,
				native: tip ? { ...native, c: native.c?.filter(child => child !== tip) } : stage.native,
				rows,
			};
		}),
	};
}

function build(corpus: CorpusCase, env: StaticEnvironment, showTip: boolean) {
	const inputs = corpus.inputs as WelcomeInputs;
	const rolls = typeof inputs.random === "number" ? { nagRoll: inputs.random, tipRoll: inputs.random } : inputs.random;
	const tip = showTip ? welcomeTip({ ...rolls, preset: "unicode", tern: false }) : undefined;
	const model = new WelcomeModel(inputs.version);
	onCleanup(() => model.stopIntro());
	const steps = new Map<string, () => void>([
		["prerelease version", () => model.version.set("14.2.0-beta.1")],
		["t=0", () => model.playIntro(CORPUS_NOW)],
		["settled", () => model.stopIntro()],
	]);
	return {
		tree: jsx(Welcome, { version: model.version, tip: () => tip, keys, introStart: model.introStart }),
		step(label: string) {
			const frame = /^t=(\d+)$/.exec(label);
			if (frame && label !== "t=0") return env.setNow(CORPUS_NOW + Number(frame[1]));
			const step = steps.get(label);
			if (!step) throw new Error(`welcome: unknown stage ${label}`);
			step();
		},
	};
}

const files = caseFiles(SCREEN);
describe.skipIf(files.length === 0)(`${SCREEN} corpus`, () => {
	for (const file of files) {
		const capture = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, SCREEN, file), "utf8")) as CorpusCase;
		const english = isEnglishCapture(capture);
		const updates = (capture.inputs as WelcomeInputs).updates;
		const results = checkStagedCase(
			english ? withoutEnglishTips(capture) : capture,
			(corpus, env) => build(corpus, env, !english),
			(corpus, index) => updates?.some(([label]) => label === corpus.stages[index]?.label) ?? false,
		);
		for (const { label, failures } of results) {
			test(`${file} · ${label}`, () => expect(failures).toEqual([]));
		}
	}
});

const translatedTips: readonly {
	name: string;
	tip: string | undefined;
	body: TspText;
	row: string;
	newTag?: string;
}[] = [
	{
		name: "font reminder retains the English font name",
		tip: welcomeTip({ nagRoll: 0, tipRoll: 0, preset: "unicode", tern: false }),
		body: "请使用 Nerd Font 字体。",
		row: "提示：请使用 Nerd Font 字体。",
	},
	{
		name: "localized tip retains the Tern label and URL",
		tip: welcomeTip({ nagRoll: 0.5, tipRoll: 0.99, preset: "unicode", tern: false }),
		body: [{ t: "悄悄告诉你，OMP 有它的自然栖息地：" }, { t: "tern", s: "link", href: "https://scl.so/tern" }],
		row: "提示：悄悄告诉你，OMP 有它的自然栖息地：tern (https://scl.so/tern)",
	},
	{
		name: "localized tip expands the Mac shortcut and translates the new tag",
		tip: "按 {key:ctrl+r} 搜索输入历史，复用过去的消息。 [NEW]",
		body: "按 ⌃R 搜索输入历史，复用过去的消息。",
		row: "提示：按 ⌃R 搜索输入历史，复用过去的消息。 新功能",
		newTag: "新功能",
	},
];

for (const { name, tip, body, row, newTag } of translatedTips) {
	test(name, () => {
		createRoot(dispose => {
			try {
				const env = staticEnvironment(PLAIN_THEME);
				const tree = jsx(Welcome, { version: () => "14.2.0", tip: () => tip, keys, introStart: () => null });
				if (!isUiNode(tree)) throw new Error("Expected the welcome card");
				const nativeTip = childWithRole(describeTree(tree, env), "omp.welcome.tip");
				const text = childWithRole(nativeTip, "omp.welcome.tip-text")?.p;
				expect<TspText | undefined>(text?.text ?? text?.spans).toEqual(body);
				expect(childWithRole(nativeTip, "omp.welcome.new")?.p?.text).toBe(newTag);

				const rows = (width: number) => paintNode(env, tree, width).rows.map(line => Bun.stripANSI(line).trim());
				expect(rows(80).at(-1)).toBe(row);
				expect(rows(49).join("\n")).not.toContain("提示：");
			} finally {
				dispose();
			}
		});
	});
}
