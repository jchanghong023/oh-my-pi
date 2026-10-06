/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur (message frames stamped with `messageId`)
 * - Prompt completion: one `prompt_result` per accepted prompt, correlated by the command `id`
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 *
 * This module is the single-session transport shell: frame encoding, the stdin
 * input loop, the output writer, and process exit. Everything bound to the one
 * AgentSession lives in {@link RpcSessionHost} (rpc-session-host.ts), which the
 * multi-session project mode reuses per session.
 */
import * as fs from "node:fs";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import { formatPersistenceDurabilityFailure } from "../persistence-failure";
import { isRpcHostToolResult, isRpcHostToolUpdate } from "./host-tools";
import { isRpcHostUriResult } from "./host-uris";
import { RPC_SUPPORTED_PROTOCOL_VERSIONS } from "./rpc-fork-types";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import type { RpcLiveSessionFactory } from "./rpc-live";
import { RpcOutputWriter } from "./rpc-output";
import {
	type PendingExtensionRequest,
	RpcSessionHost,
	RpcShutdownCoordinator,
	RpcUserInputGate,
	type RpcOutput,
} from "./rpc-session-host";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriResult,
	RpcResponse,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

// Per-session surface moved to rpc-session-host.ts; re-exported here so
// consumers (and tests) keep importing everything from this module.
export {
	applyRpcQueueModeCommand,
	dispatchRpcSkillPrompt,
	handleRpcCancelSubagent,
	handleRpcSessionChange,
	handleRpcSteerSubagent,
	openRpcSession,
	type PendingExtensionRequest,
	promptRpcBuiltinResidual,
	registerRpcPersistenceSurface,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcEditor,
	requestRpcSelect,
	resolveRpcSkillInvocation,
	type RpcBuiltinResidualSession,
	runRpcSkillCommand,
	fitAbortAndRestoreQueueResponse,
	fitRemoveQueuedMessageResponse,
	type RpcOpenSessionSession,
	type RpcOutput,
	RpcPendingExtensionRequests,
	type RpcQueueModeCommand,
	RpcShutdownCoordinator,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
	type RpcSkillCommandResult,
	type RpcSkillCommandSession,
	type RpcSkillInvocation,
	type RpcSubagentResetRegistry,
	RpcUserInputGate,
	RpcWordPredictor,
	tryRunRpcSkillCommand,
} from "./rpc-session-host";

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
	/** Fork-extension (v3) bypass frames; return true to consume. */
	onForkControlFrame?: (parsed: unknown) => boolean;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (deps.onForkControlFrame?.(parsed)) return true;

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Commands that skip the serial queue entirely; see {@link dispatchRpcInputFrame}.
 * (`prompt` and `steer_subagent` are also backgrounded there, but start through
 * the serial tail.) `btw_cancel` is synchronous and must overtake a `btw` still
 * starting or a long serial command.
 * A Set, not a Record: `type` is untrusted input and must not hit prototype keys.
 */
