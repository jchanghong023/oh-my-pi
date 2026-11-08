import {
  disposeBrowserCommandRecording,
  startBrowserCommandRecording,
  stopBrowserCommandRecording,
  type BrowserCommandRecordingContext,
  type BrowserCommandRecordingScope,
} from "./browser-command-recording.js";
import {
  disposeNativeBrowserVoice,
  executeNativeBrowserVoiceAction,
} from "./nativeBrowserVoice.js";

export type NativeBrowserMediaAction =
  | { action: "recordStart"; recordingId?: string }
  | { action: "recordStop"; recordingId?: string }
  | { action: "liveOffer"; voiceSessionId?: string }
  | { action: "liveAnswer"; sdpAnswer: string; voiceSessionId?: string }
  | { action: "liveStop"; voiceSessionId?: string };

export type NativeBrowserMediaContext = Omit<BrowserCommandRecordingContext, "sessionId">;
export type NativeBrowserMediaScope = Omit<BrowserCommandRecordingScope, "sessionId">;

/** The caller must invoke this directly inside the native interaction's real user click. */
export function executeNativeBrowserMediaAction(
  sessionId: string,
  action: NativeBrowserMediaAction,
  context: NativeBrowserMediaContext,
): Promise<Record<string, unknown>> {
  const ownedContext: BrowserCommandRecordingContext = { ...context, sessionId };
  switch (action.action) {
    case "recordStart":
      return startBrowserCommandRecording({ ...ownedContext, recordingId: action.recordingId });
    case "recordStop":
      return stopBrowserCommandRecording({ ...ownedContext, recordingId: action.recordingId });
    case "liveOffer":
    case "liveAnswer":
    case "liveStop":
      return executeNativeBrowserVoiceAction(sessionId, action, ownedContext);
  }
}

/** Connection/session settlement only: switching the visible session is not settlement. */
export function disposeNativeBrowserMediaSession(
  sessionId: string,
  scope: NativeBrowserMediaScope,
): void {
  const owner = { ...scope, sessionId };
  disposeBrowserCommandRecording(owner);
  disposeNativeBrowserVoice(owner);
}
