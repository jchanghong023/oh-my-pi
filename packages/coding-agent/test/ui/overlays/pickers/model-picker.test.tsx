/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { KeyId } from "../../../../src/config/keybindings/key-id";
import { formatModelStringWithRouting, resolveModelRoleValue } from "../../../../src/config/model-resolver";
import type { ModelPickerOptions, ResolvedRoleModel } from "../../../../src/modes/view-model/overlays/model-picker";
import { ModelPicker, type ModelPickerRegistry } from "../../../../src/ui/overlays/pickers/model-picker";
import type { ConfiguredThinkingLevel } from "../../../../src/utils/render-utils";
import { mountOverlay } from "../../../helpers/overlay-terminal";
import { type Driver, pickerSuite } from "./harness";
import { model, MODELS, source } from "./model-fixtures";

function registry(models: Model[], refresh: () => Promise<boolean>): ModelPickerRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		refreshIfStale: refresh,
	};
}

const quickRoles: ResolvedRoleModel[] = [
	{ role: "default", model: MODELS[2]!, explicitThinkingLevel: false },
	{ role: "smol", model: MODELS[5]!, explicitThinkingLevel: true, thinkingLevel: "low" as ConfiguredThinkingLevel },
	{ role: "slow", model: MODELS[1]!, explicitThinkingLevel: false },
];

const full: ModelPickerOptions = {
	currentSelector: "demo/demo",
	currentContextTokens: 150_000,
	quickRoles,
	quickRoleOrder: ["default", "smol", "slow", "missing"],
	currentQuickRole: "smol",
	taskModeKeys: ["alt+p" as KeyId],
	taskSelector: "openai/gpt-5.6",
	thinkingLevelFor: () => "high" as ConfiguredThinkingLevel,
};

const CASES: Readonly<
	Record<string, { options: ModelPickerOptions; rows?: number; models?: Model[]; refresh?: () => Promise<boolean> }>
> = {
	"full-options": { options: full },
	"minimal-options": { options: {} },
	"short-terminal-no-quick-roles": { options: { ...full, quickRoles: [] }, rows: 10 },
	"refresh-fails": {
		options: full,
		refresh: async () => {
			throw new Error("models.yml: bad provider");
		},
	},
	"no-models": { options: full, models: [] },
};

const action =
	(act: string, value?: string) =>
	(d: Driver): void =>
		void d.emit({ type: "action", key: "", act, mods: [], ...(value !== undefined ? { value } : {}) });
const event =
	(type: "select" | "activate", item: string, key = "") =>
	(d: Driver): void =>
		void d.emit({ type, key, item });

pickerSuite({
	dir: "overlays/model-picker",
	mount(caseName) {
		const spec = CASES[caseName]!;
		const log: string[] = [];
		const settings = source({ default: "demo/demo", smol: "openai/gpt-5.6-mini" }, ["demo/demo", "openai/gpt-5.6"]);
		const models = spec.models ?? MODELS;
		return {
			view: () => (
				<ModelPicker
					source={settings}
					registry={registry(models, spec.refresh ?? (async () => false))}
					scopedModels={models.map(entry => ({ model: entry }))}
					callbacks={{
						onPick: (_m, selector, meta) =>
							log.push(`pick:${selector}:${meta.overContext}:${meta.thinkingLevel ?? "-"}`),
						onPickRole: entry => log.push(`role:${entry.role}`),
						onPickTask: (_m, selector) => log.push(`task:${selector}`),
						onKeepThinking: level => log.push(`keep:${level}`),
						onCancel: () => log.push("cancel"),
					}}
					options={spec.options}
					terminalRows={() => spec.rows ?? 40}
				/>
			),
			steps: {
				tick: () => Bun.sleep(0),
				"scope openai": action("scope", "provider:openai"),
				"scope bogus": action("scope", "provider:nope"),
				"select mini": event("select", "openai/gpt-5.6-mini"),
				"level low": action("level", "low"),
				"level bogus": action("level", "bogus"),
				"scope openai again → all": action("scope", "provider:openai"),
				"select tiny (no reasoning)": event("select", "local/tiny"),
				"level on frozen": action("level", "low"),
				"select demo-lite": event("select", "demo/demo-lite"),
				"task on": action("task"),
				"activate in task mode": event("activate", "anthropic/claude-opus-5"),
				"task off": action("task"),
				"typed query": d => {
					d.press("c");
					d.press("l");
				},
				clear: action("clear"),
				"clear empty": action("clear"),
				"activate demo": event("activate", "demo/demo"),
				"foreign key event": event("select", "demo/demo", "elsewhere"),
				close: action("close"),
			},
		};
	},
});

test.each([
	["inherits the exact current model", false],
	["resolves a bare Task override", true],
] as const)("model picker: Task mode %s despite a colliding selector", (_label, hasOverride) => {
	const pinned = resolveModelRoleValue("openrouter/vendor/model@cerebras", [
		model("openrouter", "vendor/model"),
	]).model!;
	const literal = model("openrouter", "vendor/model@cerebras");
	const selector = formatModelStringWithRouting(pinned);
	expect(formatModelStringWithRouting(literal)).toBe(selector);
	const models = [pinned, literal];
	const picked: Array<[Model, string]> = [];
	const taskPicks: Array<[Model, string]> = [];
	const term = mountOverlay(() => (
		<ModelPicker
			source={{ ...source({}, []), resolveRoleValue: (value, pool) => resolveModelRoleValue(value, pool) }}
			registry={registry(models, async () => false)}
			scopedModels={models.map(model => ({ model }))}
			currentModel={hasOverride ? literal : pinned}
			options={{
				currentSelector: selector,
				taskModeKeys: ["alt+p"],
				taskSelector: hasOverride ? "openrouter/vendor/model" : undefined,
			}}
			callbacks={{
				onPick: (model, value) => picked.push([model, value]),
				onPickTask: (model, value) => taskPicks.push([model, value]),
				onCancel: () => {},
			}}
		/>
	));
	try {
		const picker = term.surface.layer()[0]!;
		const props = () => picker.props() as TspPickerProps;
		const keys = props().order!.filter((item): item is string => typeof item === "string");
		expect(keys).toHaveLength(2);
		expect(keys).toContain(selector);
		const routedKey = keys.find(key => key !== selector)!;
		expect(routedKey).toBeDefined();
		const currentKey = hasOverride ? selector : routedKey;
		expect(props()).toMatchObject({ current: [currentKey], selected: currentKey });

		bubbleEvent([picker], { type: "activate", key: "", item: routedKey });
		bubbleEvent([picker], { type: "activate", key: "", item: selector });
		expect(picked.map(([, value]) => value)).toEqual([selector, selector]);
		expect(picked[0]?.[0]).toBe(pinned);
		expect(picked[1]?.[0]).toBe(literal);

		bubbleEvent([picker], { type: "action", key: "", act: "task", mods: [] });
		expect(props()).toMatchObject({ current: [routedKey], selected: routedKey });
		term.press("enter");
		expect(taskPicks[0]?.[0]).toBe(pinned);
		expect(taskPicks[0]?.[1]).toBe(selector);
	} finally {
		term.dispose();
	}
});
