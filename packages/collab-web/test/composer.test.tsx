import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import type { CollabCommandInfo } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import type { GuestSnapshot } from "../src/lib/client";
import { GuestClient } from "../src/lib/client";
import { Composer, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { completionItems, directoryArgument } from "../src/lib/completion";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function snapshot(uiRequest: GuestSnapshot["uiRequest"]): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest,
		commands: [],
		notices: [],
	};
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer
				client={client}
				snapshot={snapshot({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })}
			/>,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer client={client} snapshot={snapshot({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});

describe("composer slash completion", () => {
	// The Composer renders exactly these items and applies `insert` on Tab and
	// on click, so the menu contents and the completed text are this function's
	// observable contract.
	const commands: CollabCommandInfo[] = [
		{ name: "dump", description: "Return full transcript", input: { hint: "[raw]" } },
		{ name: "model", aliases: ["models"], description: "Switch model" },
		{ name: "skill:reviewer", description: "Review the current diff" },
	];

	it("offers matching commands for a slash prefix and completes with a trailing space", () => {
		const items = completionItems("/du", commands, []);

		expect(items.map(item => item.label)).toEqual(["/dump"]);
		expect(items[0]).toMatchObject({ insert: "/dump ", hint: "[raw]", description: "Return full transcript" });
	});

	it("matches aliases and badges skill commands", () => {
		expect(completionItems("/mod", commands, []).map(item => item.label)).toEqual(["/model"]);
		expect(completionItems("/skill", commands, []).map(item => [item.label, item.badge])).toEqual([
			["/skill:reviewer", "skill"],
		]);
	});

	it("stops completing once the command's arguments start", () => {
		expect(completionItems("/dump raw", commands, [])).toEqual([]);
	});

	it("offers host directories for /move and completes to the absolute path", () => {
		const dirs = [{ path: "/tmp/sub", label: "sub/" }];

		expect(directoryArgument("/move su")).toEqual({ command: "move", prefix: "su" });
		expect(directoryArgument("/add-dir ")).toEqual({ command: "add-dir", prefix: "" });
		const items = completionItems("/move su", commands, dirs);
		expect(items.map(item => item.label)).toEqual(["sub/"]);
		expect(items[0]).toMatchObject({ insert: "/move /tmp/sub", description: "/tmp/sub" });
	});

	it("keeps other commands' arguments out of the directory source", () => {
		expect(directoryArgument("/dump /tmp")).toBeNull();
		expect(completionItems("/dump /tmp", commands, [{ path: "/tmp", label: "tmp/" }])).toEqual([]);
	});
});
