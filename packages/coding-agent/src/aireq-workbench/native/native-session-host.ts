import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { CreateAgentSessionOptions } from "../../sdk";
import type { AIReqNativeInputKind } from "../../spec-driven/actors";
import type { AIReqNativeServiceOwner, WebGuiServiceContext } from "./rpc-contract";
import type { NativeWebGuiCommandOptions } from "./native-commands";
import { nativeWebGuiCommands, executeNativeWebGuiCommand, cancelNativeWebGuiCommandInputs } from "./native-commands";
import {
	reportNativeWebGuiMediaState,
	disconnectNativeWebGuiMedia,
	registerNativeWebGuiInputOrigin,
	forgetNativeWebGuiInputOrigin,
} from "./native-command-modes";
import { readBrowserProject, listBrowserProjects } from "./project-registry";
import { startTeamDiscussion } from "../../team/controller";
import { withNativeWebGuiInteractionScope, nativeWebGuiQuestions } from "./native-interactions";
import { nativeChatRuntimeForSession } from "./native-chat";

const sessionOwners = new WeakMap<AgentSession, AIReqNativeServiceOwner>();
const changes = new Set<() => void>();
const nativeMutations = new WeakMap<AIReqNativeServiceOwner, Set<Promise<unknown>>>();
/** Bind only an actual root/actor created by this owner; imports never activate an application. */
export function bindAIReqNativeServiceOwner(session: AgentSession, owner: AIReqNativeServiceOwner): () => void {
	const previous = sessionOwners.get(session);
	if (previous && previous !== owner) throw new Error("Native session already belongs to another AIReq host");
	owner.assertSession(session);
	sessionOwners.set(session, owner);
	// Projection events belong to the AIReq session binding, not to a browser
	// observer. Receipt-driven inputs must invalidate snapshots even headlessly.
	const releaseChat = nativeChatRuntimeForSession(session).retain();
	return () => {
		releaseChat();
		if (sessionOwners.get(session) === owner) sessionOwners.delete(session);
	};
}
function nativeSessionOwner(session: AgentSession): AIReqNativeServiceOwner {
	const owner = sessionOwners.get(session);
	if (!owner) throw new Error("Native session has no AIReq host owner");
	owner.assertSession(session);
	return owner;
}
export function notifyAIReqNativeSessions(): void {
	for (const listener of changes) listener();
}
export function subscribeWebGuiNativeSessions(listener: () => void): () => void {
	changes.add(listener);
	return () => changes.delete(listener);
}
export function assertAIReqNativeContext(context: WebGuiServiceContext, sessionId?: string): AIReqNativeServiceOwner {
	context.signal.throwIfAborted();
	const owner = context.nativeOwner;
	if (!owner) throw new Error("Native connection has no AIReq host owner");
	owner.assertCurrent(context, sessionId);
	return owner;
}
/** Admit against the exact AIReq connection before starting real native configuration writes. */
export function runAIReqNativeMutation<T>(context: WebGuiServiceContext, operation: () => Promise<T>): Promise<T> {
	const owner = assertAIReqNativeContext(context);
	const task = operation();
	const pending = nativeMutations.get(owner) ?? new Set<Promise<unknown>>();
	nativeMutations.set(owner, pending);
	pending.add(task);
	const settled = () => {
		pending.delete(task);
		if (!pending.size && nativeMutations.get(owner) === pending) nativeMutations.delete(owner);
	};
	void task.then(settled, settled);
	return task;
}
/** Exit closes admission in this owner first, then drains only its admitted configuration work. */
export async function settleAIReqNativeMutations(owner: AIReqNativeServiceOwner): Promise<void> {
	let pending = nativeMutations.get(owner);
	while (pending?.size) {
		await Promise.allSettled(pending);
		pending = nativeMutations.get(owner);
	}
}
export async function listWebGuiNativeSessions(context: WebGuiServiceContext): Promise<AgentSession[]> {
	assertAIReqNativeContext(context);
	return context.nativeSession && !context.nativeSession.isDisposed ? [context.nativeSession] : [];
}
export async function resolveWebGuiSession(context: WebGuiServiceContext, sessionId?: string): Promise<AgentSession> {
	assertAIReqNativeContext(context, sessionId);
	const project = context.projectId ? readBrowserProject(context.projectId) : null;
	const session = context.nativeSession ?? (!sessionId ? project?.nativeSession : undefined);
	if (!session || session.isDisposed || (sessionId && session.sessionId !== sessionId))
		throw new Error("Exact native session is not available for this AIReq object");
	return session;
}
export async function resolveWebGuiInputSession(
	context: WebGuiServiceContext,
	sessionId: string,
): Promise<AgentSession> {
	const owner = assertAIReqNativeContext(context, sessionId);
	const session = await owner.prepare(context);
	if (session.sessionId !== sessionId) throw new Error("Native input session identity changed");
	return session;
}
export function stopAIReqNativeInput(session: AgentSession): Promise<void> {
	return nativeSessionOwner(session).stop(session);
}
export function runWebGuiSession<T>(session: AgentSession, operation: () => T): T {
	if (session.isDisposed) throw new Error("AIReq native session has ended");
	const result = session.agentRegistry ? AgentRegistry.runScoped(session.agentRegistry, operation) : operation();
	return result;
}
export function runAIReqNativeInput<T>(
	session: AgentSession,
	operation: () => Promise<T>,
	text?: string,
	kind: AIReqNativeInputKind = "prompt",
): Promise<T> {
	return nativeSessionOwner(session).runInput(session, operation, text, kind);
}
export function webGuiSessionProject(session: AgentSession) {
	const project = listBrowserProjects().find(
		item => item.nativeSessions.has(session) || item.nativeSession === session,
	);
	if (!project || project.phase !== "active") throw new Error("AIReq native project ownership has ended");
	return { projectId: project.projectId, root: project.root, url: "./" };
}
export function webGuiSessionContext(session: AgentSession): WebGuiServiceContext {
	const project = webGuiSessionProject(session);
	return {
		connectionId: `native:${session.instanceKey}`,
		projectId: project.projectId,
		workspacePath: session.sessionManager.getCwd(),
		nativeOwner: nativeSessionOwner(session),
		nativeSession: session,
		signal: new AbortController().signal,
	};
}
export async function createWebGuiNativeSession(
	context: WebGuiServiceContext,
	_workspacePath?: string,
	_options?: CreateAgentSessionOptions,
): Promise<AgentSession> {
	return assertAIReqNativeContext(context).prepare(context);
}
export async function resumeWebGuiNativeSession(
	context: WebGuiServiceContext,
	sessionId: string,
	_options?: CreateAgentSessionOptions,
): Promise<AgentSession> {
	return resolveWebGuiSession(context, sessionId);
}
function forbidden(): never {
	throw new Error(
		"AIReq workflow owns native session identity and worktree; select an IR/SR or use an explicit workflow transition",
	);
}
export async function forkWebGuiNativeSession(
	_session: AgentSession,
	_options?: { allowBusySnapshot?: boolean },
): Promise<AgentSession> {
	return forbidden();
}
export async function deleteWebGuiNativeSession(_session: AgentSession): Promise<void> {
	return forbidden();
}
export async function moveWebGuiNativeSession(
	_session: AgentSession,
	_cwd: string,
	_operation: () => Promise<void>,
): Promise<void> {
	return forbidden();
}
export async function openWebGuiNativeProject(
	_directory: string,
	_create = false,
): Promise<{ projectId: string; root: string; url: string }> {
	return forbidden();
}
export function isWebGuiNativeSessionUnavailable(session: AgentSession): boolean {
	return session.isDisposed;
}
const blockedCommands =
	/^\/(?:new|clear|fresh|resume|branch|fork|delete|cd|cwd|aireq|webgui|exit|quit|restart|profile)(?:\s|$)/;
