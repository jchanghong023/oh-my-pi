import type {
  BrowserCommandRecordingContext,
  BrowserCommandRecordingScope,
} from "./browser-command-recording.js";

export type NativeBrowserVoiceAction =
  | { action: "liveOffer"; voiceSessionId?: string }
  | { action: "liveAnswer"; sdpAnswer: string; voiceSessionId?: string }
  | { action: "liveStop"; voiceSessionId?: string };

interface VoiceOwner {
  current?: BrowserVoice;
  offerRequestId?: string;
  offerOperation?: Promise<Record<string, unknown>>;
  consumedOffers: Set<string>;
}

interface BrowserVoice {
  owner: VoiceOwner;
  id: string;
  context: BrowserCommandRecordingContext;
  lifetime: AbortController;
  closed: boolean;
  failure?: Error;
  microphone?: MediaStream;
  remote?: MediaStream;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  audio?: HTMLAudioElement;
  answered: boolean;
  answerRequestId?: string;
  answerOperation?: Promise<Record<string, unknown>>;
}

// Module-local ownership is also page ownership; nothing is persisted or replayed on reconnect.
const owners = new Map<string, VoiceOwner>();
let pagehideInstalled = false;
let nextVoiceId = 0;

function scopeKey(scope: BrowserCommandRecordingScope): string {
  return JSON.stringify([scope.workspaceIdentity, scope.sessionId, scope.clientId]);
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertCurrent(voice: BrowserVoice): void {
  if (voice.closed || voice.owner.current !== voice) {
    throw voice.failure ?? new Error("This browser voice session has stopped.");
  }
}

function closeVoice(voice: BrowserVoice, failure?: Error): void {
  if (voice.closed) return;
  voice.closed = true;
  voice.failure = failure;
  if (voice.owner.current === voice) voice.owner.current = undefined;
  voice.lifetime.abort();
  for (const track of voice.microphone?.getTracks() ?? []) track.stop();
  for (const track of voice.remote?.getTracks() ?? []) track.stop();
  if (voice.audio) {
    voice.audio.pause();
    voice.audio.srcObject = null;
    voice.audio.remove();
  }
  try { voice.channel?.close(); } finally { voice.peer?.close(); }
  voice.context.onVoiceSettled?.({
    live: false,
    voiceSessionId: voice.id,
    ...(failure ? { error: failure.message } : {}),
  });
}


function installPagehide(): void {
  if (pagehideInstalled) return;
  pagehideInstalled = true;
  window.addEventListener("pagehide", () => {
    for (const owner of owners.values()) {
      if (owner.current) closeVoice(owner.current);
    }
  });
}

/** Races a native operation without losing late getUserMedia cleanup ownership. */
function waitForOperation<T>(
  voice: BrowserVoice,
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  timeoutMessage = "The browser voice operation timed out.",
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let timer: number | undefined;
  const cleanup = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    voice.lifetime.signal.removeEventListener("abort", stopped);
    signal?.removeEventListener("abort", canceled);
  };
  const stopped = () => {
    cleanup();
    reject(voice.failure ?? new Error("This browser voice session has stopped."));
  };
  const canceled = () => {
    cleanup();
    reject(new Error("The browser voice request was canceled."));
  };
  voice.lifetime.signal.addEventListener("abort", stopped, { once: true });
  signal?.addEventListener("abort", canceled, { once: true });
  if (timeoutMs !== undefined) timer = window.setTimeout(() => {
    cleanup();
    reject(new Error(timeoutMessage));
  }, timeoutMs);
  operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  if (voice.closed) stopped();
  else if (signal?.aborted) canceled();
  return promise;
}

function waitForIce(voice: BrowserVoice, signal?: AbortSignal): Promise<void> {
  const peer = voice.peer!;
  const { promise: complete, resolve } = Promise.withResolvers<void>();
  const changed = () => {
    if (peer.iceGatheringState === "complete") resolve();
  };
  peer.addEventListener("icegatheringstatechange", changed);
  const detach = () => peer.removeEventListener("icegatheringstatechange", changed);
  changed();
  return waitForOperation(voice, complete, signal, 20_000, "WebRTC ICE gathering did not complete; no voice offer was sent.").finally(detach);
}

