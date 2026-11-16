import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { keyText } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { BashExecutionMessage, PythonExecutionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionStub } from "./helpers/interactive-mode-context";

describe("legacy keyText", () => {
	let previous: TuiKeybindingsManager;

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
	let mode: InteractiveMode | undefined;
	let tempDir: TempDir;
	let previousDisplayPreferences: typeof chatTranscriptDisplayPreferences;

	beforeEach(async () => {
		previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-display-execution-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		await initTheme(false);
		cfgDisplayMode.set(settings, "detailed");
	});

	afterEach(() => {
		mode?.stop();
		mode = undefined;
		tempDir.removeSync();
		resetSettingsForTest();
		setChatTranscriptDisplayPreferences(previousDisplayPreferences);
	});

	for (const language of ["bash", "python"] as const) {
		it(`keeps a running ${language} command visible through display changes and replays its completion once`, async () => {
			const messages: AgentMessage[] = [];
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
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const session = createSessionStub(sessionManager, settings, {
				agent: { state: { tools: [] } },
				customCommands: [],
				autoCompactionEnabled: true,
				systemPrompt: [],
				state: { model: undefined },
				buildTranscriptSessionContext: () => ({ messages, models: {}, injectedTtsrRules: [], mode: "none" }),
				executeBash: async (command, onChunk, options) => {
					appendOutput = onChunk;
					await completion.promise;
					const message: BashExecutionMessage = { ...result, role: "bashExecution", command, timestamp: 1 };
					messages.push(message);
					options?.onRecorded?.(message);
					return result;
				},
				executePython: async (code, onChunk, options) => {
					appendOutput = onChunk;
					await completion.promise;
					const message: PythonExecutionMessage = { ...result, role: "pythonExecution", code, timestamp: 1 };
					messages.push(message);
					options?.onRecorded?.(message);
					return result;
				},
			});
			const interactive = new InteractiveMode(session, "test");
			mode = interactive;
			interactive.ui.requestRender = vi.fn();
			const rendered = () => Bun.stripANSI(interactive.chatContainer.render(120).join("\n"));
			const running =
				language === "bash"
					? interactive.handleBashCommand("echo shell-command")
					: interactive.handlePythonCommand("print('python-command')");
			try {
				expect(session.isStreaming).toBe(false);
				expect(appendOutput).toBeFunction();
				expect(rendered()).toContain(`${language === "bash" ? "shell" : "python"}-command`);

				// Drive the rebuild used by live display settings without starting a terminal.
				cfgDisplayMode.set(settings, "clean");
				interactive.rebuildChatFromMessages();
				appendOutput?.("STREAMED_EXECUTION_OUTPUT\n");
				expect(rendered()).toContain("STREAMED_EXECUTION_OUTPUT");
				for (const display of ["compact", "detailed"] as const) {
					cfgDisplayMode.set(settings, display);
					interactive.rebuildChatFromMessages();
					expect(rendered().match(/STREAMED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				}

				completion.resolve();
				await running;
				expect(rendered().match(/COMPLETED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				for (let replay = 0; replay < 2; replay++) {
					interactive.rebuildChatFromMessages();
					expect(rendered().match(/STREAMED_EXECUTION_OUTPUT/g)).toHaveLength(1);
					expect(rendered().match(/COMPLETED_EXECUTION_OUTPUT/g)).toHaveLength(1);
				}
			} finally {
				completion.resolve();
				await running;
			}
		});
	}
});
