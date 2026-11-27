/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { createSurface, settle } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { ToolActivity } from "../../../../src/ui/transcript/messages/panel";
import { UserMessage, type UserMessageModel } from "../../../../src/ui/transcript/messages/user-message";
import { screenSuite, single } from "./harness";

interface UserInputs {
	text: string;
	options: {
		images?: { type: "image"; mimeType: string; data: string }[];
		imageLinks?: string[];
		timestamp?: number;
		liveSteered?: boolean;
		synthetic?: boolean;
		skillPath?: Record<string, string>;
	};
	transcriptActions: boolean;
}

/** The 1×1 PNG the capture attached (`"1x1 png"` in the inputs). */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

screenSuite("user-message", corpusCase => {
	const inputs = corpusCase.inputs as UserInputs;
	const o = inputs.options;
	const reaction = signal<string | undefined>(undefined);
	const zones = signal(true);
	const height = signal<number | undefined>(undefined);
	const model: UserMessageModel = {
		text: inputs.text,
		images: o.images?.map(image => ({
			...image,
			data: image.data === "1x1 png" ? PNG_1X1 : image.data,
		})),
		imageLinks: o.imageLinks,
		timestamp: o.timestamp,
		liveSteered: o.liveSteered,
		synthetic: o.synthetic,
		skillPath: o.skillPath ? name => o.skillPath?.[name] : undefined,
		reaction,
		actions: inputs.transcriptActions,
		promptZones: zones,
	};
	return {
		node: single(<UserMessage model={model} />),
		height: height,
		apply(label) {
			if (label.startsWith("reaction ")) reaction.set(label.slice("reaction ".length));
			else if (label === "allocation 1 row") height.set(1);
			else if (label === "allocation 2 rows") height.set(2);
			else if (label === "allocation unlimited") height.set(undefined);
			else if (label === "prompt zones off") zones.set(false);
			else if (label === "prompt zones on") zones.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});

test("keeps a long user message and its native toolbar intact while tool activity is hidden", () => {
	createRoot(dispose => {
		try {
			const activity = signal(true);
			const actions: string[] = [];
			const text = Array.from({ length: 24 }, (_, i) => `row-${i}`).join("\n");
			const root = single(
				<col>
					<UserMessage model={{ text, actions: true, timestamp: 1, onAction: act => actions.push(act) }} />
					<ToolActivity visible={activity}>
						<text text="running a tool" />
					</ToolActivity>
				</col>,
			);
			const user = root.children()[0]!;
			const env = staticEnvironment(PLAIN_THEME);
			const rows = () => paintNode(env, user, 120).rows;
			const full = rows();
			expect(Bun.stripANSI(full.join("\n"))).toContain("row-23");
			expect(Bun.stripANSI(paintNode(env, root, 120).rows.join("\n"))).toContain("running a tool");
			for (const visible of [true, false]) {
				activity.set(visible);
				expect(rows()).toEqual(full);
				const native = JSON.stringify(describeTree(user, env));
				expect(native).toContain("row-23");
				expect(native).toContain("omp.user.tools");
				expect(native).toContain('"click":"copy-message"');
				expect(native).toContain('"id":"rewind-turn"');
				user.handlers.onAction?.("copy-message", {
					type: "action",
					key: "tools/copy",
					act: "copy-message",
					mods: [],
				});
			}
			expect(Bun.stripANSI(paintNode(env, root, 120).rows.join("\n"))).not.toContain("running a tool");
			expect(actions).toEqual(["copy-message", "copy-message"]);
		} finally {
			dispose();
		}
	});
});

test("emits complete OSC 133 zones only on first retirement, not during viewport or history redraws", async () => {
	const term = memoryTerminal({ columns: 40, rows: 8 });
	const driver = createTerminalDriver(term.options);
	const rebuilt = signal(false);
	const dock = signal<readonly string[]>([]);
	const first = { text: "first prompt", promptZoneKey: {} };
	const surface = createSurface(() => ({
		main: () =>
			rebuilt()
				? [
						<UserMessage key="rebuilt" model={first} />,
						<UserMessage key="suppressed" model={{ text: "unmarked prompt", promptZones: false }} />,
						<UserMessage key="new" model={{ text: "next prompt" }} />,
					]
				: <UserMessage key="original" model={first} />,
		dock: <rows lines={dock} />,
	}));
	const backend = new TermBackend({ surface, driver, theme: () => PLAIN_THEME });
	const output = () => term.output.join("");
	const reset = () => {
		driver.resetDisplay();
		backend.renderNow();
	};
	try {
		await driver.start();
		backend.start();
		for (let i = 0; i < 5; i++) reset();
		expect(output()).toContain("first prompt");
		expect(output()).not.toContain("\x1b]133;");

		// The top two rows enter history; the bubble's bottom padding is still live.
		settle(surface.main()[0]!);
		dock.set(["1", "2", "3", "4", "5", "6", "7"]);
		backend.renderNow();
		const zones = () =>
			Array.from(output().matchAll(/\x1b]133;A\x07\x1b]133;B\x07(.*?)\x1b]133;C\x07\x1b]133;D;0\x07/g), match =>
				Bun.stripANSI(match[1]!).trim(),
			);
		expect(zones()).toEqual(["first prompt"]);

		reset(); // Rewrites the partially retired bubble at the head of the viewport.
		rebuilt.set(true); // A transcript rebuild can also remount the same message.
		reset();
		backend.flush();
		expect(zones()).toEqual(["first prompt", "next prompt"]);
		expect(output().match(/\x1b]133;[ABCD]/g)).toHaveLength(8);
	} finally {
		backend.stop();
		await driver.stop();
		surface.dispose();
	}
});