function waitForChannel(voice: BrowserVoice, signal?: AbortSignal): Promise<void> {
  const channel = voice.channel!;
  const { promise: opened, resolve } = Promise.withResolvers<void>();
  const changed = () => {
    if (channel.readyState === "open") resolve();
  };
  channel.addEventListener("open", changed);
  const detach = () => channel.removeEventListener("open", changed);
  changed();
  return waitForOperation(voice, opened, signal, 30_000, "The native live voice WebRTC data channel did not connect.").finally(detach);
}

function makeOffer(voice: BrowserVoice): Promise<Record<string, unknown>> {
  return (async () => {
    const { context } = voice;
    try {
      // Called before the first await so the browser owns the real permission gesture.
      const permission = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }).then(stream => {
        if (voice.closed || voice.owner.current !== voice) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error("Microphone permission arrived after this voice session stopped.");
        }
        voice.microphone = stream;
        return stream;
      });
      const microphone = await waitForOperation(voice, permission, context.signal);
      assertCurrent(voice);
      const tracks = microphone.getAudioTracks();
      if (tracks.length !== 1 || tracks[0].readyState !== "live") {
        throw new Error("The selected microphone has no single live audio track.");
      }
      const peer = new RTCPeerConnection({ iceServers: [] });
      voice.peer = peer;
      const remote = new MediaStream();
      voice.remote = remote;
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.setAttribute("aria-label", "Native live voice audio");
      audio.srcObject = remote;
      voice.audio = audio;
      document.body.appendChild(audio);
      audio.addEventListener("error", () => {
        if (!voice.closed) closeVoice(voice, new Error(audio.error?.message || "Native live voice audio playback failed."));
      });
      peer.addEventListener("track", event => {
        if (voice.closed) { event.track.stop(); return; }
        if (event.track.kind === "audio") {
          remote.addTrack(event.track);
          event.track.addEventListener("ended", () => {
            if (!voice.closed) closeVoice(voice, new Error("The native live voice remote audio track ended."));
          }, { once: true });
        }
      });
      peer.addEventListener("iceconnectionstatechange", () => {
        if (!voice.closed && (peer.iceConnectionState === "failed" || peer.iceConnectionState === "closed")) {
          closeVoice(voice, new Error(`Native live voice ICE connection ${peer.iceConnectionState}.`));
        }
      });
      tracks[0].addEventListener("ended", () => {
        if (!voice.closed) closeVoice(voice, new Error("The browser microphone was disconnected or its permission was revoked."));
      }, { once: true });
      peer.addTrack(tracks[0], microphone);
      // The server retains the provider control sideband; this page carries media only.
      const channel = peer.createDataChannel("oai-events");
      voice.channel = channel;
      channel.addEventListener("error", () => {
        if (!voice.closed) closeVoice(voice, new Error("The native live voice data channel failed."));
      });
      channel.addEventListener("close", () => {
        if (!voice.closed) closeVoice(voice, new Error("The native live voice data channel closed."));
      });
      const offer = await waitForOperation(voice, peer.createOffer(), context.signal);
      assertCurrent(voice);
      await waitForOperation(voice, peer.setLocalDescription(offer), context.signal);
      await waitForIce(voice, context.signal);
      assertCurrent(voice);
      const description = peer.localDescription;
      if (description?.type !== "offer" || !description.sdp.trim()) {
        throw new Error("The browser generated no usable WebRTC SDP offer.");
      }
      return { sdpOffer: description.sdp, voiceSessionId: voice.id };
    } catch (error) {
      closeVoice(voice, errorOf(error));
      throw error;
    }
  })();
}

async function acceptAnswer(
  voice: BrowserVoice,
  sdpAnswer: string,
  context: BrowserCommandRecordingContext,
): Promise<Record<string, unknown>> {
  try {
    assertCurrent(voice);
    if (!sdpAnswer.trim()) throw new Error("The native live provider returned an empty SDP answer.");
    if (!voice.peer || !voice.audio || voice.peer.signalingState !== "have-local-offer") {
      throw new Error("The browser voice peer is not waiting for an SDP answer.");
    }
    // Start playback in this explicit answer gesture, not in a later projection/effect.
    const answer = voice.peer.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
    const playback = voice.audio.play();
    // Observe both immediately so a rejected playback promise is never unhandled.
    await waitForOperation(voice, Promise.all([answer, playback]), context.signal, 30_000,
      "The native voice answer or remote audio playback did not become ready.");
    await waitForChannel(voice, context.signal);
    assertCurrent(voice);
    if (!voice.remote?.getAudioTracks().some(track => track.readyState === "live")) {
      throw new Error("The native voice provider supplied no live remote audio track.");
    }
    voice.answered = true;
    return { live: true, voiceSessionId: voice.id };
  } catch (error) {
    closeVoice(voice, errorOf(error));
    throw error;
  }
}

