import { InternalUrlRouter } from "../../internal-urls/router";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { createSketchResource, type SketchResource } from "../../sketch/server";
import { commandConsumed, usage } from "../../slash-commands/helpers/parse";
import type { ParsedSlashCommand, WebGuiSlashCommandRuntime } from "../../slash-commands/types";
import { nativeWebGuiInteractionOrigin, withNativeWebGuiInteractionScope } from "./native-interactions";

interface NativeSketch {
	resource: SketchResource;
	cancel(): void;
}
interface SketchState {
	current?: NativeSketch;
	submissions: Set<Promise<void>>;
	close(): Promise<void>;
}
const sessions = new WeakMap<AgentSession, SketchState>();
const disposerSessions = new WeakSet<AgentSession>();
const liveStates = new Set<SketchState>();
const resources = new Map<string, NativeSketch>();

/** Mounted behind the existing native listener's Host/Origin/network admission. */
export async function fetchNativeWebGuiSketch(request: Request): Promise<Response | undefined> {
	const path = new URL(request.url).pathname;
	if (!path.startsWith("/sketch/")) return undefined;
	const match = /^\/sketch\/[^/]+\//.exec(path);
	const sketch = match ? resources.get(match[0]) : undefined;
	if (!sketch)
		return new Response("Sketch session has ended.", { status: 404, headers: { "Cache-Control": "no-store" } });
	return sketch.resource.fetch(request);
}

/** Stop only this process's capability resources and drain real PNG writes/attachment transfers. */
export async function closeNativeWebGuiSketches(): Promise<void> {
	await Promise.all([...liveStates].map(state => state.close()));
}

function stateFor(runtime: WebGuiSlashCommandRuntime): SketchState {
	let state = sessions.get(runtime.session);
	if (state) return state;
	const session = runtime.session;
	state = {
		submissions: new Set(),
		async close() {
			this.current?.cancel();
			await Promise.allSettled([...this.submissions]);
			if (sessions.get(session) === this) sessions.delete(session);
			liveStates.delete(this);
		},
	};
	sessions.set(session, state);
	liveStates.add(state);
	const owned = state;
	if (!disposerSessions.has(session)) {
		disposerSessions.add(session);
		session.addDisposer(() => {
			void sessions
				.get(session)
				?.close()
				.catch(error => logger.warn("Native sketch disposal failed", { error: String(error) }));
		});
	}
	runtime.registerHostShutdown?.(() => owned.close());
	return state;
}

export async function runWebGuiSketch(_command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const state = stateFor(runtime);
	const origin = nativeWebGuiInteractionOrigin();
	if (!origin?.sessionId) throw new Error("Sketch requires its originating browser session.");
	if (state.current)
		return usage("A sketch is already open in this session; finish or cancel that canvas first.", runtime);
	const { session, sessionManager } = runtime;
	const sessionId = sessionManager.getSessionId();
	const generation = session.sessionGeneration;
	const abort = new AbortController();
	const isCurrent = () =>
		!abort.signal.aborted &&
		!session.isDisposed &&
		!session.isSessionTransitioning &&
		session.sessionManager === sessionManager &&
		sessionManager.getSessionId() === sessionId &&
		session.sessionGeneration === generation;
	const assertCurrent = () => {
		if (!isCurrent()) throw new Error("The originating sketch draft is no longer active.");
	};
	assertCurrent();
	const resource = createSketchResource({
		onSubmit(png) {
			const submission = (async () => {
				assertCurrent();
				const fileName = `sketch-${crypto.randomUUID()}.png`;
				const localUrl = `local://${fileName}`;
				const filePath = InternalUrlRouter.instance().locateSync(localUrl, {
					localProtocolOptions: {
						getArtifactsDir: () => sessionManager.getArtifactsDir(),
						getSessionId: () => sessionId,
					},
				});
				if (filePath === undefined) throw new Error("Unable to locate the session sketch artifact");
				await Bun.write(filePath, png);
				assertCurrent();
				await withNativeWebGuiInteractionScope(origin, () =>
					runtime.host.browserAction(
						{ action: "attachImage", fileName, mimeType: "image/png", dataBase64: png.toString("base64") },
						{ signal: abort.signal },
					),
				);
			})();
			state.submissions.add(submission);
			void submission.then(
				() => {
					state.submissions.delete(submission);
				},
				() => {
					state.submissions.delete(submission);
				},
			);
			return submission;
		},
	});
	const owned: NativeSketch = {
		resource,
		cancel() {
			abort.abort();
			resource.close();
			resources.delete(resource.path);
			if (state.current === owned) state.current = undefined;
		},
	};
	state.current = owned;
	resources.set(resource.path, owned);
	const removeSessionChange = session.registerSessionChangeCallback(owned.cancel);
	if (abort.signal.aborted) removeSessionChange();
	else abort.signal.addEventListener("abort", removeSessionChange, { once: true });
	void resource.result.then(() => {
		resources.delete(resource.path);
		removeSessionChange();
		abort.signal.removeEventListener("abort", removeSessionChange);
		if (state.current === owned) state.current = undefined;
	});
	try {
		await runtime.host.browserAction({ action: "openUrl", url: resource.path }, { signal: abort.signal });
		await runtime.output(
			"Sketch canvas opened. Attach the drawing to this draft when ready; it will not send a message.",
		);
		return commandConsumed();
	} catch (error) {
		owned.cancel();
		throw error;
	}
}
