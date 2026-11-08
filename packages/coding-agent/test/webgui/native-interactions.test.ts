import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { NativeWebGuiQuestions, withNativeWebGuiInteractionScope } from "../../src/webgui/native-interactions";
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

test("browser actions reject other clients, late and duplicate answers; disconnect and abort release native waiters", async () => {
	using temp = TempDir.createSync("@pi-native-action-scope-");
	const a = await fixture(temp, "a");
	const b = await fixture(temp, "b").catch(async error => {
		await a.close();
		throw error;
	});
	const origin = { connectionId: crypto.randomUUID(), clientId: "tab-a" };
	const waits: Promise<unknown>[] = [];
	try {
		const first = withNativeWebGuiInteractionScope(origin, () =>
			a.questions.browserAction({ action: "copyText", text: "first" }),
		);
		waits.push(first);
		const firstId = requestId(a.questions, "copyText");
		expect(a.questions.pendingInteractionsFor({ ...origin, clientId: "tab-b" })).toEqual([]);
		await expect(b.questions.resolveInteraction(firstId, { action: "accept" }, origin)).rejects.toThrow(
			/expired|another session/,
		);
		await expect(
			a.questions.resolveInteraction(firstId, { action: "accept" }, { ...origin, clientId: "tab-b" }),
		).rejects.toThrow(/expired|another session/);
		await expect(
			a.questions.resolveInteraction(firstId, { action: "accept" }, { ...origin, connectionId: "other-connection" }),
		).rejects.toThrow(/expired|another session/);
		await a.questions.resolveInteraction(firstId, { action: "accept", content: { applied: true } }, origin);
		await first;
		const second = withNativeWebGuiInteractionScope(origin, () =>
			a.questions.browserAction({ action: "copyText", text: "second" }),
		);
		waits.push(second);
		const secondId = requestId(a.questions, "copyText");
		await expect(a.questions.resolveInteraction(firstId, { action: "accept" }, origin)).rejects.toThrow(
			/expired|already answered/,
		);
		a.questions.cancelConnectionActions(origin.connectionId);
		await expect(second).rejects.toThrow(/connection closed/);
		await expect(a.questions.resolveInteraction(secondId, { action: "accept" }, origin)).rejects.toThrow(
			/expired|already answered/,
		);

		const controller = new AbortController();
		const editor = a.questions.ui.editor("Abort edit", "draft", { signal: controller.signal });
		waits.push(editor);
		const editorId = requestId(a.questions, "Abort edit");
		controller.abort(new Error("Editor cancelled"));
		await expect(editor).rejects.toThrow("Editor cancelled");
		await expect(a.questions.resolveInteraction(editorId, { freeText: "too late" })).rejects.toThrow(
			/expired|cancelled/,
		);
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
