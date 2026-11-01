import { contentText, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";

type ChildName = "MixedAlpha" | "MixedBeta";
type Phase = "initial" | "read" | "edit" | "verify" | "ready" | "wait" | "during" | "delivered" | "done";

interface ChildRecord {
	readonly parentMessage: boolean;
	readonly fileModified: boolean;
	readonly readyNotified: boolean;
	readonly duringNotified: boolean;
	readonly finalReply: boolean;
}

interface ChildState {
	name: ChildName;
	marker: string;
	path: string;
	variable: string;
	before: number;
	after: number;
	phase: Phase;
	record: { -readonly [K in keyof ChildRecord]: ChildRecord[K] };
}

function nativeTool(request: ModelRequest, name: string, args: Record<string, unknown>): Reply {
	const advertised = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === name)?.function;
	if (!advertised) throw new Error(`Mixed child requires advertised native ${name}`);
	return { tool: { name: advertised.name, args } };
}

/** Inspect the real result of the immediately preceding tool call. */
function lastToolResult(request: ModelRequest, expected: string): string {
	const assistant = request.messages.findLast(message => message.role === "assistant" && message.tool_calls?.length);
	const call = assistant?.tool_calls?.at(-1) as { id?: unknown; function?: { name?: unknown } } | undefined;
	if (
		typeof call?.id !== "string" ||
		typeof call.function?.name !== "string" ||
		call.function.name.replace(/^_/u, "") !== expected
	) {
		throw new Error(`Mixed child expected ${expected} tool call`);
	}
	const result = request.messages.findLast(message => message.role === "tool" && message.tool_call_id === call.id);
	if (!result) throw new Error(`Mixed child did not receive ${expected} tool result`);
	const text = contentText(result.content);
	if (/^(?:error|failed)\b/iu.test(text.trim())) throw new Error(`Mixed child ${expected} failed: ${text}`);
	return text;
}

function hasParentMessage(request: ModelRequest, marker: string): boolean {
	return request.messages.some(message => {
		if (message.role !== "user" && message.role !== "tool") return false;
		const text = contentText(message.content);
		if (!text.includes(marker)) return false;
		// Match the actual wait-result or harness IRC envelope, not task context.
		return message.role === "tool"
			? /^\[[^\]]+\] Main(?: \([^)]*\))*: /u.test(text)
			: text.includes("Incoming IRC message from agent `Main`") || text.includes('<irc from="parent" agent="Main">');
	});
}

