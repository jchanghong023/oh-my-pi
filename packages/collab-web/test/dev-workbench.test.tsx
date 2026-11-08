import { describe, expect, it } from "bun:test";
import type { GuestFrame, HostFrame, ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DevActionPreview,
	DevActionResult,
	DevGitPreview,
	DevGuestSessionTarget,
	DevRequirementSnapshot,
	DevSessionTarget,
	DevSubmitResult,
} from "../../coding-agent/src/spec-driven/types";
import { settleComposerDraft } from "../src/components/shell/Composer";
import type { ComposerDraft } from "../src/components/shell/Composer";
import { SessionReplica } from "../src/lib/client";
import type { SessionTransport } from "../src/lib/client";
import { WorkbenchClient } from "../src/dev-workbench/client";
import {
	ActionConfirmation,
	PersistenceResult,
	ScopeCommitRequest,
	selectedSolutionCandidate,
	SolutionMaterial,
	StageNavigation,
} from "../src/dev-workbench/Workbench";
import { NativeInteraction } from "../src/dev-workbench/NativeInteraction";
import { reduceNativeView } from "../src/dev-workbench/native-state";

function snapshot(): DevRequirementSnapshot {
	return {
		recordVersion: "bytes-sha-not-counter",
		record: {
			schemaVersion: 1,
			requirementId: "req-a",
			changeId: "change-a",
			branch: "existing",
			stage: "business",
			lifecycle: "active",
			materials: [],
			decisions: [],
			marks: {},
			solutionBasis: null,
			report: { development: null, st: null },
			syncRevisions: [],
			gitOperations: [],
			pr: null,
			testing: "not-started",
			relatedRequirementIds: [],
		},
		runtime: null,
		actions: [{ id: "next", available: true }],
	};
}
function preview(): DevActionPreview {
	return {
		action: {
			kind: "next",
			binding: {
				requirementId: "req-a",
				expectedRecordVersion: "bytes-sha-not-counter",
				expectedStage: "business",
				files: [],
				operationId: "host-operation",
				expectedGeneration: null,
			},
			previewId: null,
		},
		confirmationToken: "host-token",
		git: null,
	};
}
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

function attributes(html: string, selector: string, names: readonly string[]): Record<string, string | null>[] {
	const found: Record<string, string | null>[] = [];
	new HTMLRewriter()
		.on(selector, {
			element(element) {
				found.push(Object.fromEntries(names.map(name => [name, element.getAttribute(name)])));
			},
		})
		.transform(html);
	return found;
}

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