const ports = {
	listCommands: async (session: AgentSession) => {
		nativeSessionOwner(session);
		const commands = await nativeWebGuiCommands(session);
		return [
			...commands.filter(command => !blockedCommands.test(`/${command.name}`)),
			{ name: "team", description: "Run a real native Team discussion in the selected AIReq worktree" },
		];
	},
	executeCommand: async (session: AgentSession, text: string, options?: NativeWebGuiCommandOptions) => {
		nativeSessionOwner(session);
		if (/^\/(?:abort|stop)(?:\s|$)/.test(text)) {
			await stopAIReqNativeInput(session);
			return true;
		}
		if (blockedCommands.test(text))
			throw new Error(
				"This command would change the workflow-owned native identity; use AIReq project/object controls",
			);
		if (/^\/team(?:\s|$)/.test(text)) {
			const run = async () => {
				const ui = nativeWebGuiQuestions(session).ui;
				const question = text.replace(/^\/team\s*/, "").trim() || (await ui.editor("Native Team question"));
				if (!question) return true;
				await runAIReqNativeInput(
					session,
					async () => {
						const result = await startTeamDiscussion(question, {
							session,
							settings: session.settings,
							cwd: session.sessionManager.getCwd(),
							ownerId: session.getAgentId(),
							hooks: {
								showStatus: message => ui.notify(message),
								showError: message => ui.notify(message, "error"),
								output: message => ui.notify(message),
							},
						});
						if (!result.started) throw new Error(result.message);
						const job = result.jobId ? session.asyncJobManager?.getJob(result.jobId) : undefined;
						if (!job) throw new Error("Native Team did not register its discussion job");
						await job.promise;
						if (job.status !== "completed")
							throw new Error(job.errorText ?? `Native Team discussion ${job.status}`);
					},
					question,
					"native-action",
				);
				return true;
			};
			return options ? withNativeWebGuiInteractionScope({ ...options, sessionId: session.sessionId }, run) : run();
		}
		return executeNativeWebGuiCommand(session, text, options);
	},
	reportMediaState: reportNativeWebGuiMediaState,
	disconnectMedia: disconnectNativeWebGuiMedia,
	registerInputOrigin: registerNativeWebGuiInputOrigin,
	forgetInputOrigin: forgetNativeWebGuiInputOrigin,
	cancelCommandInputs: cancelNativeWebGuiCommandInputs,
};
export function installedWebGuiNativePorts() {
	return ports;
}
export function webGuiNativePorts() {
	return ports;
}
export function nativeWebGuiSessionCommands(session: AgentSession) {
	return ports.listCommands(session);
}
export function executeWebGuiSessionCommand(session: AgentSession, text: string, options?: NativeWebGuiCommandOptions) {
	return ports.executeCommand(session, text, options);
}