/** Orchestrate two real task children; only the model's replies are simulated. */
export function createMixedChildren() {
	const ready = Promise.withResolvers<void>();
	const during = Promise.withResolvers<void>();
	const start = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	// Teardown can precede the parent's await of either rejected barrier.
	void ready.promise.catch(() => {});
	void during.promise.catch(() => {});
	const makeChild = (name: ChildName, variable: string, before: number, after: number): ChildState => ({
		name,
		marker: `MIXED_CHILD_${variable.toUpperCase()}`,
		path: `src/${variable}.ts`,
		variable,
		before,
		after,
		phase: "initial",
		record: {
			parentMessage: false,
			fileModified: false,
			readyNotified: false,
			duringNotified: false,
			finalReply: false,
		},
	});
	const children = [makeChild("MixedAlpha", "alpha", 1, 11), makeChild("MixedBeta", "beta", 2, 22)];
	const records: Readonly<Record<ChildName, Readonly<ChildRecord>>> = {
		MixedAlpha: children[0]!.record,
		MixedBeta: children[1]!.record,
	};

	async function childReply(request: ModelRequest, child: ChildState): Promise<Reply> {
		const upper = child.variable.toUpperCase();
		const parentMarker = `MIXED_PARENT_${upper}`;
		if (child.phase === "initial") {
			child.phase = "read";
			return nativeTool(request, "read", { i: "Reading child source", path: child.path });
		}
		if (child.phase === "read") {
			const result = lastToolResult(request, "read");
			const header = result.match(
				new RegExp(`\\[${child.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}#[A-F0-9]{4}\\]`, "u"),
			)?.[0];
			if (!header || !result.includes(`export const ${child.variable} = ${child.before}`)) {
				throw new Error(`Mixed child could not read expected hashline and source: ${result}`);
			}
			child.phase = "edit";
			return nativeTool(request, "edit", {
				i: "Editing assigned child source",
				input: `*** Begin Patch\n${header}\nPUT 1.=1:\n+export const ${child.variable} = ${child.after};\n*** End Patch\n`,
			});
		}
		if (child.phase === "edit") {
			lastToolResult(request, "edit");
			child.phase = "verify";
			return nativeTool(request, "read", { i: "Reading edited child source", path: child.path });
		}
		if (child.phase === "verify") {
			const result = lastToolResult(request, "read");
			if (!result.includes(`export const ${child.variable} = ${child.after};`)) {
				throw new Error(`Mixed child edit did not change ${child.path}: ${result}`);
			}
			child.record.fileModified = true;
			child.phase = "ready";
			return nativeTool(request, "write", {
				i: "Notifying parent child ready",
				path: "agent://Main",
				content: `MIXED_${upper}_READY`,
			});
		}
		if (child.phase === "ready") {
			const result = lastToolResult(request, "write");
			if (!result.includes("Delivered to Main.")) throw new Error(`Mixed child ready delivery failed: ${result}`);
			child.record.readyNotified = true;
			if (children.every(item => item.record.readyNotified)) ready.resolve();
			child.phase = "wait";
			if (!hasParentMessage(request, parentMarker))
				return nativeTool(request, "wait", { i: "Waiting for parent message" });
		}
		if (child.phase === "wait") {
			if (!hasParentMessage(request, parentMarker)) {
				throw new Error(`Mixed child did not receive ${parentMarker}: ${lastToolResult(request, "wait")}`);
			}
			child.record.parentMessage = true;
			await start.promise;
			child.phase = "during";
			return nativeTool(request, "write", {
				i: "Notifying parent during compaction",
				path: "agent://Main",
				content: `MIXED_${upper}_DURING_COMPACT`,
			});
		}
		if (child.phase === "during") {
			const result = lastToolResult(request, "write");
			if (!result.includes("Delivered to Main."))
				throw new Error(`Mixed child compaction delivery failed: ${result}`);
			child.record.duringNotified = true;
			if (children.every(item => item.record.duringNotified)) during.resolve();
			await finish.promise;
			child.phase = "delivered";
			return nativeTool(request, "write", {
				i: "Sending post-compaction peer message",
				path: "agent://Main",
				content: `MIXED_${upper}_POST_COMPACT_PEER`,
			});
		}
		if (child.phase === "delivered") {
			const result = lastToolResult(request, "write");
			if (!result.includes("Delivered to Main."))
				throw new Error(`Mixed child post-compaction delivery failed: ${result}`);
			child.phase = "done";
			child.record.finalReply = true;
			const done = `MIXED_${upper}_DONE`;
			if (request.tools?.some(item => item.function?.name.replace(/^_/u, "") === "yield")) {
				return nativeTool(request, "yield", {
					type: "result",
					data: { summary: done, files: [{ path: child.path, description: "Edited by child" }] },
				});
			}
			return { text: done };
		}
		throw new Error(`Unexpected extra request for ${child.name}`);
	}

	return {
		ready: ready.promise,
		messagesDuringCompaction: during.promise,
		startCompaction: () => start.resolve(),
		finishCompaction: () => finish.resolve(),
		records,
		dispose: () => {
			start.resolve();
			finish.resolve();
			ready.resolve();
			during.resolve();
		},
		reply(request: ModelRequest): Reply | Promise<Reply> | undefined {
			const title = request.messages.some(
				message => message.role === "system" && contentText(message.content).includes("Label the delegated work"),
			);
			if (
				title &&
				children.some(child =>
					request.messages.some(
						message => message.role === "user" && contentText(message.content).includes(child.marker),
					),
				)
			) {
				return { text: "<title>Mixed child work</title>" };
			}
			const child = children.find(item =>
				request.messages.some(message => {
					const text = contentText(message.content);
					return message.role === "user" && text.includes(`Complete assignment thoroughly:\n\n${item.marker}`);
				}),
			);
			return child
				? childReply(request, child).catch(error => {
						ready.reject(error);
						during.reject(error);
						start.resolve();
						finish.resolve();
						throw error;
					})
				: undefined;
		},
	};
}