describe("workbench material and confirmation components", () => {
	it("keeps viewed stage distinct from the real stage without issuing decisions", () => {
		let changes = 0;
		const html = renderToStaticMarkup(
			<StageNavigation snapshot={snapshot()} viewed="testing" onView={() => changes++} />,
		);
		expect(attributes(html, "button[data-stage]", ["data-stage"])).toHaveLength(8);
		expect(attributes(html, 'button[aria-current="step"]', ["data-stage"])).toEqual([{ "data-stage": "business" }]);
		expect(attributes(html, 'button[aria-pressed="true"]', ["data-stage"])).toEqual([{ "data-stage": "testing" }]);
		expect(changes).toBe(0);
	});
	it("renders every full candidate and escapes unsafe Markdown rather than adopting a recommendation", () => {
		const selected: string[] = [];
		const html = renderToStaticMarkup(
			<SolutionMaterial
				text={JSON.stringify({
					recommendedCandidateId: "b",
					candidates: [
						{ id: "a", title: "First", content: "# Unique A\n<script>bad()</script>" },
						{ id: "b", title: "Second", content: "# Unique B\n[unsafe](javascript:alert(1))" },
					],
				})}
				onSelect={id => selected.push(id)}
			/>,
		);
		expect(attributes(html, "article[data-candidate-id]", ["data-candidate-id"])).toEqual([
			{ "data-candidate-id": "a" },
			{ "data-candidate-id": "b" },
		]);
		expect(attributes(html, "script", [])).toEqual([]);
		expect(attributes(html, 'a[href^="javascript:"]', [])).toEqual([]);
		expect(html).toContain("Unique A");
		expect(html).toContain("Unique B");
		expect(selected).toEqual([]);
	});
	it("keeps an explicit candidate across unrelated refreshes, but not changed solution bytes", () => {
		const choice = { id: "pure", version: "actual-solution-byte-sha" };
		expect(selectedSolutionCandidate(undefined, choice.version)).toBeUndefined();
		expect(selectedSolutionCandidate(choice, choice.version)).toBe("pure");
		expect(selectedSolutionCandidate({ ...choice }, choice.version)).toBe("pure");
		expect(selectedSolutionCandidate(choice, "changed-solution-byte-sha")).toBeUndefined();
		expect(selectedSolutionCandidate(choice, undefined)).toBeUndefined();
		const html = renderToStaticMarkup(
			<SolutionMaterial
				text={JSON.stringify({
					candidates: [
						{ id: "pure", title: "Pure", content: "Changed solution" },
						{ id: "normalizer", title: "Normalizer", content: "Alternative" },
					],
				})}
				selected={selectedSolutionCandidate(choice, "changed-solution-byte-sha")}
			/>,
		);
		expect(html).not.toContain("已选");
	});
	it("does not present a scoped Git confirmation as material approval", () => {
		const record = snapshot();
		record.record.stage = "requirements";
		const actor = { name: "tester", source: "local" as const };
		record.record.decisions = [
			{
				operationId: "commit-only",
				stage: "business",
				actor,
				at: "2026-11-07T00:00:00Z",
				userReply: "commit only",
				files: [],
			},
		];
		record.record.gitOperations = [
			{
				operationId: "commit-only",
				kind: "commit",
				actor,
				at: "2026-11-07T00:00:00Z",
				files: [],
				authorizedCommits: [],
				knownCommitShas: [],
				target: {
					localSourceRef: "refs/heads/existing",
					sourceRepository: "source/repository",
					sourceRef: "existing",
					baseRepository: "base/repository",
					baseRef: "trunk",
					remote: "team",
					remoteUrl: "https://example.invalid/repository",
					targetRef: "refs/heads/existing",
					observedTip: "observed-tip",
				},
			},
		];
		const committed = renderToStaticMarkup(
			<StageNavigation
				snapshot={record}
				viewed="business"
				onView={() => {
					throw new Error("render must not navigate");
				}}
			/>,
		);
		expect(attributes(committed, '[data-stage="business"]', ["data-confirmed"])).toEqual([
			{ "data-confirmed": "false" },
		]);
		record.record.decisions.push({
			operationId: "actual-next",
			stage: "business",
			actor,
			at: "2026-11-07T00:01:00Z",
			userReply: "approve this material",
			files: [{ path: "business.md", version: "actual-bytes" }],
		});
		const approved = renderToStaticMarkup(
			<StageNavigation
				snapshot={record}
				viewed="business"
				onView={() => {
					throw new Error("render must not navigate");
				}}
			/>,
		);
		expect(attributes(approved, '[data-stage="business"]', ["data-confirmed"])).toEqual([
			{ "data-confirmed": "true" },
		]);
		expect(record.record.stage).toBe("requirements");
	});
	it("exposes early and batch commit only for a real requirement advertised by its owner", () => {
		let requests = 0;
		const active = snapshot();
		active.actions = [{ id: "commit", available: true }];
		const html = renderToStaticMarkup(
			<ScopeCommitRequest snapshot={active} connected pending={false} onRequest={() => requests++} />,
		);
		expect(attributes(html, '[data-action="commit"]', ["disabled"])).toEqual([{ disabled: null }]);
		expect(active.record.stage).toBe("business");
		expect(active.record.decisions).toEqual([]);
		expect(requests).toBe(0);
		active.record.lifecycle = "completed";
		active.actions = [
			{ id: "commit", available: false, blockedReason: "Completed record: resume original operation only" },
		];
		const completed = renderToStaticMarkup(
			<ScopeCommitRequest snapshot={active} connected pending={false} onRequest={() => requests++} />,
		);
		expect(attributes(completed, '[data-action="commit"]', ["disabled"])).toEqual([{ disabled: "" }]);
		const localOnly = renderToStaticMarkup(
			<ScopeCommitRequest snapshot={null} connected pending={false} onRequest={() => requests++} />,
		);
		expect(attributes(localOnly, '[data-action="commit"]', [])).toEqual([]);
		expect(requests).toBe(0);
	});
	it("does not confirm or mutate merely by rendering a preview", () => {
		let mutations = 0;
		const html = renderToStaticMarkup(
			<ActionConfirmation
				snapshot={snapshot()}
				preview={preview()}
				pending={false}
				error={null}
				onCancel={() => mutations++}
				onConfirm={() => mutations++}
			/>,
		);
		expect(attributes(html, '[data-testid="confirmation-submit"]', ["disabled"])).toEqual([{ disabled: null }]);
		expect(mutations).toBe(0);
	});
	it("renders saved state, committed state and failed push separately without internal hashes", () => {
		const result: DevActionResult = {
			snapshot: snapshot(),
			persistence: {
				save: "succeeded",
				commit: { status: "succeeded", sha: "actual-sha", indexReconciled: true },
				push: { status: "failed", target: null },
				error: "remote unavailable",
			},
		};
		const html = renderToStaticMarkup(
			<PersistenceResult
				result={result}
				onInspect={() => {
					throw new Error("render must not inspect");
				}}
			/>,
		);
		expect(attributes(html, "dd[data-result]", ["data-result"])).toEqual([
			{ "data-result": "save" },
			{ "data-result": "commit" },
			{ "data-result": "push" },
		]);
		expect(html).not.toContain("actual-sha");
		expect(html).toContain("已完成");
		expect(html).toContain("失败");
		expect(html).toContain("remote unavailable");
	});
	it("explains cancellation files, target and conflicts without internal preview fields", () => {
		const prepared = preview();
		const patch = "diff --git a/old.md b/archive/new.md\n-old content\n+owned content";
		const git: DevGitPreview = {
			previewId: "actual-native-preview",
			binding: prepared.action.binding,
			headSha: "observed-head",
			indexVersion: "observed-index",
			files: [],
			paths: ["old.md", "archive/new.md"],
			patch,
			patchHash: "native-patch-sha",
			proposedTree: "native-tree",
			commitsToPublish: ["owned-ancestor-1", "owned-ancestor-2"],
			operation: "cancel",
			target: {
				localSourceRef: "refs/heads/existing",
				sourceRepository: "source/repository",
				sourceRef: "existing",
				baseRepository: "base/repository",
				baseRef: "trunk",
				remote: "team",
				remoteUrl: "https://example.invalid/repository",
				targetRef: "refs/heads/existing",
				observedTip: "observed-remote-tip",
			},
			cancellation: {
				committedShas: ["owned-ancestor-1"],
				changes: [
					{
						id: "rename-group",
						path: "old.md",
						paths: ["old.md", "archive/new.md"],
						layer: "committed",
						patch,
						beforeVersion: "old-bytes",
						afterVersion: "owned-bytes",
						commitSha: "owned-ancestor-1",
						parentSha: "original-parent",
					},
				],
				materials: ["business.md"],
				mainSpecs: ["openspec/specs/native/spec.md"],
				archivePaths: ["archive/new.md"],
				conflicts: [{ path: "shared.ts", reason: "later user edit overlaps" }],
			},
		};
		const cancelling: DevActionPreview = {
			...prepared,
			action: { kind: "cancel", binding: prepared.action.binding, previewId: git.previewId },
			git,
			cancelPlan: {
				preview: git,
				committedShas: ["owned-ancestor-1"],
				paths: ["old.md", "archive/new.md"],
				conflicts: git.cancellation?.conflicts ?? [],
				pr: null,
			},
		};
		let mutations = 0;
		const html = renderToStaticMarkup(
			<ActionConfirmation
				snapshot={snapshot()}
				preview={cancelling}
				pending={false}
				error={null}
				onCancel={() => mutations++}
				onConfirm={() => mutations++}
			/>,
		);
		expect(attributes(html, '[data-testid="cancellation-scope"]', [])).toHaveLength(1);
		for (const fact of ["old.md", "archive/new.md", "refs/heads/existing", "later user edit overlaps"])
			expect(html).toContain(fact);
		for (const internal of [
			"actual-native-preview",
			"host-token",
			"observed-index",
			"native-patch-sha",
			"native-tree",
			"old-bytes",
			"owned-bytes",
		])
			expect(html).not.toContain(internal);
		expect(attributes(html, '[data-testid="confirmation-submit"]', ["disabled"])).toEqual([{ disabled: "" }]);
		expect(mutations).toBe(0);
	});
});

