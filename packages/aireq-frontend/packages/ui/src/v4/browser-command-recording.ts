import type { SaveFileRequest, SaveFileResult } from "@zcode/shared";

export interface BrowserCommandRecordingScope {
  workspaceIdentity: string;
  sessionId: string;
  clientId: string;
}

export interface BrowserCommandRecordingContext extends BrowserCommandRecordingScope {
  requestId: string;
  recordingId?: string;
  saveFile: (request: SaveFileRequest) => Promise<SaveFileResult>;
  signal?: AbortSignal;
  onRecordingSettled?: (result: Record<string, unknown>) => void;
  onVoiceSettled?: (result: Record<string, unknown>) => void;
}

export interface BrowserCommandRecordingResult extends Record<string, unknown> {
  recording: boolean;
  recordingId?: string;
  message: string;
  fileName?: string;
  mimeType?: string;
  downloadStarted?: boolean;
}

interface Recording {
  context: BrowserCommandRecordingContext;
  recordingId: string;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  canceled: boolean;
  started: boolean;
  stopping: boolean;
  failure?: Error;
  completion: Promise<BrowserCommandRecordingResult>;
  resolve: (result: BrowserCommandRecordingResult) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
}

interface RecordingOwner {
  current?: Recording;
  operations: Map<string, Promise<BrowserCommandRecordingResult>>;
  lastCompletion?: Promise<BrowserCommandRecordingResult>;
}

// Browser-runtime only. Each module instance belongs to one tab; no media enters session storage.
const owners = new Map<string, RecordingOwner>();
let pagehideInstalled = false;

