import { writeBrowserClipboardText } from "@/lib/browserClipboard.js";
import type { IPlatformService } from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import { executeNativeBrowserMediaAction, type NativeBrowserMediaAction } from "@/v4/nativeBrowserMedia.js";

export interface NativeBrowserActionInput extends Record<string, unknown> {
  kind: "webgui-browser-action";
  action: string;
  originSessionId: string;
  connectionId: string;
  clientId: string;
}

export function nativeBrowserActionInput(input: unknown): NativeBrowserActionInput | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  return value.kind === "webgui-browser-action" && typeof value.action === "string" &&
    typeof value.originSessionId === "string" && typeof value.connectionId === "string" &&
    typeof value.clientId === "string" ? value as NativeBrowserActionInput : null;
}

export interface NativeBrowserMediaTerminalEvent {
  kind: "record" | "live";
  mediaId: string;
  state: "stopped" | "error";
  downloadStarted?: boolean;
  fileName?: string;
  error?: string;
}

export interface NativeBrowserActionContext {
  sessionId: string;
  workspaceIdentity: string;
  requestId: string;
  platform: IPlatformService | null;
  attachFile(file: File): boolean;
  setDraft(text: string, files: File[], onlyIfEmpty: boolean): boolean;
  openSession(input: NativeBrowserActionInput): void;
  setTodoExpanded(expanded: boolean, markdown?: string): void;
  setDisplayMode(mode: "clean" | "compact" | "detailed", hideThinking: boolean): void;
  reportMediaState(event: NativeBrowserMediaTerminalEvent): Promise<void>;
}

function requiredString(input: NativeBrowserActionInput, name: string): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`Native browser action requires ${name}`);
  return value;
}

function nativeImageFile(fileName: string, mimeType: string, encoded: string): File {
  if (!mimeType.startsWith("image/") || encoded.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4)
    throw new Error("Invalid or oversized native image attachment");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], fileName, { type: mimeType });
}

export function openNativeBrowserUrl(raw: string): void {
  const url = new URL(raw, window.location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("This browser cannot open the requested URL protocol");
  const opened = window.open(url.href, "_blank");
  if (!opened) throw new Error("The browser blocked opening the requested window");
  opened.opener = null;
}

/** Called only in an explicit broker action click, never while projecting model text. */
export async function executeNativeBrowserAction(
  input: NativeBrowserActionInput,
  context: NativeBrowserActionContext,
): Promise<Record<string, unknown>> {
  if (input.originSessionId !== context.sessionId)
    throw new Error("The browser action does not belong to this session");
  switch (input.action) {
    case "copyText": {
      if (typeof document === "undefined") throw new Error("Clipboard access is unavailable");
      await writeBrowserClipboardText(requiredString(input, "text"));
      return { copied: true };
    }
    case "openUrl":
      openNativeBrowserUrl(requiredString(input, "url"));
      return { opened: true };
    case "openSession":
      requiredString(input, "sessionId");
      context.openSession(input);
      return { opened: true, sessionId: input.sessionId };
    case "setTodoExpanded":
      if (typeof input.expanded !== "boolean") throw new Error("Invalid todo expansion state");
      context.setTodoExpanded(input.expanded, typeof input.markdown === "string" ? input.markdown : undefined);
      return { expanded: input.expanded };
    case "setDisplayMode":
      if (!["clean", "compact", "detailed"].includes(String(input.mode)) || typeof input.hideThinking !== "boolean")
        throw new Error("Invalid native display mode");
      context.setDisplayMode(input.mode as "clean" | "compact" | "detailed", input.hideThinking);
      return { mode: input.mode, hideThinking: input.hideThinking };
    case "setDraft": {
      const images = input.images;
      if (images !== undefined && !Array.isArray(images)) throw new Error("Invalid native draft images");
      const files = (images ?? []).map((image: unknown, index: number) => {
        if (!image || typeof image !== "object") throw new Error("Invalid native draft image");
        const value = image as Record<string, unknown>;
        if (value.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string")
          throw new Error("Invalid native draft image content");
        return nativeImageFile(`image-${index + 1}`, value.mimeType, value.data);
      });
      return { applied: context.setDraft(requiredString(input, "text"), files, input.onlyIfEmpty === true) };
    }
    case "attachImage": {
      const file = nativeImageFile(requiredString(input, "fileName"), requiredString(input, "mimeType"),
        requiredString(input, "dataBase64"));
      if (!context.attachFile(file)) throw new Error("The originating session draft cannot accept this image");
      return { attached: true, fileName: file.name, bytes: file.size };
    }
    case "diagnostics": {
      if (input.probe !== "state" && input.probe !== "protocols") throw new Error("Unknown browser diagnostic probe");
      const style = window.getComputedStyle(document.documentElement);
      return {
        probe: input.probe,
        viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
        visibility: document.visibilityState,
        origin: window.location.origin,
        online: navigator.onLine,
        webSocketAvailable: typeof WebSocket !== "undefined",
        computedFont: style.fontFamily,
        colorScheme: style.getPropertyValue("color-scheme"),
        links: document.querySelectorAll("a[href]").length,
        images: Array.from(document.images).map((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })),
        notificationPermission: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
      };
    }
    case "recordStart":
    case "recordStop":
    case "liveOffer":
    case "liveAnswer":
    case "liveStop": {
      if (!context.platform?.saveFile) throw new Error("Browser media services are unavailable");
      const action: NativeBrowserMediaAction = input.action === "liveAnswer"
        ? { action: "liveAnswer", sdpAnswer: requiredString(input, "sdpAnswer"),
            ...(typeof input.voiceSessionId === "string" ? { voiceSessionId: input.voiceSessionId } : {}) }
        : input.action === "liveStop"
          ? { action: "liveStop", ...(typeof input.voiceSessionId === "string" ? { voiceSessionId: input.voiceSessionId } : {}) }
          : input.action === "liveOffer"
            ? { action: "liveOffer", ...(typeof input.voiceSessionId === "string" ? { voiceSessionId: input.voiceSessionId } : {}) }
            : { action: input.action, ...(typeof input.recordingId === "string" ? { recordingId: input.recordingId } : {}) };
      const settled = (kind: "record" | "live", result: Record<string, unknown>) => {
        toast(typeof result.error === "string" ? result.error :
          typeof result.message === "string" ? result.message : JSON.stringify(result));
        const mediaId = kind === "record" ? result.recordingId : result.voiceSessionId;
        if (typeof mediaId !== "string" || (kind === "record" ? result.recording !== false : result.live !== false)) return;
        void context.reportMediaState({
          kind, mediaId, state: typeof result.error === "string" ? "error" : "stopped",
          ...(typeof result.downloadStarted === "boolean" ? { downloadStarted: result.downloadStarted } : {}),
          ...(typeof result.fileName === "string" ? { fileName: result.fileName } : {}),
          ...(typeof result.error === "string" ? { error: result.error } : {}),
        }).catch((error) => toast(error instanceof Error ? error.message : String(error)));
      };
      return executeNativeBrowserMediaAction(context.sessionId, action, {
        workspaceIdentity: context.workspaceIdentity,
        clientId: input.clientId,
        requestId: context.requestId,
        saveFile: context.platform.saveFile.bind(context.platform),
        onRecordingSettled: (result) => settled("record", result),
        onVoiceSettled: (result) => settled("live", result),
      });
    }
    default:
      throw new Error(`Unsupported native browser action: ${input.action}`);
  }
}