const BACKGROUND_COMMANDS: ReadonlySet<string> = new Set<RpcCommand["type"]>([
	"bash",
	"predict_word",
	"live_start",
	"btw_cancel",
]);

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * `bash`, `predict_word`, `prompt` and `steer_subagent` are dispatched in the
 * background so the caller can keep reading subsequent frames while one is
 * still settling: a `bash` command can run for a long time, and a `prompt`
 * command's response is held until the message is admitted, which can span
 * real wall-clock time (image normalization, a vision-model description call).
 * `steer_subagent` likewise holds its response until the subagent accepts the
 * message, which for a subagent between turns includes its whole
 * pre-`agent_start` setup. Backgrounding them lets a client send `abort_bash`
 * while a shell command runs, or `abort` (and `steer`/`follow_up`/`get_state`)
 * while a `prompt` or `steer_subagent` is still admitting. `predict_word` is
 * backgrounded too, so a cold prediction engine never stalls the command queue
 * behind a keystroke. `live_start` responds only once the realtime session is
 * connected and recording, so it is backgrounded and `live_stop` can cancel it.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`, `predict_word`, `live_start`, `prompt`, `steer_subagent`). Otherwise a promise that
 *   resolves once the response for the command has been emitted via `output`.
 *   Errors from `handleCommand` on a command dispatched inline propagate; the
 *   caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time, and `prompt`'s response is held until
	// admission (see PromptOptions.onPromptAdmitted), which can likewise span
	// real wall-clock time; `steer_subagent` waits for the subagent to accept.
	// Dispatch them in the background so a subsequent frame — `abort_bash` for
	// a running `bash`, or `abort`/`steer`/`follow_up`/`get_state` for an
	// admitting `prompt` — can be read and handled without waiting for the
	// earlier command to finish on its own. `predict_word` is backgrounded so a
	// cold prediction engine never stalls the command queue behind a keystroke.
	// The response is emitted when `handleCommand` resolves; clients correlate
	// via `command.id`.
	if (
		BACKGROUND_COMMANDS.has(command.type) ||
		command.type === "prompt" ||
		command.type === "steer" ||
		command.type === "follow_up" ||
		command.type === "steer_subagent"
	) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Starts prompts and `steer_subagent` after earlier ordinary commands, without
 * awaiting admission. Control frames, `bash` and `predict_word` dispatch immediately (see
 * dispatchRpcInputFrame). */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;
	readonly #acceptInput: ((command: RpcCommand) => void) | undefined;

	constructor(options: {
		deps: RpcInputFrameDeps;
		afterSerialCommand?: () => Promise<void>;
		acceptInput?: (command: RpcCommand) => void;
	}) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
		this.#acceptInput = options.acceptInput;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			// Sequence user input at frame-arrival time (upstream PR #13027): an
			// abort or session change that arrives now must invalidate earlier
			// input still queued behind the serial tail or the input gate.
			this.#acceptInput?.(command);
			// Bash and predict_word retain their immediate side channel. Prompts,
			// steer/follow_up, and steer_subagent start through the serial tail,
			// but dispatchRpcInputFrame backgrounds their admission.
			if (BACKGROUND_COMMANDS.has(command.type)) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/** Startup options for {@link runRpcMode}. */
export interface RpcModeOptions {
	/** `--mode rpc-ui`: route tool UI (e.g. ask) over the protocol, independently of headless extensions. */
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** `--no-ui`: extensions run with `hasUI=false` and no UI frames; tool UI and host-issued login are unaffected. */
	headless?: boolean;
	subagentEventBus?: EventBus;
	input?: ReadableStream<Uint8Array>;
	/** Builds `live_start` sessions; defaults to the real {@link RpcLiveBridge} controller. */
	createLiveSession?: RpcLiveSessionFactory;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession, options: RpcModeOptions = {}): Promise<never> {
	const { setToolUIContext, headless = false, subagentEventBus, input = claimRpcInput(), createLiveSession } = options;
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Bun on Windows writes a piped process.stdout with a blocking WriteFile on the
	// JS thread and never reports backpressure, so a client that stops reading
	// stdout froze the whole worker, stdin reader included. An fd write stream
	// writes from the threadpool and reports backpressure, letting the writer spool.
	const stdout = process.platform === "win32" ? fs.createWriteStream("", { fd: 1, autoClose: false }) : process.stdout;
	const outputWriter = new RpcOutputWriter(stdout, failure => {
		logger.error("RPC output delivery failed", { error: String(failure) });
		void session.dispose().finally(() => process.exit(1));
	});
	outputWriter.write(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: RPC_SUPPORTED_PROTOCOL_VERSIONS,
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			mode: "rpc-ui",
		}),
	);
	const output: RpcOutput = obj => {
		outputWriter.write(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};

	// Per-session protocol surface: fork controllers, prompt reporting,
	// extension UI, host tool/URI bridges, and the command switch. Background
	// tasks (bash dispatch, builtin runCommandInBackground) drain through the
	// shutdown coordinator below before the process may exit.
	// The input gate sequences user input (upstream PR #13027): accept happens
	// at frame-arrival (dispatcher below), the ordered arm runs inside the
	// host, and an abort or session change invalidates earlier queued input.
	const inputGate = new RpcUserInputGate();
	const host = new RpcSessionHost({
		session,
		output,
		subagentEventBus,
		headless,
		setToolUIContext,
		inputGate,
		createLiveSession,
		maxResponseBytes: () => frameEncoder.maxResponseBytes,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
	});
	// Startup awaits can span client interaction: a `session_start` extension
	// hook may emit an extension_ui_request and wait for the host's answer.
	// Those answers arrive on stdin, so the reader must be running before the
	// awaits — run startup concurrently and gate ordinary commands on it, while
	// control frames (extension_ui_response, host tool/URI results) dispatch
	// immediately through the bridges the constructor already built.
	const startup = (async () => {
		await host.initializeExtensions();
		await host.start();
	})();

	/**
	 * Dispose the session, then end the process. A store failure still latched
	 * at dispose makes `dispose()` reject, and the `notice` frame it emits is
	 * queued on the asynchronous `outputWriter`: drain that writer before exiting
	 * or the client never learns the failure (review 3983906393). The durability
	 * loss is mirrored on stderr and the exit code is nonzero. A dispose
	 * rejection with no latched store failure still surfaces to the caller.
	 */
	const disposeAndExit = async (): Promise<never> => {
		try {
			// The process ends regardless; report an unsaved side answer instead of skipping dispose.
			// Runs on every exit path: this one (extension pi.shutdown()) never goes through
			// host.dispose, which the stdin-EOF path uses.
			await host.closeBtw();
			// Close the realtime call (microphone, socket) before the session it delegates into.
			await host.stopLive();
			await session.dispose();
		} catch (error) {
			const persistenceFailure = host.persistenceFailure;
			if (!persistenceFailure || error !== persistenceFailure) throw error;
			// The notice frame this failure queued must reach the client before the
			// process ends (review 3983906393).
			await outputWriter.close();
			try {
				if (!process.stderr.write(`${formatPersistenceDurabilityFailure(persistenceFailure.message)}\n`)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					// A closed stream never emits `drain`; resolve on error/close too
					// so an undeliverable mirror cannot strand the exit.
					const settle = (): void => {
						process.stderr.off("drain", settle);
						process.stderr.off("error", settle);
						process.stderr.off("close", settle);
						resolve();
					};
					process.stderr.on("drain", settle);
					process.stderr.on("error", settle);
					process.stderr.on("close", settle);
					await promise;
				}
			} catch {
				// A mirror that cannot be written must not cost the exit code.
			}
			process.exit(1);
		}
		// A failure that already reported and then recovered still leaves its notice
		// queued here, so the success path drains the same queue before it exits.
		await outputWriter.close();
		process.exit(0);
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => host.isShutdownRequested(),
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await disposeAndExit();
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand: command => startup.then(() => host.handleCommand(command)),
		output,
		errorResponse: (id, command, message) => host.error(id, command, message),
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests: host.pendingExtensionRequests,
		onHostToolResult: frame => host.hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => host.hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => host.hostUriBridge.handleResult(frame),
		onForkControlFrame: parsed => host.forkHost.handleControlFrame(parsed),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
		acceptInput: command => inputGate.accept(command),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Frames are read
	// line-by-line by readRpcInputFrames so a single malformed line is reported
	// as an error frame and the loop keeps running instead of throwing out of
	// the reader and killing the whole process (issue #5194).
	const readerDone = readRpcInputFrames(
		input ?? Bun.stdin.stream(),
		parsed => inputDispatcher.dispatch(parsed),
		message => output(host.error(undefined, "parse", message)),
	);
	// Startup failures still reject runRpcMode exactly as before; the reader
	// above is what lets the client answer a startup-time interaction at all.
	await startup;
	await readerDone;

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	// host.dispose does not dispose the AgentSession; disposeAndExit below owns
	// that (and the process exit).
	await host.dispose("RPC client disconnected");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately. Returned rather than awaited: `runRpcMode` is typed
	// `Promise<never>`, and only returning the `Promise<never>` keeps this end
	// point unreachable for the compiler.
	return disposeAndExit();
}
