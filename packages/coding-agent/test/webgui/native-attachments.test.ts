import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readImageMetadata, TempDir } from "@oh-my-pi/pi-utils";
import {
	closeNativeAttachments,
	createNativeAttachmentMethods,
	resolveNativeAttachments,
	resolveNativeFileContexts,
	type ResolvedAttachments,
} from "../../src/webgui/native-attachments";
import { acquireBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Adopted bytes intentionally survive browser disposal until native work settles.
afterAll(closeNativeAttachments);

async function fixture(temp: TempDir) {
	const cwd = temp.join("workspace");
	await fs.mkdir(cwd);
	const authStorage = createInMemoryAuthStorage();
	const sessions: AgentSession[] = [];
	const lease = await acquireBrowserProject(cwd, "webgui");
	const controller = new AbortController();
	try {
		for (const name of ["a", "b"]) {
			const agentDir = temp.join(`${name}-agent`);
			const settings = await Settings.loadIsolated({
				cwd,
				agentDir,
				overrides: { "compaction.enabled": false, "memory.backend": "off", "async.enabled": false },
			});
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settings,
				agentRegistry: new AgentRegistry(),
				authStorage,
				sessionManager: SessionManager.inMemory(cwd),
				modelRegistry: new ModelRegistry(authStorage, temp.join(`${name}-models.yml`)),
				model: getTestModel("ascend", model => model.input.includes("image")),
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
			sessions.push(session);
			await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: false, nativeSession: session });
		}
		const session = sessions[0]!;
		const sibling = sessions[1]!;
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: lease.projectId,
			workspacePath: lease.root,
			nativeSession: session,
			signal: controller.signal,
		};
		const uploads = createNativeAttachmentMethods(context);
		return {
			cwd,
			context,
			controller,
			session,
			sibling,
			uploads,
			async stage(operationId: string, fileName: string, mime: string, bytes: Buffer) {
				const staged = (await uploads.methods.stage!({
					operationId,
					sessionId: session.sessionId,
					workspacePath: cwd,
					fileName,
					mime,
					bytesBase64: bytes.toString("base64"),
					sizeBytes: bytes.length,
				})) as { ref: string; bytes: number };
				return { ref: staged.ref, fileName, mime, bytes: staged.bytes };
			},
			async close() {
				controller.abort(new Error("Upload fixture closed"));
				uploads.dispose();
				try {
					await lease.close();
				} finally {
					try {
						for (const session of sessions) await session.dispose();
					} finally {
						authStorage.close();
					}
				}
			},
		};
	} catch (error) {
		controller.abort();
		try {
			await lease.close();
		} finally {
			try {
				for (const session of sessions) await session.dispose();
			} finally {
				authStorage.close();
			}
		}
		throw error;
	}
}

test("real upload bytes decode into native text and images, reject forged metadata and cross-session/connection access", async () => {
	using temp = TempDir.createSync("@pi-native-attachments-");
	const f = await fixture(temp);
	try {
		const bytes = Buffer.from("Unicode upload α\nnot a browser file path", "utf8");
		const attachment = await f.stage("text", "notes.txt", "text/plain", bytes);
		await expect(
			resolveNativeAttachments({ ...f.context, connectionId: "another-connection" }, [attachment]),
		).rejects.toThrow(/unavailable|another/);
		await expect(
			resolveNativeAttachments({ ...f.context, nativeSession: f.sibling }, [attachment], f.sibling.sessionId),
		).rejects.toThrow(/unavailable|another/);
		await expect(resolveNativeAttachments(f.context, [{ ...attachment, bytes: bytes.length + 1 }])).rejects.toThrow(
			/metadata/,
		);
		await expect(resolveNativeAttachments(f.context, [{ ...attachment, fileName: "forged.txt" }])).rejects.toThrow(
			/metadata/,
		);
		const text = await resolveNativeAttachments(f.context, [attachment]);
		expect(text.text).toContain(bytes.toString("utf8"));
		expect(text.text).toContain(JSON.stringify({ fileName: "notes.txt", mime: "text/plain", bytes: bytes.length }));
		expect(text.images).toEqual([]);

		const image = await f.stage("image", "pixel.png", "image/png", Buffer.from(PNG, "base64"));
		const decoded = await resolveNativeAttachments(f.context, [image]);
		expect(decoded.images).toHaveLength(1);
		const decodedPath = temp.join("decoded-image");
		await fs.writeFile(decodedPath, Buffer.from(decoded.images[0]!.data, "base64"));
		const metadata = await readImageMetadata(decodedPath);
		if (!metadata || typeof metadata.width !== "number" || typeof metadata.height !== "number")
			throw new Error("Native image input bytes have no decoded geometry");
		expect(decoded.images[0]!.mimeType).toBe(metadata.mimeType);
		expect(metadata.width / metadata.height).toBe(1);
		expect(decoded.text).toContain('"fileName":"pixel.png"');
		const invalid = await f.stage("invalid-image", "invalid.png", "image/png", Buffer.from("not an image"));
		await expect(resolveNativeAttachments(f.context, [invalid])).rejects.toThrow(/could not be decoded/);

		await fs.writeFile(`${f.cwd}/authorized.txt`, "Native referenced file content");
		await fs.writeFile(temp.join("outside.txt"), "must not enter native context");
		const reference = await resolveNativeFileContexts(f.context, "Read @authorized.txt");
		expect(reference.text).toContain("Native referenced file content");
		await expect(resolveNativeFileContexts(f.context, "Read @../outside.txt")).rejects.toThrow(/escapes/);
	} finally {
		await f.close();
	}
});