/** Only called from an explicit native-interaction click; never initiates provider signaling. */
export function executeNativeBrowserVoiceAction(
  sessionId: string,
  action: NativeBrowserVoiceAction,
  context: BrowserCommandRecordingContext,
): Promise<Record<string, unknown>> {
  if (sessionId !== context.sessionId || !sessionId || !context.workspaceIdentity || !context.clientId || !context.requestId) {
    return Promise.reject(new Error("The browser voice request has no matching session/page/client owner."));
  }
  if (context.signal?.aborted) return Promise.reject(new Error("The browser voice request was canceled."));
  const key = scopeKey(context);
  let owner = owners.get(key);
  if (action.action === "liveOffer") {
    if (action.voiceSessionId !== undefined && (typeof action.voiceSessionId !== "string" || !action.voiceSessionId.trim())) {
      return Promise.reject(new Error("The browser voice offer has an invalid session token."));
    }
    if (owner?.offerRequestId === context.requestId && owner.offerOperation) {
      if (action.voiceSessionId && action.voiceSessionId !== owner.current?.id) {
        return Promise.reject(new Error("This voice offer replay has a different session token."));
      }
      return owner.offerOperation.then(result => {
        if (!owner?.current || owner.current.id !== result.voiceSessionId) {
          throw new Error("This voice offer has already stopped and cannot be replayed.");
        }
        return result;
      });
    }
    if (owner?.consumedOffers.has(context.requestId)) {
      return Promise.reject(new Error("A stopped browser voice offer cannot be replayed."));
    }
    if (owner?.current) return Promise.reject(new Error("This session already owns a browser voice connection or microphone request."));
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      return Promise.reject(new Error(!window.isSecureContext ? "当前 HTTP 内网访问不支持浏览器麦克风，请使用文字输入或上传音频文件。" : "当前浏览器不支持麦克风或 WebRTC。"));
    }
    installPagehide();
    if (!owner) { owner = { consumedOffers: new Set() }; owners.set(key, owner); }
    const voice: BrowserVoice = {
      owner,
      id: action.voiceSessionId ?? `${Date.now().toString(36)}-${++nextVoiceId}`,
      context,
      lifetime: new AbortController(),
      closed: false,
      answered: false,
    };
    owner.current = voice;
    owner.offerRequestId = context.requestId;
    owner.consumedOffers.add(context.requestId);
    owner.offerOperation = makeOffer(voice);
    return owner.offerOperation;
  }
  const voice = owner?.current;
  if (!voice) {
    if (action.action === "liveStop") return Promise.resolve({ live: false });
    return Promise.reject(new Error("No browser voice offer is active for this session/page/client."));
  }
  if (!action.voiceSessionId || action.voiceSessionId !== voice.id) {
    return Promise.reject(new Error("This browser voice action belongs to a stale or different voice session."));
  }
  if (action.action === "liveStop") {
    closeVoice(voice);
    return Promise.resolve({ live: false, voiceSessionId: voice.id });
  }
  if (voice.answerRequestId === context.requestId && voice.answerOperation) return voice.answerOperation;
  if (voice.answerOperation || voice.answered) return Promise.reject(new Error("This browser voice offer has already received an answer."));
  voice.answerRequestId = context.requestId;
  voice.answerOperation = acceptAnswer(voice, action.sdpAnswer, context);
  return voice.answerOperation;
}

/** Called only for actual owning session/connection exit, never ordinary chat selection. */
export function disposeNativeBrowserVoice(scope: BrowserCommandRecordingScope): void {
  const owner = owners.get(scopeKey(scope));
  if (owner?.current) closeVoice(owner.current);
}
