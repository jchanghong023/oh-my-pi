import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";
import {
	disposeProgramStatus,
	holdBlockedStatus,
	initProgramStatus,
	setProgramStatusEnabled,
	setRunStatus,
} from "../../src/utils/run-status";
import * as titleGenerator from "../../src/utils/title-generator";
import { NativeWebGuiQuestions } from "../../src/webgui/native-interactions";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function fixture(temp: TempDir, name: string) {
	const cwd = temp.join(name);
	await fs.mkdir(cwd);
	const agentDir = temp.join(`${name}-agent`);
	const authStorage = createInMemoryAuthStorage();
	try {
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			overrides: { "compaction.enabled": false, "memory.backend": "off", "async.enabled": false },
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
			modelRegistry: new ModelRegistry(authStorage, temp.join(`${name}-models.yml`)),
			model: getTestModel("ascend"),
			bindProcessState: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		const questions = new NativeWebGuiQuestions(session);
		return {
			session,
			questions,
			async close() {
				questions.cancelPendingInteractions();
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			},
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

function requestId(questions: NativeWebGuiQuestions, prompt: string): string {
	const request = questions.pendingInteractions.find(
		interaction => interaction.payload.kind === "userInput" && interaction.payload.prompt === prompt,
	);
	if (!request) throw new Error(`Missing native question: ${prompt}`);
	return request.interactionId;
}

test("native select, askDialog and editor answers release only their matching session request and never persist secrets", async () => {
	using temp = TempDir.createSync("@pi-native-questions-");
	const a = await fixture(temp, "a");
	const b = await fixture(temp, "b").catch(async error => {
		await a.close();
		throw error;
	});
	const waits: Promise<unknown>[] = [];
	try {
		const select = a.questions.ui.select("Choose target", ["first", "second"]);
		const otherSession = b.questions.ui.select("Choose target", ["other"]);
		const editor = a.questions.ui.editor("Edit source", "initial");
		const dialog = a.questions.ui.askDialog!([
			{ id: "mode", question: "Choose modes", options: [{ label: "safe" }, { label: "fast" }], multi: true },
			{ id: "note", question: "Add note", options: [{ label: "none" }] },
		]);
		waits.push(select, otherSession, editor, dialog);
		const selectId = requestId(a.questions, "Choose target");
		await expect(b.questions.resolveInteraction(selectId, { optionId: "0" })).rejects.toThrow(
			/expired|another session/,
		);
		await expect(a.questions.resolveInteraction(selectId, { optionId: "99" })).rejects.toThrow(
			/current native option/,
		);
		await a.questions.resolveInteraction(requestId(a.questions, "Edit source"), { freeText: "edited\nsource" });
		expect(await editor).toBe("edited\nsource");
		await a.questions.resolveInteraction(requestId(a.questions, "Choose modes\nAdd note"), {
			content: { answer_0: ["safe", "fast"], answer_1: "custom note" },
		});
		expect(await dialog).toEqual({
			kind: "submit",
			results: [
				{
					id: "mode",
					question: "Choose modes",
					options: ["safe", "fast"],
					multi: true,
					selectedOptions: ["safe", "fast"],
					customInput: undefined,
				},
				{
					id: "note",
					question: "Add note",
					options: ["none"],
					multi: false,
					selectedOptions: [],
					customInput: "custom note",
				},
			],
		});
		await a.questions.resolveInteraction(selectId, { optionId: "1" });
		expect(await select).toBe("second");
		await expect(a.questions.resolveInteraction(selectId, { optionId: "0" })).rejects.toThrow(
			/expired|already answered/,
		);
		await b.questions.resolveInteraction(requestId(b.questions, "Choose target"), { optionId: "0" });
		expect(await otherSession).toBe("other");

		const secret = `native-secret-${crypto.randomUUID()}`;
		const input = a.questions.ui.input("Credential", undefined, { secret: true });
		waits.push(input);
		const credential = a.questions.pendingInteractions.find(
			interaction => interaction.interactionId === requestId(a.questions, "Credential"),
		);
		expect(credential?.payload).toMatchObject({ sensitive: true });
		await a.questions.resolveInteraction(requestId(a.questions, "Credential"), { freeText: secret });
		expect(await input).toBe(secret);
		expect(JSON.stringify(a.session.sessionManager.getEntries())).not.toContain(secret);
		expect(JSON.stringify(a.session.messages)).not.toContain(secret);
		expect(a.questions.pendingInteractions).toEqual([]);
	} finally {
		a.questions.cancelPendingInteractions();
		b.questions.cancelPendingInteractions();
		await Promise.allSettled(waits);
		try {
			await a.close();
		} finally {
			await b.close();
		}
	}
});

test("only the borrowed TUI session holds blocked status until a browser question settles", async () => {
	using temp = TempDir.createSync("@pi-native-question-status-");
	const a = await fixture(temp, "a");
	const b = await fixture(temp, "b").catch(async error => {
		await a.close();
		throw error;
	});
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const headless = setTerminalHeadless(false);
	const reports: string[] = [];
	const waits: Promise<unknown>[] = [];
	try {
		vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			const text = String(chunk);
			if (text.startsWith("\x1b]7501;")) reports.push(text);
			return true;
		});
		initProgramStatus();
		setProgramStatusEnabled(true);
		setRunStatus({ state: "working" });
		a.questions.install({ setToolUIContext: () => {}, holdBlockedStatus });
		const question = a.questions.ui.input("Choose target");
		waits.push(question);
		expect(reports.at(-1)).toContain("state=blocked:kind=question");
		const sibling = b.questions.ui.input("Independent session");
		waits.push(sibling);
		await a.questions.resolveInteraction(requestId(a.questions, "Choose target"), { freeText: "main" });
		expect(await question).toBe("main");
		expect(reports.at(-1)).toContain("state=working");
		await b.questions.resolveInteraction(requestId(b.questions, "Independent session"), { freeText: "dev" });
		expect(await sibling).toBe("dev");

		const permission = a.questions.ui.confirm("Run command", "Continue?");
		waits.push(permission);
		expect(reports.at(-1)).toContain("state=blocked:kind=permission");
		await a.questions.resolveInteraction(requestId(a.questions, "Run command\nContinue?"), { action: "decline" });
		expect(await permission).toBe(false);
		expect(reports.at(-1)).toContain("state=working");

		const timed = a.questions.ui.input("Timed question", undefined, { timeout: 1 });
		waits.push(timed);
		expect(reports.at(-1)).toContain("state=blocked:kind=question");
		expect(await timed).toBeUndefined();
		expect(reports.at(-1)).toContain("state=working");

		const controller = new AbortController();
		const cancelled = a.questions.ui.input("Cancelled question", undefined, { signal: controller.signal });
		waits.push(cancelled);
		controller.abort(new Error("stop browser question"));
		await expect(cancelled).rejects.toThrow("stop browser question");
		expect(reports.at(-1)).toContain("state=working");

		const restored = a.questions.ui.input("Question during restore");
		waits.push(restored);
		a.questions.restore();
		await expect(restored).rejects.toThrow("cancelled");
		expect(reports.at(-1)).toContain("state=working");
	} finally {
		a.questions.restore();
		a.questions.cancelPendingInteractions();
		b.questions.cancelPendingInteractions();
		await Promise.allSettled(waits);
		disposeProgramStatus();
		vi.restoreAllMocks();
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(headless);
		try {
			await a.close();
		} finally {
			await b.close();
		}
	}
});
