import type { KeybindingDefinition } from "./keybindings/tui-keybindings";
import type { StatusLineSegmentId } from "./status-line-schema";

export const FORK_KEYBINDING_DEFAULTS = {
	"app.thinking.cycle": process.platform === "darwin" ? ["alt+e", "f6"] : "alt+e",
	"app.thinking.toggle": "alt+p",
	"app.model.selectTemporary": "ctrl+t",
	"app.plan.toggle": "shift+tab",
} satisfies Record<string, KeybindingDefinition["defaultKeys"]>;

export const FORK_STATUS_LINE_GROUPS: { leftSegments: StatusLineSegmentId[]; rightSegments: StatusLineSegmentId[] } = {
	leftSegments: [
		"pi",
		"model",
		"mode",
		"collab",
		"stream",
		"path",
		"git",
		"subagents",
		"token_rate",
		"cache_hit",
		"context_pct",
		"time_spent",
	],
	rightSegments: [],
};
