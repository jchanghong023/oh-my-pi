/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import { INTENT_FIELD, type TspPickerItem } from "@oh-my-pi/pi-wire";
import { findKind, mountOverlay } from "../../../helpers/overlay-terminal";
import { TreeSelector, type TreeSelectorNode } from "../../../../src/ui/overlays/pickers/tree-selector";
import { pickerSuite } from "./harness";

function build(): { roots: TreeSelectorNode[]; leaf: string } {
	let n = 0;
	const user = (text: string, parentId: string | null): TreeSelectorNode => ({
		entry: {
			type: "message",
			id: `e${n++}`,
			parentId,
			timestamp: "2026-01-01T00:00:00Z",
			message: { role: "user", content: text, timestamp: n },
		} as unknown as TreeSelectorNode["entry"],
		children: [],
	});
	const asst = (text: string, parentId: string | null): TreeSelectorNode => ({
		entry: {
			type: "message",
			id: `e${n++}`,
			parentId,
			timestamp: "2026-01-01T00:00:00Z",
			message: { role: "assistant", content: [{ type: "text", text }], timestamp: n, stopReason: "stop" },
		} as unknown as TreeSelectorNode["entry"],
		children: [],
	});
	const root = user("hello world", null);
	const a = asst("hi there 日本語 ok", root.entry.id);
	root.children.push(a);
	const b1 = user("branch one with a long long long long long long long long prompt text", a.entry.id);
	const b2 = user("branch two", a.entry.id);
	a.children.push(b1, b2);
	const c = asst("answer two", b2.entry.id);
	b2.children.push(c);
	b1.label = "mark";
	return { roots: [root], leaf: c.entry.id };
}

const noop = (): void => {};
pickerSuite({
	dir: "overlays/tree-selector",
	mount(caseName) {
		if (caseName === "empty")
			return {
				view: () => (
					<TreeSelector roots={[]} currentLeafId={null} terminalHeight={10} onSelect={noop} onCancel={noop} />
				),
			};
		const { roots, leaf } = build();
		return {
			view: () => (
				<TreeSelector
					roots={roots}
					currentLeafId={leaf}
					terminalHeight={30}
					onSelect={noop}
					onCancel={noop}
					sessionName="My session"
				/>
			),
			// The old card's filter tabs (keypath `filter`) are the picker's tabs: a tab click is `action tab`.
			steps: {
				"native select": d =>
					void d.emit({ type: "action", key: "picker", act: "tab", value: "user-only", mods: [] }),
				"native tab": d => void d.emit({ type: "action", key: "picker", act: "tab", value: "all", mods: [] }),
			},
		};
	},
});

describe("timeline tool details", () => {
	function setup() {
		const roots = build().roots;
		const parent = roots[0]!;
		const calls = parent.children[0]!;
		calls.entry = {
			...calls.entry,
			type: "message",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "Checking both sources." },
					...["alpha", "bravo"].map(name => ({
						type: "toolCall" as const,
						id: `call-${name}`,
						name: "grep",
						arguments: { pattern: name, path: `ARGS-${name}`, [INTENT_FIELD]: `Trace ${name} ownership` },
					})),
				],
			},
		} as TreeSelectorNode["entry"];
		const result = (name: string, parentId: string, isError: boolean): TreeSelectorNode => ({
			entry: {
				type: "message",
				id: name,
				parentId,
				message: {
					role: "toolResult",
					toolCallId: `call-${name}`,
					toolName: "grep",
					content: [{ type: "text", text: `RESULT-${name}\nTAIL-${name}` }],
					isError,
				},
			} as TreeSelectorNode["entry"],
			children: [],
		});
		const alpha = result("alpha", calls.entry.id, false);
		alpha.children.push(result("bravo", alpha.entry.id, true));
		calls.children = [alpha];
		const switched: string[] = [];
		const term = mountOverlay(() => (
			<TreeSelector
				roots={roots}
				currentLeafId="alpha"
				terminalHeight={40}
				onSelect={id => switched.push(id)}
				onCancel={noop}
			/>
		));
		const root = term.surface.layer()[0]!;
		const picker = findKind(root, "picker")!;
		return {
			term,
			switched,
			props: () => picker.props() as { items: TspPickerItem[]; order: string[]; selected: string },
			text: () => term.screen().join("\n"),
			selectNative: (item: string) => {
				bubbleEvent([root, picker], { type: "select", key: "picker", item });
				term.render();
			},
			detailsNative: () => {
				bubbleEvent([root, picker], { type: "action", key: "picker", act: "details", mods: [] });
				term.render();
			},
		};
	}

	test("each condensed tool row shows and searches its own recorded intent", () => {
		const h = setup();
		try {
			for (const id of ["alpha", "bravo"]) {
				const item = h.props().items.find(item => item.id === id)!;
				const label = typeof item.label === "string" ? item.label : item.label.map(span => span.t).join("");
				expect(label).toStartWith(`Trace ${id} ownership`);
				expect(label).toContain("grep");
				expect(label).not.toContain("RESULT-");
			}
			h.term.type("Trace alpha ownership");
			expect(h.props().order).toEqual(["alpha"]);
		} finally {
			h.term.dispose();
		}
	});

	test("Alt+Enter expands only the selected tool; navigation folds without switching", () => {
		const h = setup();
		try {
			h.term.press("alt+enter");
			for (const marker of ["状态：成功", "ARGS-alpha", "RESULT-alpha", "TAIL-alpha"])
				expect(h.text()).toContain(marker);
			expect(h.text()).not.toContain("RESULT-bravo");
			expect(h.switched).toEqual([]);
			h.term.press("alt+enter");
			expect(h.text()).not.toContain("RESULT-alpha");

			h.term.press("alt+enter");
			h.selectNative("bravo");
			expect(h.props().selected).toBe("bravo");
			expect(h.text()).not.toContain("RESULT-");
			h.detailsNative();
			for (const marker of ["状态：失败", "ARGS-bravo", "RESULT-bravo", "TAIL-bravo"])
				expect(h.text()).toContain(marker);
			expect(h.text()).not.toContain("RESULT-alpha");
			h.term.press("up");
			expect(h.props().selected).toBe("alpha");
			expect(h.text()).not.toContain("RESULT-");
			expect(h.switched).toEqual([]);
			h.term.press("enter");
			expect(h.switched).toEqual(["alpha"]);
			h.term.press("ctrl+o");
			expect(h.props().order).not.toContain("alpha");
			expect(h.props().order).not.toContain("bravo");
		} finally {
			h.term.dispose();
		}
	});
});
