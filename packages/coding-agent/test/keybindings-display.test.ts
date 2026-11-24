import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { BashExecutionMessage, PythonExecutionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/ui/keys/format";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createSessionStub } from "./helpers/interactive-mode-context";
import { createModeTerminal, transcriptText } from "./helpers/mode-terminal";

describe("legacy keyText", () => {
	let previous: KeybindingsManager;

	beforeEach(() => {
		previous = getKeybindings();
		setKeyHintPlatform("linux");
	});

	afterEach(() => {
		setKeybindings(previous);
		setKeyHintPlatform(undefined);
	});

	it("formats the active binding for legacy extensions", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));

		expect(keyText("app.tools.expand")).toBe("Alt+E");
	});
});

describe("display rebuilds during idle user execution", () => {
	afterEach(() => resetSettingsForTest());

	it.each(["bash", "python"] as const)(
		"preserves a live %s run across rebuild and replays its result once",
		async language => {
			using tempDir = TempDir.createSync("@omp-display-execution-");
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd: tempDir.path() });
			initTheme();
			const settings = Settings.isolated();
			cfgDisplayMode.set(settings, "detailed");
			const manager = SessionManager.inMemory(tempDir.path());
			const completion = Promise.withResolvers<void>();
			let appendOutput: ((chunk: string) => void) | undefined;
			const output = "STREAMED_EXECUTION_OUTPUT\nCOMPLETED_EXECUTION_OUTPUT\n";
			const result = {
				output,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 2,
				totalBytes: output.length,
				outputLines: 2,
				outputBytes: output.length,
				displayOutputs: [],
				stdinRequested: false,
			};
			const session = createSessionStub(manager, settings, {
				executeBash: async (command, onChunk, options) => {
					appendOutput = onChunk;
					await completion.promise;
					const message: BashExecutionMessage = { ...result, role: "bashExecution", command, timestamp: 1 };
					manager.appendMessage(message);
					options?.onRecorded?.(message);
					return result;
				},
				executePython: async (code, onChunk, options) => {
					appendOutput = onChunk;
					await completion.promise;
					const message: PythonExecutionMessage = { ...result, role: "pythonExecution", code, timestamp: 1 };
					manager.appendMessage(message);
					options?.onRecorded?.(message);
					return result;
				},
			});
			const term = createModeTerminal({ settings });
			const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
			const render = () => transcriptText(mode.shell);
			const running =
				language === "bash"
					? mode.handleBashCommand("echo shell-command")
					: mode.handlePythonCommand("print('python-command')");
			try {
				expect(session.isStreaming).toBe(false);
				expect(appendOutput).toBeFunction();
				appendOutput!("STREAMED_EXECUTION_OUTPUT\n");
				for (const display of ["clean", "compact", "detailed"] as const) {
					cfgDisplayMode.set(settings, display);
					mode.rebuildChatFromMessages();
					expect(render().match(/STREAMED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				}
				completion.resolve();
				await running;
				expect(render().match(/COMPLETED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				for (let replay = 0; replay < 2; replay++) {
					mode.rebuildChatFromMessages();
					expect(render().match(/STREAMED_EXECUTION_OUTPUT/g)).toHaveLength(1);
					expect(render().match(/COMPLETED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				}
			} finally {
				completion.resolve();
				await running;
				mode.stop();
				await mode.shell.stop();
				term.dispose();
			}
		},
	);
});