describe("complete native interaction presentation", () => {
	it("renders masked native secret input rather than an editable plain-text document", () => {
		const client = new WorkbenchClient(new URL("http://127.0.0.1:1/cap/"));
		const html = renderToStaticMarkup(
			<NativeInteraction
				client={client}
				request={{
					requestId: "native-secret",
					requirementId: "",
					sessionId: "local-session",
					generation: 3,
					kind: "editor",
					title: "Native secret",
					secret: true,
				}}
				onError={message => {
					throw new Error(message);
				}}
			/>,
		);
		expect(attributes(html, 'input[type="password"]', ["autocomplete"])).toEqual([{ autocomplete: "off" }]);
		expect(attributes(html, "textarea", [])).toEqual([]);
		client.close();
	});
	it("does not preselect recommended answers in native multi-question asks", () => {
		const client = new WorkbenchClient(new URL("http://127.0.0.1:1/cap/"));
		const html = renderToStaticMarkup(
			<NativeInteraction
				client={client}
				request={{
					requestId: "native-ask",
					requirementId: "req-a",
					sessionId: "local-session",
					generation: 3,
					kind: "ask",
					title: "Decide",
					questions: [
						{ id: "one", question: "Choose one", options: [{ label: "A" }, { label: "B" }], recommended: 0 },
						{ id: "many", question: "Choose several", multi: true, options: [{ label: "C" }, { label: "D" }] },
					],
				}}
				onError={message => {
					throw new Error(message);
				}}
			/>,
		);
		expect(attributes(html, 'input[type="radio"]', ["checked"])).toEqual([{ checked: null }, { checked: null }]);
		expect(attributes(html, 'input[type="checkbox"]', ["checked"])).toEqual([{ checked: null }, { checked: null }]);
		expect(attributes(html, 'input[type="file"]', ["accept"])).toHaveLength(4);
		client.close();
	});
});

