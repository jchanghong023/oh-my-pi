export interface DiscussModeState {
	enabled: boolean;
}

export const DISCUSS_TOOL_NAMES: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	web_search: true,
	ast_grep: true,
	inspect_image: true,
	ask: true,
	recall: true,
	reflect: true,
};

/** Retains approved investigation tools in their original order. */
export function filterDiscussToolNames(toolNames: readonly string[]): string[] {
	return toolNames.filter(name => DISCUSS_TOOL_NAMES[name] === true);
}