test("accepted upload survives draft cleanup and disconnect while native decoding is in flight", async () => {
	using temp = TempDir.createSync("@pi-native-attachment-adopt-");
	const f = await fixture(temp);
	const consumer = new AbortController();
	let nativeRead: Promise<ResolvedAttachments> | undefined;
	try {
		const body = `accepted native input ${crypto.randomUUID()}`;
		const attachment = await f.stage("accepted", "accepted.txt", "text/plain", Buffer.from(body));
		await f.uploads.methods.adopt!("accepted");
		const context = { ...f.context, connectionId: "continuing-native-consumer", signal: consumer.signal };
		nativeRead = resolveNativeAttachments(context, [attachment]);
		await f.uploads.methods.cleanup!("accepted");
		f.controller.abort(new Error("Browser left during native input"));
		expect((await nativeRead).text).toContain(body);
		expect((await resolveNativeAttachments(context, [attachment])).text).toContain(body);
	} finally {
		consumer.abort();
		await Promise.allSettled(nativeRead ? [nativeRead] : []);
		await f.close();
	}
});

test("cancel and abort invalidate staged and actively staging uploads without publishing partial input", async () => {
	using temp = TempDir.createSync("@pi-native-attachment-cancel-");
	const f = await fixture(temp);
	const subscriptions: Array<{ dispose(): void }> = [];
	try {
		const canceled = await f.stage("staged-cancel", "cancel.txt", "text/plain", Buffer.from("discard me"));
		await f.uploads.methods.cancel!("staged-cancel");
		await expect(resolveNativeAttachments(f.context, [canceled])).rejects.toThrow(/unavailable/);
		const cleaned = await f.stage("staged-cleanup", "cleanup.txt", "text/plain", Buffer.from("discard draft"));
		await f.uploads.methods.cleanup!("staged-cleanup");
		await expect(resolveNativeAttachments(f.context, [cleaned])).rejects.toThrow(/unavailable/);

		let cancellation: Promise<unknown> | undefined;
		subscriptions.push(
			f.uploads.dynamicEvents.onDynamicProgress("during-cancel")(progress => {
				if (progress.phase === "uploading")
					cancellation = Promise.resolve(f.uploads.methods.cancel!("during-cancel"));
			}),
		);
		await expect(f.stage("during-cancel", "partial.txt", "text/plain", Buffer.from("in flight"))).rejects.toThrow(
			/canceled/,
		);
		await cancellation;
		await expect(Promise.resolve().then(() => f.uploads.methods.adopt!("during-cancel"))).rejects.toThrow(/canceled/);

		const unadopted = await f.stage("before-abort", "abort.txt", "text/plain", Buffer.from("disconnected draft"));
		subscriptions.push(
			f.uploads.dynamicEvents.onDynamicProgress("during-abort")(progress => {
				if (progress.phase === "uploading") f.controller.abort(new Error("Disconnected during upload"));
			}),
		);
		await expect(
			f.stage("during-abort", "partial.txt", "text/plain", Buffer.from("never committed")),
		).rejects.toThrow("Disconnected during upload");
		const survivingSignal = new AbortController();
		await expect(
			resolveNativeAttachments({ ...f.context, signal: survivingSignal.signal }, [unadopted]),
		).rejects.toThrow(/unavailable/);
	} finally {
		for (const subscription of subscriptions) subscription.dispose();
		await f.close();
	}
});