describe("native UI surface state", () => {
	it("maintains keyed widgets/statuses and real expand commands without clearing unrelated state", () => {
		const target = { requirementId: "req-a", sessionId: "native-session", generation: 4 };
		const identity = "req-a:native-session:4";
		const status = reduceNativeView(
			undefined,
			{
				t: "native-ui-state",
				target,
				method: "setStatus",
				value: { key: "permission", text: "native restricted mode" },
			},
			identity,
			"",
			1,
		);
		const widget = reduceNativeView(
			status,
			{
				t: "native-ui-state",
				target,
				method: "setWidget",
				value: { key: "goal", content: ["actual native goal"], options: { placement: "belowEditor" } },
			},
			identity,
			"",
			2,
		);
		const expanded = reduceNativeView(
			widget,
			{ t: "native-ui-state", target, method: "setToolsExpanded", value: true },
			identity,
			"",
			3,
		);
		expect(expanded.statuses.get("permission")).toBe("native restricted mode");
		expect(expanded.widgets.get("goal")).toEqual({ content: ["actual native goal"], placement: "belowEditor" });
		expect(expanded.toolsExpanded).toBe(true);
		const removed = reduceNativeView(
			expanded,
			{ t: "native-ui-state", target, method: "setWidget", value: { key: "goal", content: undefined } },
			identity,
			"",
			4,
		);
		expect(removed.widgets.size).toBe(0);
		expect(removed.statuses).toBe(expanded.statuses);
		const collapsed = reduceNativeView(
			removed,
			{ t: "native-ui-state", target, method: "setToolsExpanded", value: false },
			identity,
			"",
			5,
		);
		expect(collapsed.toolsExpanded).toBe(false);
	});
	it("binds editor replacements and pastes to the precise native identity", () => {
		const target = { requirementId: "req-a", sessionId: "native-session", generation: 4 };
		const first = reduceNativeView(
			undefined,
			{ t: "native-ui-state", target, method: "setEditorText", value: "  raw  " },
			"owner:4",
			"",
			1,
		);
		const second = reduceNativeView(
			first,
			{ t: "native-ui-state", target, method: "pasteToEditor", value: "append" },
			"owner:4",
			first.editorUpdate?.text ?? "",
			2,
		);
		expect(second.editorUpdate).toEqual({ identity: "owner:4", revision: 2, text: "  raw  append" });
		expect(first.editorUpdate?.text).toBe("  raw  ");
	});
});

/** Browser HTTP surface backed by real requests to each test's Bun server. */
function installBrowserHttp(location: URL): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	const restore = (): void => {
		if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
		else Reflect.deleteProperty(globalThis, "window");
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
	return restore;
}

