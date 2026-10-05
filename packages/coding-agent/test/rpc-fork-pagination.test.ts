import { describe, expect, test } from "bun:test";
import { pageRpcMessages, RpcMessagesPageError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-messages";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const snapshot = { sessionId: "sess-1", leafId: "leaf-1" as string | null, messageCount: 0 };
const message = (text: string): AgentMessage =>
	({ role: "user", content: text, timestamp: new Date().toISOString() }) as unknown as AgentMessage;

function setup(count: number): { messages: AgentMessage[]; snapshot: typeof snapshot } {
	const messages = Array.from({ length: count }, (_, index) => message(`m${index}`));
	return { messages, snapshot: { ...snapshot, messageCount: count } };
}

describe("get_messages_page reverse pagination (5.4)", () => {
	test("desc walk from the tail returns newest-first pages and exhausts without a cursor", () => {
		const { messages, snapshot: snap } = setup(5);
		const page1 = pageRpcMessages(messages, snap, { order: "desc", limit: 2 });
		expect(page1.messages.map(m => (m as { content: string }).content)).toEqual(["m4", "m3"]);
		expect(page1.totalMessages).toBe(5);
		expect(page1.nextCursor).toBeDefined();

		const page2 = pageRpcMessages(messages, snap, { cursor: page1.nextCursor, limit: 2 });
		expect(page2.messages.map(m => (m as { content: string }).content)).toEqual(["m2", "m1"]);

		const page3 = pageRpcMessages(messages, snap, { cursor: page2.nextCursor, limit: 2 });
		expect(page3.messages.map(m => (m as { content: string }).content)).toEqual(["m0"]);
		expect(page3.nextCursor).toBeUndefined();
	});

	test("desc full walk equals the reversed asc full walk", () => {
		const { messages, snapshot: snap } = setup(7);
		const asc: string[] = [];
		let cursor: string | undefined;
		do {
			const page = pageRpcMessages(messages, snap, { cursor, limit: 3 });
			asc.push(...page.messages.map(m => (m as { content: string }).content));
			cursor = page.nextCursor;
		} while (cursor);
		const desc: string[] = [];
		let descCursor: string | undefined;
		do {
			const page = pageRpcMessages(messages, snap, { cursor: descCursor, limit: 3, order: "desc" });
			desc.push(...page.messages.map(m => (m as { content: string }).content));
			descCursor = page.nextCursor;
		} while (descCursor);
		expect(desc).toEqual([...asc].reverse());
	});

	test("legacy asc cursor keeps forward direction even when order:'desc' is passed", () => {
		const { messages, snapshot: snap } = setup(5);
		const page1 = pageRpcMessages(messages, snap, { limit: 2 });
		expect(page1.messages.map(m => (m as { content: string }).content)).toEqual(["m0", "m1"]);
		// Legacy asc cursor: options.order must not leak in; the cursor dictates asc.
		const page2 = pageRpcMessages(messages, snap, { cursor: page1.nextCursor, limit: 2, order: "desc" });
		expect(page2.messages.map(m => (m as { content: string }).content)).toEqual(["m2", "m3"]);
	});

	test("before/after anchors page around an offset in the right direction", () => {
		const { messages, snapshot: snap } = setup(6);
		// before offset 2 → m0, m1 newest-first.
		const anchor = pageRpcMessages(messages, snap, { limit: 2 });
		const offset2Cursor = anchor.nextCursor!; // offset 2
		const before = pageRpcMessages(messages, snap, { before: offset2Cursor, limit: 2 });
		expect(before.messages.map(m => (m as { content: string }).content)).toEqual(["m1", "m0"]);
		expect(before.nextCursor).toBeUndefined();

		const after = pageRpcMessages(messages, snap, { after: offset2Cursor, limit: 2 });
		expect(after.messages.map(m => (m as { content: string }).content)).toEqual(["m2", "m3"]);
		expect(after.nextCursor).toBeDefined();
	});

	test("anchors reject combinations and stale snapshots; legacy cursor stays valid", () => {
		const { messages, snapshot: snap } = setup(4);
		const page = pageRpcMessages(messages, snap, { limit: 1 });
		expect(() => pageRpcMessages(messages, snap, { before: page.nextCursor!, after: page.nextCursor! })).toThrow(
			"only one of before/after",
		);
		expect(() => pageRpcMessages(messages, snap, { before: page.nextCursor!, cursor: page.nextCursor! })).toThrow(
			"either cursor or a before/after anchor",
		);

		// Stale anchor: snapshot moved (new leaf) while the count still matches.
		const staleSnap = { ...snap, leafId: "leaf-2" };
		expect(() => pageRpcMessages(messages, staleSnap, { before: page.nextCursor! })).toThrow(RpcMessagesPageError);
		try {
			pageRpcMessages(messages, staleSnap, { before: page.nextCursor! });
		} catch (error) {
			expect((error as RpcMessagesPageError).code).toBe("stale_cursor");
		}

		// Legacy asc cursor round-trip still walks forward.
		const next = pageRpcMessages(messages, snap, { cursor: page.nextCursor!, limit: 2 });
		expect(next.messages.map(m => (m as { content: string }).content)).toEqual(["m1", "m2"]);
	});
	test("an explicit exhausted reverse cursor never wraps to the history tail", () => {
		const { messages, snapshot: snap } = setup(3);
		const cursor = Buffer.from(JSON.stringify({ version: 1, ...snap, offset: 0, order: "desc" })).toString(
			"base64url",
		);
		const page = pageRpcMessages(messages, snap, { cursor });
		expect(page.messages).toEqual([]);
		expect(page.nextCursor).toBeUndefined();
	});

	test("invalid walk directions are rejected rather than silently read forward", () => {
		const { messages, snapshot: snap } = setup(3);
		expect(() => pageRpcMessages(messages, snap, { order: "backwards" as "asc" })).toThrow(
			"order must be asc or desc",
		);
	});

	test("same-leaf, same-length content changes invalidate revision-bound cursors and anchors", () => {
		const { messages, snapshot: snap } = setup(4);
		const original = { ...snap, revision: "original-bytes" };
		const page = pageRpcMessages(messages, original, { limit: 1 });
		const revised = { ...snap, revision: "revised-bytes" };
		for (const options of [{ cursor: page.nextCursor }, { before: page.nextCursor }, { after: page.nextCursor }]) {
			try {
				pageRpcMessages(messages, revised, options);
				throw new Error("Expected a stale cursor");
			} catch (error) {
				expect(error).toMatchObject({ code: "stale_cursor" });
			}
		}
		expect(pageRpcMessages(messages, original, { cursor: page.nextCursor, limit: 1 }).messages).toEqual([
			messages[1]!,
		]);
	});
});
