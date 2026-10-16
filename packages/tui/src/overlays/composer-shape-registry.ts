import { type ComposerStyle, registerComposerStyle } from "../index";
import type { SubmenuOption } from "./settings-defs";

/** Composer shape id; extensions may register additional values at runtime. */
export type ComposerShape = string;

/** Built-in composer choices and their shared settings/setup copy. */
export const BUILTIN_COMPOSER_SHAPES = [
	{
		value: "band",
		label: "状态带",
		description: "弧形提示符上方的柔和端帽状态带，无边框",
	},
	{
		value: "box",
		label: "圆角框（默认）",
		description: "状态栏嵌入顶部边框，紧凑的两行提示符",
	},
	{
		value: "claude",
		label: "Claude Code",
		description: "上下为全宽横线，底部显示状态栏",
	},
	{
		value: "pi",
		label: "Pi",
		description: "带边框的横线，底部显示状态栏",
	},
	{
		value: "borderless",
		label: "无边框",
		description: "简洁的提示符，底部显示状态栏，无框线",
	},
	{
		value: "rule",
		label: "顶部横线停靠",
		description: "单条顶部横线，状态信息停靠在线上和下方",
	},
	{
		value: "field",
		label: "紧凑输入栏",
		description: "带强调色端帽的单行填充输入栏",
	},
	{
		value: "rail",
		label: "强调色侧轨",
		description: "以单条强调色侧轨锚定的单行填充输入栏",
	},
] as const;

/** Built-in composer ids used by tests and non-runtime consumers. */
export const COMPOSER_SHAPE_VALUES = BUILTIN_COMPOSER_SHAPES.map(shape => shape.value);

/** Visual composer style and selector copy registered by an extension. */
export interface ComposerShapeDefinition {
	label: string;
	description?: string;
	style: ComposerStyle;
}

const extensionComposerShapes = new Map<string, SubmenuOption>();

/** Install one extension composer shape into rendering and selector registries. */
export function installExtensionComposerShape(definition: ComposerShapeDefinition): () => void {
	const unregisterStyle = registerComposerStyle(definition.style);
	const id = definition.style.id;
	const option: SubmenuOption = {
		value: id,
		label: definition.label,
		description: definition.description,
	};
	extensionComposerShapes.set(id, option);
	return () => {
		if (extensionComposerShapes.get(id) === option) extensionComposerShapes.delete(id);
		unregisterStyle();
	};
}

/** Available built-in and extension composer choices in selector order. */
export function getComposerShapeOptions(): readonly SubmenuOption[] {
	return [...BUILTIN_COMPOSER_SHAPES, ...extensionComposerShapes.values()];
}