describe("workbench same-origin HTTP admission", () => {
	it("uses host-issued request IDs, preserves unknown status, and inspects without resubmitting", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];
		let admission: "accepted" | "unknown" = "unknown";
		const guestTarget: DevGuestSessionTarget = {
			kind: "collab",
			peerId: "host-peer",
			roomId: "actual-room",
			sessionId: "remote-native-session",
			generation: 9,
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const url = new URL(request.url);
				if (url.pathname === "/cap/api/events") {
					if (server.upgrade(request)) return;
					return new Response("upgrade rejected", { status: 400 });
				}
				const body: unknown = request.method === "POST" ? await request.json() : null;
				requests.push({ path: url.pathname, body });
				if (url.pathname === "/cap/api/browser") return Response.json({ browserId: "host-browser" });
				if (url.pathname === "/cap/api/requirements") return Response.json([]);
				if (url.pathname === "/cap/api/input-preview") {
					const remote =
						body !== null &&
						typeof body === "object" &&
						"target" in body &&
						body.target !== null &&
						typeof body.target === "object" &&
						"kind" in body.target;
					return Response.json({
						requestId: remote ? "host-guest-input" : "host-input",
						target: remote ? guestTarget : { requirementId: "req-a", sessionId: "native-session", generation: 4 },
					});
				}
				if (url.pathname === "/cap/api/input" || url.pathname === "/cap/api/inputs/host-input")
					return Response.json(
						admission === "accepted"
							? { kind: "accepted" }
							: { kind: "unknown", message: "transport has no admission ACK" },
					);
				if (url.pathname === "/cap/api/collab/join")
					return Response.json({
						peerId: guestTarget.peerId,
						roomId: guestTarget.roomId,
						canWrite: true,
						target: guestTarget,
					});
				return new Response("unhandled", { status: 404 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify(welcome));
				},
				message() {},
			},
		});
		const client = new WorkbenchClient(new URL(`http://127.0.0.1:${server.port}/cap/`));
		const restoreBrowserHttp = installBrowserHttp(new URL(`http://127.0.0.1:${server.port}/cap/`));
		try {
			await client.connect();
			const live = Promise.withResolvers<void>();
			const unsubscribe = client.subscribe(() => {
				if (client.getSnapshot().connected) live.resolve();
			});
			if (client.getSnapshot().connected) live.resolve();
			const timeout = setTimeout(() => live.reject(new Error("Workbench WebSocket did not connect")), 2000);
			try {
				await live.promise;
			} finally {
				clearTimeout(timeout);
				unsubscribe();
			}
			const receipt = await client.submitInput(
				{ requirementId: "req-a", sessionId: "native-session", generation: 4 },
				"retain me",
			);
			expect(receipt.kind).toBe("unknown");
			expect(client.getSnapshot().unknownInput).toBe("host-input");
			expect(requests.find(item => item.path.endsWith("input-preview"))?.body).toEqual({
				target: { requirementId: "req-a", sessionId: "native-session", generation: 4 },
			});
			expect(requests.filter(item => item.path.endsWith("/input"))).toEqual([
				{ path: "/cap/api/input", body: { requestId: "host-input", text: "retain me" } },
			]);
			admission = "accepted";
			expect(await client.inspectInput()).toEqual({ kind: "accepted" });
			expect(requests.filter(item => item.path.endsWith("/input"))).toHaveLength(1);
			expect(client.getSnapshot().unknownInput).toBeNull();
			await client.join("shared-user", "visitor");
			client.select("unrelated-local-requirement");
			expect(client.target()).toEqual(guestTarget);
			const before = requests.filter(item => item.path.endsWith("/input")).length;
			expect(
				(
					await client
						.composer({ requirementId: "req-a", sessionId: "native-session", generation: 4 })
						.sendPrompt("must not hit local actor")
				).kind,
			).toBe("rejected");
			expect(requests.filter(item => item.path.endsWith("/input"))).toHaveLength(before);
			admission = "unknown";
			const guestReceipt = await client.composer(guestTarget).sendPrompt("remote only");
			expect(guestReceipt.kind).toBe("unknown");
			expect(requests.filter(item => item.path.endsWith("input-preview")).at(-1)?.body).toEqual({
				target: guestTarget,
			});
			expect(requests.filter(item => item.path.endsWith("/input"))).toHaveLength(before + 1);
		} finally {
			try {
				client.close();
				await server.stop(true);
			} finally {
				restoreBrowserHttp();
			}
		}
	});
	it("settles editor drafts at input admission without replaying them across the control boundary", async () => {
		const target: DevSessionTarget = { requirementId: "req-a", sessionId: "native-session", generation: 4 };
		const requests: Array<{ path: string; body: unknown }> = [];
		const modelPrompts: string[] = [];
		const errors: string[] = [];
		let inputStarted = Promise.withResolvers<void>();
		let inputResponse = Promise.withResolvers<DevSubmitResult>();
		let editorStarted = Promise.withResolvers<void>();
		let editorResponse: ReturnType<typeof Promise.withResolvers<void>> | null = null;
		let control = false;
		let editorWriting = false;
		let requestNumber = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const path = new URL(request.url).pathname;
				if (path.endsWith("/api/events")) {
					if (server.upgrade(request)) return;
					return new Response("upgrade rejected", { status: 400 });
				}
				const body = request.method === "POST" ? await request.json() : null;
				requests.push({ path, body });
				if (path.endsWith("/api/browser")) return Response.json({ browserId: "editor-browser" });
				if (path.endsWith("/api/requirements")) return Response.json([]);
				if (path.endsWith("/api/input-preview"))
					return Response.json({ requestId: `editor-input-${++requestNumber}`, target });
				if (path.endsWith("/api/native-editor")) {
					if (control)
						return Response.json({ error: "Control is active; editor input is not queued" }, { status: 409 });
					editorWriting = true;
					editorStarted.resolve();
					if (editorResponse) await editorResponse.promise;
					editorWriting = false;
					return Response.json({ updated: true });
				}
				if (path.endsWith("/api/input")) {
					control = true;
					inputStarted.resolve();
					const result = editorWriting
						? { kind: "rejected", message: "Editor write crossed input admission" }
						: await inputResponse.promise;
					if (result.kind === "accepted") modelPrompts.push(body.text);
					control = false;
					return Response.json(result);
				}
				return new Response("unhandled", { status: 404 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify(welcome));
				},
				message() {},
			},
		});
		const client = new WorkbenchClient(new URL(`http://127.0.0.1:${server.port}/cap/`));
		const restoreBrowserHttp = installBrowserHttp(new URL(`http://127.0.0.1:${server.port}/cap/`));
		const unsubscribe = client.subscribe(() => {
			const error = client.getSnapshot().error;
			if (error) errors.push(error);
		});
		const nativeSetTimeout = globalThis.setTimeout;
		const nativeClearTimeout = globalThis.clearTimeout;
		const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
		const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
		const draftTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
		// Only draft scheduling uses this clock; real HTTP/WebSocket timing remains untouched.
		const remember = (text: string): void => {
			Object.defineProperty(globalThis, "setTimeout", {
				configurable: true,
				value: (callback: () => void) => {
					const timer = nativeSetTimeout(() => {}, 60_000);
					draftTimers.set(timer, callback);
					return timer;
				},
			});
			try {
				client.rememberDraft(target, text);
			} finally {
				Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
			}
		};
		const tickDrafts = (): void => {
			for (const [timer, callback] of [...draftTimers]) {
				draftTimers.delete(timer);
				nativeClearTimeout(timer);
				callback();
			}
		};
		Object.defineProperty(globalThis, "clearTimeout", {
			configurable: true,
			value: (timer: ReturnType<typeof setTimeout>) => {
				draftTimers.delete(timer);
				nativeClearTimeout(timer);
			},
		});
		try {
			await client.connect();
			const live = Promise.withResolvers<void>();
			const stop = client.subscribe(() => {
				if (client.getSnapshot().connected) live.resolve();
			});
			if (client.getSnapshot().connected) live.resolve();
			const timeout = nativeSetTimeout(() => live.reject(new Error("Workbench WebSocket did not connect")), 2000);
			try {
				await live.promise;
			} finally {
				nativeClearTimeout(timeout);
				stop();
			}
			for (const kind of ["accepted", "rejected", "unknown"] as const) {
				const text = `${kind} prompt`;
				inputStarted = Promise.withResolvers<void>();
				inputResponse = Promise.withResolvers<DevSubmitResult>();
				remember(` ${text} `);
				const submitted = client.composer(target).sendPrompt(text);
				await inputStarted.promise;
				tickDrafts();
				await expect(client.flushEditor(target)).rejects.toThrow();
				expect(requests.filter(item => item.path.endsWith("/native-editor"))).toHaveLength(
					kind === "unknown" ? 1 : 0,
				);
				const result: DevSubmitResult = kind === "accepted" ? { kind } : { kind, message: `${kind} at host` };
				inputResponse.resolve(result);
				expect(await submitted).toEqual(result);
				await client.flushEditor(target);
				if (kind !== "accepted") expect(requests.at(-1)?.body).toEqual({ target, text: ` ${text} ` });
				expect(client.getSnapshot().error).toBeNull();
			}
			expect(modelPrompts).toEqual(["accepted prompt"]);
			expect(client.getSnapshot().unknownInput).toBe("editor-input-3");
			expect(requests.filter(item => item.path.endsWith("/input"))).toHaveLength(3);
			expect(errors).toEqual([]);

			// A write already on the wire must finish before ordinary input starts.
			editorStarted = Promise.withResolvers<void>();
			editorResponse = Promise.withResolvers<void>();
			remember("retry retained draft");
			const syncing = client.flushEditor(target);
			await editorStarted.promise;
			inputStarted = Promise.withResolvers<void>();
			inputResponse = Promise.withResolvers<DevSubmitResult>();
			const retry = client.composer(target).sendPrompt("retry retained draft");
			remember("newer draft");
			tickDrafts();
			editorResponse.resolve();
			await syncing;
			await inputStarted.promise;
			inputResponse.resolve({ kind: "accepted" });
			expect(await retry).toEqual({ kind: "accepted" });
			editorResponse = null;
			await client.flushEditor(target);
			expect(requests.at(-1)?.body).toEqual({ target, text: "newer draft" });

			// Native slash parsing still sees the current editor before preview/admission.
			inputStarted = Promise.withResolvers<void>();
			inputResponse = Promise.withResolvers<DevSubmitResult>();
			const beforeSlash = requests.length;
			remember("/review");
			const slash = client.composer(target).sendPrompt("/review");
			await inputStarted.promise;
			expect(requests.slice(beforeSlash).map(item => item.path)).toEqual([
				"/cap/api/native-editor",
				"/cap/api/input-preview",
				"/cap/api/input",
			]);
			inputResponse.resolve({ kind: "accepted" });
			expect(await slash).toEqual({ kind: "accepted" });
			expect(modelPrompts).toEqual(["accepted prompt", "retry retained draft", "/review"]);
			expect(errors).toEqual([]);
		} finally {
			inputResponse.resolve({ kind: "rejected", message: "Fixture closed" });
			editorResponse?.resolve();
			unsubscribe();
			client.close();
			for (const timer of draftTimers.keys()) nativeClearTimeout(timer);
			Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
			Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
			try {
				await server.stop(true);
			} finally {
				restoreBrowserHttp();
			}
		}
	});
	it("reconnects browser facts after a guest socket closes without rejoining or replaying input", async () => {
		const guestTarget: DevGuestSessionTarget = {
			kind: "collab",
			peerId: "host-peer",
			roomId: "actual-room",
			sessionId: "remote-native-session",
			generation: 9,
		};
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const eventUrls: URL[] = [];
		let send: (frame: HostFrame) => void = () => {
			throw new Error("Guest socket not open");
		};
		let disconnect = (): void => {
			throw new Error("Guest socket not open");
		};
		const refreshed = snapshot();
		refreshed.record.requirementId = "reconnected-facts";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const url = new URL(request.url);
				if (url.pathname === "/cap/api/events") {
					eventUrls.push(url);
					if (server.upgrade(request)) return;
					return new Response("upgrade rejected", { status: 400 });
				}
				const body: unknown = request.method === "POST" ? await request.json() : null;
				requests.push({ method: request.method, path: url.pathname, body });
				if (url.pathname === "/cap/api/browser") return Response.json({ browserId: "guest-browser" });
				if (url.pathname === "/cap/api/requirements")
					return Response.json(eventUrls.length >= 2 ? [refreshed] : []);
				if (url.pathname === "/cap/api/collab/join") {
					send({ ...welcome, header: { ...welcome.header, id: guestTarget.sessionId } });
					return Response.json({
						peerId: guestTarget.peerId,
						roomId: guestTarget.roomId,
						canWrite: true,
						nativeEditorSupported: false,
						target: guestTarget,
					});
				}
				if (url.pathname === "/cap/api/input-preview")
					return Response.json({ requestId: "guest-input", target: guestTarget });
				if (url.pathname === "/cap/api/input")
					return Response.json({ kind: "unknown", message: "No admission ACK; do not replay" });
				return new Response("unexpected mutation", { status: 400 });
			},
			websocket: {
				open(socket) {
					send = frame => {
						socket.send(JSON.stringify(frame));
					};
					disconnect = () => {
						socket.close(1011, "transient guest disconnect");
					};
					send(welcome);
				},
				message() {},
			},
		});
		const base = new URL(`http://127.0.0.1:${server.port}/cap/`);
		const client = new WorkbenchClient(base);
		const restoreBrowserHttp = installBrowserHttp(base);
		const connections = [client.getSnapshot().connected];
		const unsubscribe = client.subscribe(() => {
			const connected = client.getSnapshot().connected;
			if (connections.at(-1) !== connected) connections.push(connected);
		});
		const waitFor = async (condition: () => boolean): Promise<void> => {
			if (condition()) return;
			const ready = Promise.withResolvers<void>();
			const observe = (): void => {
				if (condition()) ready.resolve();
			};
			const stopClient = client.subscribe(observe);
			const stopReplica = client.replica.subscribe(observe);
			const timeout = setTimeout(() => ready.reject(new Error("Guest connection state did not arrive")), 3000);
			try {
				await ready.promise;
			} finally {
				clearTimeout(timeout);
				stopClient();
				stopReplica();
			}
		};
		try {
			client.select("req-a");
			await client.connect();
			await waitFor(() => client.getSnapshot().connected);
			await client.join("shared-user", "visitor");
			await waitFor(() => client.replica.getSnapshot().header?.id === guestTarget.sessionId);
			expect(await client.composer(guestTarget).sendPrompt("send only once")).toEqual({
				kind: "unknown",
				message: "No admission ACK; do not replay",
			});
			const mutations = requests.filter(request => request.method === "POST");
			expect(mutations.map(request => request.path)).toEqual([
				"/cap/api/collab/join",
				"/cap/api/input-preview",
				"/cap/api/input",
			]);
			disconnect();
			await waitFor(() => !client.getSnapshot().connected && client.replica.getSnapshot().phase === "ended");
			expect(client.getSnapshot().joined).toBeNull();
			await waitFor(
				() =>
					client.getSnapshot().connected &&
					client.getSnapshot().requirements[0]?.record.requirementId === "reconnected-facts",
			);
			expect(connections).toEqual([false, true, false, true]);
			expect(client.getSnapshot().joined).toBeNull();
			expect(client.getSnapshot().unknownInput).toBe("guest-input");
			expect(client.replica.getSnapshot().phase).toBe("ended");
			expect(client.replica.getSnapshot().header?.id).toBe(guestTarget.sessionId);
			expect(eventUrls).toHaveLength(2);
			for (const url of eventUrls) {
				expect(url.searchParams.get("browserId")).toBe("guest-browser");
				expect(url.searchParams.get("requirementId")).toBe("req-a");
			}
			expect(requests.filter(request => request.method === "POST")).toEqual(mutations);
			await client.join("shared-user", "visitor");
			await waitFor(() => client.replica.getSnapshot().phase === "live");
			expect(client.getSnapshot().joined?.target).toEqual(guestTarget);
			expect(requests.filter(request => request.path.endsWith("/collab/join"))).toHaveLength(2);
			expect(requests.filter(request => request.path.endsWith("/input"))).toHaveLength(1);
			expect(requests.some(request => request.path.endsWith("/collab/leave"))).toBe(false);
		} finally {
			try {
				unsubscribe();
				client.close();
				await server.stop(true);
			} finally {
				restoreBrowserHttp();
			}
		}
	});
	it("binds pushed and read-only fetched predictions to the current generation without sending prompts", async () => {
		const target: DevSessionTarget = { requirementId: "req-a", sessionId: "native-session", generation: 4 };
		const current = snapshot();
		current.runtime = {
			requirementId: "req-a",
			generation: 4,
			execution: "idle",
			recipient: { role: "business", actorId: "native", sessionId: target.sessionId },
			history: "available",
		};
		const requests: Array<{ path: string; body: unknown }> = [];
		let send: (frame: unknown) => void = () => {
			throw new Error("Socket not open");
		};
		let readStarted = Promise.withResolvers<void>();
		let readResponse = Promise.withResolvers<{ choices: readonly string[] }>();
		const feedbackReceived = Promise.withResolvers<void>();
		let feedbackCount = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const path = new URL(request.url).pathname;
				if (path.endsWith("/api/events")) {
					if (server.upgrade(request)) return;
					return new Response("upgrade rejected", { status: 400 });
				}
				const body: unknown = request.method === "POST" ? await request.json() : null;
				requests.push({ path, body });
				if (path.endsWith("/api/browser")) return Response.json({ browserId: "prediction-browser" });
				if (path.endsWith("/api/requirements")) return Response.json([current]);
				if (path.endsWith("/api/native-editor")) return Response.json({ updated: true });
				if (path.endsWith("/api/composer-prediction")) {
					if (body && typeof body === "object" && "event" in body) {
						if (++feedbackCount === 2) feedbackReceived.resolve();
						return Response.json({ choices: ["feedback must not replace the pushed choices"] });
					}
					readStarted.resolve();
					return Response.json(await readResponse.promise);
				}
				return new Response("unexpected mutation", { status: 400 });
			},
			websocket: {
				open(socket) {
					send = frame => {
						socket.send(JSON.stringify(frame));
					};
					send(welcome);
					send({ t: "composer-prediction", target, choices: ["first", "second"] });
				},
				message() {},
			},
		});
		const client = new WorkbenchClient(new URL(`http://127.0.0.1:${server.port}/cap/`));
		const restoreBrowserHttp = installBrowserHttp(new URL(`http://127.0.0.1:${server.port}/cap/`));
		const seen: string[] = [];
		const unsubscribe = client.subscribe(() => {
			seen.push(...(client.getSnapshot().composerPrediction?.choices ?? []));
		});
		const waitFor = async (condition: () => boolean): Promise<void> => {
			if (condition()) return;
			const ready = Promise.withResolvers<void>();
			const stop = client.subscribe(() => {
				if (condition()) ready.resolve();
			});
			const timeout = setTimeout(() => ready.reject(new Error("Prediction state did not arrive")), 2000);
			try {
				await ready.promise;
			} finally {
				clearTimeout(timeout);
				stop();
			}
		};
		try {
			client.select("req-a");
			await client.connect();
			await waitFor(() => client.getSnapshot().composerPrediction?.choices[1] === "second");
			const initialRead = client.refreshComposerPrediction(target);
			await readStarted.promise;
			send({ t: "composer-prediction", target: { ...target, generation: 3 }, choices: ["wrong generation"] });
			send({ t: "composer-prediction", target, choices: ["newer push", "alternative"] });
			await waitFor(() => client.getSnapshot().composerPrediction?.choices[0] === "newer push");
			readResponse.resolve({ choices: ["late initial read"] });
			await initialRead;
			expect(client.getSnapshot().composerPrediction?.choices).toEqual(["newer push", "alternative"]);
			expect(seen).not.toContain("wrong generation");
			client.composerPredictionFeedback(target, "shown");
			client.composerPredictionFeedback(target, "accepted", 1);
			await feedbackReceived.promise;
			const predictionBodies = requests
				.filter(item => item.path.endsWith("/composer-prediction"))
				.map(item => item.body);
			expect(predictionBodies).toHaveLength(3);
			expect(predictionBodies).toContainEqual({ target });
			expect(predictionBodies).toContainEqual({ target, event: "shown" });
			expect(predictionBodies).toContainEqual({ target, event: "accepted", rank: 1 });
			client.rememberDraft(target, "alternative");
			await client.flushEditor(target);
			expect(requests.find(item => item.path.endsWith("/native-editor"))?.body).toEqual({
				target,
				text: "alternative",
			});
			readStarted = Promise.withResolvers<void>();
			readResponse = Promise.withResolvers<{ choices: readonly string[] }>();
			const staleRead = client.refreshComposerPrediction(target);
			await readStarted.promise;
			current.runtime!.generation = 5;
			send({ t: "requirement", snapshot: current });
			await waitFor(() => client.target()?.generation === 5 && client.getSnapshot().composerPrediction === null);
			readResponse.resolve({ choices: ["retired session draft"] });
			await staleRead;
			expect(client.getSnapshot().composerPrediction).toBeNull();
			send({ t: "composer-prediction", target: { ...target, generation: 5 }, choices: ["current generation"] });
			await waitFor(() => client.getSnapshot().composerPrediction?.choices[0] === "current generation");
			send({ ...welcome, readOnly: true });
			await waitFor(() => client.getSnapshot().composerPrediction === null);
			const count = requests.length;
			await client.refreshComposerPrediction({ ...target, generation: 5 });
			client.composerPredictionFeedback({ ...target, generation: 5 }, "accepted", 0);
			expect(requests).toHaveLength(count);
			expect(requests.some(item => item.path.endsWith("/input") || item.path.endsWith("/input-preview"))).toBe(
				false,
			);
			expect(seen).not.toContain("retired session draft");
		} finally {
			try {
				unsubscribe();
				client.close();
				readResponse.resolve({ choices: [] });
				await server.stop(true);
			} finally {
				restoreBrowserHttp();
			}
		}
		expect(client.getSnapshot().composerPrediction).toBeNull();
	});
	it("rejects disconnected submission before issuing any input request", async () => {
		const client = new WorkbenchClient(new URL("http://127.0.0.1:1/cap/"));
		expect(await client.submitInput({ requirementId: "req-a" }, "draft")).toEqual({
			kind: "rejected",
			message: "Disconnected; input was not sent",
		});
		await expect(client.create({ source: "import" })).rejects.toThrow("Disconnected; action was not sent");
		await expect(client.preview(snapshot(), { kind: "commit" }, null)).rejects.toThrow(
			"Disconnected; action was not sent",
		);
		client.close();
	});
});