function ownerKey(scope: BrowserCommandRecordingScope): string {
  return JSON.stringify([scope.workspaceIdentity, scope.sessionId, scope.clientId]);
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function releaseTracks(recording: Recording): void {
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
}

function clearRecording(owner: RecordingOwner, recording: Recording): void {
  releaseTracks(recording);
  recording.detachAbort?.();
  recording.chunks.length = 0;
  if (owner.current === recording) owner.current = undefined;
}

function stopCapture(recording: Recording): void {
  recording.canceled = true;
  recording.stopping = true;
  try {
    if (recording.recorder && recording.recorder.state !== "inactive") recording.recorder.stop();
  } finally {
    releaseTracks(recording);
  }
}

async function exportRecording(
  owner: RecordingOwner,
  recording: Recording,
): Promise<void> {
  try {
    if (recording.failure) throw recording.failure;
    const mimeType = recording.recorder?.mimeType || "video/webm";
    if (!/^video\/webm(?:;|$)/i.test(mimeType)) {
      throw new Error(`Browser recorder produced an unsupported format: ${mimeType}`);
    }
    const blob = new Blob(recording.chunks, { type: mimeType });
    if (!blob.size) throw new Error("The browser recording produced no video data.");
    const fileName = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    const sourceUrl = URL.createObjectURL(blob);
    try {
      const saved = await recording.context.saveFile({ sourceUrl, suggestedName: fileName });
      if (!saved.success || saved.canceled) {
        throw new Error(saved.error || (saved.canceled ? "Recording download canceled." : "Recording download failed."));
      }
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
    const result: BrowserCommandRecordingResult = {
      recording: false,
      recordingId: recording.recordingId,
      fileName,
      mimeType,
      downloadStarted: true,
      message: "WebM recording handed to the browser downloader; final disk save is not confirmed.",
    };
    recording.resolve(result);
    recording.context.onRecordingSettled?.(result);
  } catch (error) {
    const failure = errorOf(error);
    recording.reject(failure);
    recording.context.onRecordingSettled?.({
      recording: false,
      recordingId: recording.recordingId,
      downloadStarted: false,
      error: failure.message,
    });
  } finally {
    clearRecording(owner, recording);
  }
}

function installPagehide(): void {
  if (pagehideInstalled) return;
  pagehideInstalled = true;
  window.addEventListener("pagehide", () => {
    for (const owner of owners.values()) {
      if (owner.current) stopCapture(owner.current);
    }
  });
}

function operation(
  context: BrowserCommandRecordingContext,
  action: "start" | "stop",
  run: (owner: RecordingOwner) => Promise<BrowserCommandRecordingResult>,
): Promise<BrowserCommandRecordingResult> {
  if (context.signal?.aborted) return Promise.reject(new Error("Recording request is no longer active."));
  const key = ownerKey(context);
  let owner = owners.get(key);
  if (!owner) {
    owner = { operations: new Map() };
    owners.set(key, owner);
  }
  const requestKey = `${action}:${context.requestId}`;
  const previous = owner.operations.get(requestKey);
  if (previous) return previous;
  const result = run(owner);
  owner.operations.set(requestKey, result);
  return result;
}

/** Call directly from the pending-interaction's user click, before awaiting anything else. */
export function startBrowserCommandRecording(
  context: BrowserCommandRecordingContext,
): Promise<BrowserCommandRecordingResult> {
  return operation(context, "start", async (owner) => {
    if (owner.current) throw new Error("This session already has a recording or a pending display permission request.");
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Native display capture is unavailable. Use a secure browser context with getDisplayMedia support.");
    }
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      throw new Error("This browser does not support native MediaRecorder WebM recording.");
    }
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
      (candidate) => MediaRecorder.isTypeSupported(candidate),
    );
    if (!mimeType) throw new Error("This browser has no supported native WebM video encoder.");
    installPagehide();
    const { promise: completion, resolve: resolveCompletion, reject: rejectCompletion } =
      Promise.withResolvers<BrowserCommandRecordingResult>();
    // Capture can end through the browser's sharing controls without a pending stop command.
    void completion.catch(() => undefined);
    const recording: Recording = {
      context,
      recordingId: context.recordingId ?? context.requestId,
      chunks: [],
      canceled: false,
      started: false,
      stopping: false,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    owner.current = recording;
    owner.lastCompletion = undefined;
    const abort = () => stopCapture(recording);
    context.signal?.addEventListener("abort", abort, { once: true });
    recording.detachAbort = () => context.signal?.removeEventListener("abort", abort);
    try {
      // No camera, microphone, automatic surface selection, or permission bypass.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      recording.stream = stream;
      if (recording.canceled || context.signal?.aborted || owner.current !== recording) {
        throw new Error("Display capture request was canceled before recording started.");
      }
      if (!stream.getVideoTracks().some((track) => track.readyState === "live")) {
        throw new Error("The selected display has no live video track.");
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      recording.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) recording.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        releaseTracks(recording);
        void exportRecording(owner, recording);
      }, { once: true });
      const started = Promise.withResolvers<void>();
      recorder.addEventListener("start", () => {
        if (recording.canceled) started.reject(new Error("Recording start was canceled."));
        else started.resolve();
      }, { once: true });
      recorder.addEventListener("error", (event) => {
        const nativeError = "error" in event ? event.error : undefined;
        recording.failure = nativeError instanceof Error ? nativeError : new Error("Native browser recording failed.");
        started.reject(recording.failure);
        stopCapture(recording);
      });
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (!recording.stopping) stopCapture(recording);
        }, { once: true });
      }
      recorder.start(1000);
      recording.started = true;
      owner.lastCompletion = completion;
      await started.promise;
      // The interaction's request signal must not terminate a recording after its start ACK.
      recording.detachAbort?.();
      return {
        recording: true,
        recordingId: recording.recordingId,
        mimeType: recorder.mimeType || mimeType,
        message: "Recording the display chosen in the browser permission dialog. Stop recording to download a WebM video.",
      };
    } catch (error) {
      stopCapture(recording);
      if (!recording.started) clearRecording(owner, recording);
      recording.reject(errorOf(error));
      if (!recording.started) {
        recording.context.onRecordingSettled?.({
          recording: false,
          recordingId: recording.recordingId,
          downloadStarted: false,
          error: errorOf(error).message,
        });
      }
      throw error;
    }
  });
}

export function stopBrowserCommandRecording(
  context: BrowserCommandRecordingContext,
): Promise<BrowserCommandRecordingResult> {
  return operation(context, "stop", async (owner) => {
    const recording = owner.current;
    if (!recording) {
      const result: BrowserCommandRecordingResult = await (owner.lastCompletion ?? { recording: false, message: "This session has no active browser recording." });
      if (context.recordingId && result.recordingId && result.recordingId !== context.recordingId) {
        throw new Error("The requested browser recording generation is no longer active.");
      }
      return result;
    }
    if (context.recordingId && context.recordingId !== recording.recordingId) {
      throw new Error("The requested browser recording generation is no longer active.");
    }
    stopCapture(recording);
    if (!recording.recorder) {
      return {
        recording: false,
        recordingId: recording.recordingId,
        message: "Pending display capture canceled; no recording was started.",
      };
    }
    return recording.completion;
  });
}

/** Only for actual owner connection/session settlement, never for changing the visible tab. */
export function disposeBrowserCommandRecording(scope: BrowserCommandRecordingScope): void {
  const key = ownerKey(scope);
  const owner = owners.get(key);
  if (!owner) return;
  if (owner.current) stopCapture(owner.current);
  owners.delete(key);
}
