import { describe, expect, it } from "bun:test";
import type { GuestFrame, HostFrame, ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { settleComposerDraft } from "../src/components/shell/Composer";
import type { ComposerDraft } from "../src/components/shell/Composer";
import { SessionReplica } from "../src/lib/client";
import type { SessionTransport } from "../src/lib/client";
class RecordingTransport implements SessionTransport {
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	frames: GuestFrame[] = [];
	closed = false;
	connect(): void {
		this.onOpen?.();
	}
	close(): void {
		this.closed = true;
	}
	send(frame: GuestFrame): void {
		this.frames.push(frame);
	}
}
const welcome: HostFrame = {
	t: "welcome",
	proto: 1,
	header: { type: "session", id: "native-session", timestamp: "2026-11-07T00:00:00Z", cwd: "/isolated" },
	state: { cwd: "/isolated", isStreaming: false, queuedMessageCount: 0, participants: [] },
	agents: [],
	entryCount: 0,
};

describe("workbench composer admission", () => {
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "AA==" };
	const sent: ComposerDraft = { text: "original", images: [image], attachmentNames: ["diagram.png"] };
	it("consumes text and image attachments only on accepted", () => {
		expect(settleComposerDraft(sent, sent, { kind: "accepted" })).toEqual({
			text: "",
			images: [],
			attachmentNames: [],
		});
		expect(settleComposerDraft(sent, sent, { kind: "rejected", message: "owner changed" })).toBe(sent);
		expect(settleComposerDraft(sent, sent, { kind: "unknown", message: "lost response" })).toBe(sent);
	});
	it("does not discard edits or asynchronously attached images made during admission", () => {
		const edited: ComposerDraft = {
			text: "next draft",
			images: [...sent.images, image],
			attachmentNames: ["diagram.png", "later.png"],
		};
		expect(settleComposerDraft(edited, sent, { kind: "accepted" })).toEqual(edited);
		const textOnlyEdit = { ...sent, text: "next draft" };
		expect(settleComposerDraft(textOnlyEdit, sent, { kind: "accepted" })).toEqual({
			text: "next draft",
			images: [],
			attachmentNames: [],
		});
	});
});

describe("workbench production replica", () => {
	it("applies chunked history, live entries, tool partials, UI endings, and bye without a test reducer", () => {
		const transport = new RecordingTransport();
		const replica = new SessionReplica(transport, "browser");
		const old: SessionEntry = {
			type: "message",
			id: "old",
			parentId: null,
			timestamp: "2026-11-07T00:00:01Z",
			message: { role: "user", content: "history", timestamp: 1 },
		};
		const live: SessionEntry = { ...old, id: "live", message: { role: "user", content: "new", timestamp: 2 } };
		replica.receiveFrame({ ...welcome, entryCount: 1 });
		replica.receiveFrame({ t: "entry", entry: live });
		replica.receiveFrame({ t: "snapshot-chunk", entries: [old], final: true });
		expect(replica.getSnapshot().entries).toEqual([old, live]);
		replica.receiveFrame({
			t: "event",
			event: { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "actual.md" } },
		});
		replica.receiveFrame({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "call",
				toolName: "read",
				args: {},
				partialResult: { content: [{ type: "text", text: "partial" }] },
			},
		});
		replica.receiveFrame({
			t: "ui-request",
			request: { reqId: 7, kind: "select", title: "native approval", options: ["allow", "deny"] },
		});
		expect(replica.getSnapshot().activeTools.get("call")?.partialResult).toEqual({
			content: [{ type: "text", text: "partial" }],
		});
		expect(replica.getSnapshot().uiRequest?.reqId).toBe(7);
		replica.receiveFrame({ t: "ui-request-end", reqId: 7 });
		expect(replica.getSnapshot().uiRequest).toBeNull();
		replica.receiveFrame({ t: "bye", reason: "owner ended" });
		expect(replica.getSnapshot().phase).toBe("ended");
		expect(transport.closed).toBe(true);
		expect(transport.frames).toEqual([]);
	});
	it("refreshes actual edited history without dropping late entries, active tools, or native waits", () => {
		const replica = new SessionReplica(new RecordingTransport(), "browser");
		replica.receiveFrame(welcome);
		const original: SessionEntry = {
			type: "message",
			id: "old",
			parentId: null,
			timestamp: "2026-11-07T00:00:01Z",
			message: { role: "user", content: "before", timestamp: 1 },
		};
		replica.receiveFrame({ t: "entry", entry: original });
		const known = new Set(replica.getSnapshot().entries.map(entry => entry.id));
		const late: SessionEntry = {
			...original,
			id: "late",
			message: { role: "user", content: "arrived while reading", timestamp: 2 },
		};
		replica.receiveFrame({ t: "entry", entry: late });
		replica.receiveFrame({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Still waiting", prefill: "raw" },
		});
		replica.receiveFrame({
			t: "event",
			event: { type: "tool_execution_start", toolCallId: "still-running", toolName: "read", args: {} },
		});
		const edited: SessionEntry = {
			...original,
			message: { role: "user", content: "actual native edit", timestamp: 1 },
		};
		replica.refreshHistory(
			[
				{ ...welcome, entryCount: 1 },
				{ t: "snapshot-chunk", entries: [edited], final: true },
			],
			known,
		);
		expect(replica.getSnapshot().entries).toEqual([edited, late]);
		expect(replica.getSnapshot().uiRequest?.reqId).toBe(8);
		expect(replica.getSnapshot().activeTools.has("still-running")).toBe(true);
		const previous = replica.getSnapshot();
		expect(() => replica.refreshHistory([{ ...welcome, entryCount: 2 }], known)).toThrow("incomplete");
		expect(replica.getSnapshot()).toBe(previous);
		replica.receiveFrame({ t: "bye", reason: "finished fixture" });
	});
});
