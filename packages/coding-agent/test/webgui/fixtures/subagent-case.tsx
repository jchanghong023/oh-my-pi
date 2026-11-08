import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { useEffect, useState, useSyncExternalStore } from "react";
import { conversationSnapshotSchema, conversationTopic, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { SortableSidePaneTabTrigger } from "@/app-shell/SidePaneTabTrigger.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
	openSubagentSessionSidePane,
	setActiveSidePaneTab,
	closeSidePaneTab,
	closeOtherSidePaneTabs,
	closeAllSidePaneTabs,
	type WorkspaceSidePaneState,
	type OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { ConversationTransport } from "@/v4/transport.js";

const workspacePath = "/core-ui-subagents";
const parentId = "core-parent-history";
const childA = "core-child-a";
const childB = "core-child-b";
const base = { turnId: "turn-1", createdAt: 1, createdAtSeq: 1 };
const assistant = (text: string): ConversationRow => ({
	...base,
	rowId: 1,
	kind: "assistantText",
	text,
	state: "complete",
});
const unsupported = (): never => {
	throw new Error("Unexpected transport operation in subagent presentation integration");
};
const off = () => undefined;

function createProjection(sessionId: string, text: string) {
	let rows = [assistant(text)];
	let seq = 1;
	const snapshot = () =>
		conversationSnapshotSchema.parse({
			protocolVersion: 1,
			sessionId,
			logEpoch: `core-${sessionId}`,
			seq,
			revision: seq,
			control: {
				phase: "completedSuccess",
				sessionEnded: true,
				canStop: false,
				stopState: "idle",
				stopTargetKind: "unknown",
				activeWorks: [],
				lastError: null,
				apiRetry: null,
			},
			availability: Object.fromEntries(
				[
					"fork",
					"compact",
					"switchModelConfig",
					"setFollowupMode",
					"queueEdit",
					"sendQueuedNow",
					"pauseGoal",
					"resumeGoal",
				].map(key => [key, { allowed: false, reasonCode: "guard.presentationOnly" }]),
			),
			inputRouting: { mode: "startNow" },
			meta: { title: sessionId, titleSource: "custom" },
			config: { provider: "", model: "", thought: "off", followupMode: "queue", mode: "build" },
			usage: {
				contextWindow: null,
				cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			},
			queue: { items: [], autoDrain: false },
			pendingInteractions: [],
			pendingCommands: [],
			backgroundWorks: [],
			goal: null,
			plan: null,
			rows: { window: rows, totalCount: rows.length, firstRowId: 1 },
		});
	const subscriptionId = `fixture-${sessionId}`;
	const publish = (initial = false) =>
		store.handleFrame(
			{
				topic: conversationTopic(sessionId),
				subscriptionId,
				fromSeq: 0,
				toSeq: seq,
				sentAt: 1,
				payload: { kind: "snapshot", snapshot: snapshot() },
			},
			{ deliveryKind: initial ? "initial" : "online" },
		);
	const transport: ConversationTransport = {
		subscribe: async () => ({ ack: { subscriptionId, mode: "snapshot", logEpoch: `core-${sessionId}` } }),
		activate: () => publish(true),
		unsubscribe: async () => undefined,
		onAssemblyFault: () => off,
		onRuntimeRestart: () => off,
		onFrame: () => off,
		resync: unsupported,
		sendCommand: unsupported,
		queryCommands: unsupported,
		rowsRange: unsupported,
		plans: unsupported,
		workflowRunEvents: unsupported,
		workflowRuns: unsupported,
		workflowRunArtifacts: unsupported,
		workflowRunArtifactData: unsupported,
		workflowRunArtifactRead: unsupported,
		workflowRunWorkspace: unsupported,
		workflowRunNodeResult: unsupported,
		fileChanges: unsupported,
		fileRewindPreview: unsupported,
		attachmentPut: unsupported,
		attachmentRead: unsupported,
		attachmentReadRange: unsupported,
	};
	const store = new ConversationProjectionStore(conversationTopic(sessionId), transport);
	return {
		store,
		update(text: string) {
			rows = [assistant(text)];
			seq += 1;
			publish();
		},
	};
}

interface Projection {
	store: ConversationProjectionStore;
	update(text: string): void;
}

function Transcript({ projection, sessionId }: { projection: Projection; sessionId: string }) {
	const state = useSyncExternalStore(
		listener => projection.store.subscribe(listener),
		() => projection.store.getState(),
	);
	const context: ConversationRowRenderContext = {
		workspacePath,
		sessionId,
		rootSessionId: parentId,
		theme: "light",
		codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
	};
	return (
		<div data-testid="core-transcript" data-session-id={sessionId} data-projection-seq={state.snapshot?.seq}>
			{state.snapshot?.rows.window.map(row => (
				<ConversationRowView key={row.rowId} row={row} context={context} hideAssistantActions />
			))}
		</div>
	);
}

/** UI/presentation integration only: no native child execution or child-input policy assertion. */
export function SubagentCase() {
	const [projections] = useState<Record<string, Projection>>(() => ({
		[parentId]: createProjection(parentId, "PARENT_HISTORY_ASSISTANT"),
		[childA]: createProjection(childA, "CHILD_A_ASSISTANT"),
		[childB]: createProjection(childB, "CHILD_B_ASSISTANT"),
	}));
	const [tabs, setTabs] = useState<WorkspaceSidePaneState | null>(null);
	const tabDragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let mounted = true;
		void Promise.all(Object.values(projections).map(projection => projection.store.connect())).then(() => {
			if (mounted) setReady(true);
		});
		return () => {
			mounted = false;
			for (const projection of Object.values(projections)) void projection.store.close();
		};
	}, [projections]);
	const openChild = (request: OpenSubagentSideTabRequest) => {
		setTabs(current =>
			openSubagentSessionSidePane(current, { ...request, workspacePath, workspaceKey: workspacePath }),
		);
	};
	const context: ConversationRowRenderContext = {
		workspacePath,
		sessionId: parentId,
		rootSessionId: parentId,
		theme: "light",
		codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
		onOpenSubagentSession: openChild,
	};
	return (
		<ZCodeIntlProvider>
			<main data-testid="core-subagent-case" data-ready={ready ? "true" : "false"}>
				<h1>Subagent UI/presentation integration</h1>
				<section data-testid="core-parent-history" data-session-id={parentId}>
					<Transcript sessionId={parentId} projection={projections[parentId]} />
					{[childA, childB].map((childSessionId, index) => (
						<ConversationAgentToolCallRow
							key={childSessionId}
							context={context}
							item={{
								kind: "agentToolCall",
								key: childSessionId,
								row: {
									...base,
									rowId: 10 + index,
									kind: "toolCall",
									toolCallId: `call-${childSessionId}`,
									toolName: "Agent",
									status: "success",
									inputText: JSON.stringify({
										description: `Inspect ${childSessionId}`,
										subagent_type: "general-purpose",
										prompt: "Inspect fixture",
									}),
									input: {
										description: `Inspect ${childSessionId}`,
										subagent_type: "general-purpose",
										prompt: "Inspect fixture",
									},
								},
								subagentRow: {
									...base,
									rowId: 20 + index,
									kind: "subagent",
									parentToolCallId: `call-${childSessionId}`,
									childSessionId,
									subagentType: "general-purpose",
									status: "success",
									summaryText: `Inspect ${childSessionId}`,
								},
							}}
						/>
					))}
				</section>
				<button
					type="button"
					data-testid="core-update-hidden-a"
					onClick={() => projections[childA].update("CHILD_A_ASSISTANT_UPDATED")}
				>
					Publish child A snapshot
				</button>
				{tabs && (
					<DndContext sensors={tabDragSensors}>
						<SortableContext items={tabs.tabs.map(tab => tab.id)} strategy={horizontalListSortingStrategy}>
							<Tabs
								value={tabs.activeTabId}
								onValueChange={id => setTabs(current => setActiveSidePaneTab(current, id))}
							>
								<TabsList>
									{tabs.tabs.map(tab => (
										<SortableSidePaneTabTrigger
											key={tab.id}
											tab={tab}
											title={tab.type === "subagent-session" ? tab.title : tab.id}
											closeTabLabel="Close"
											closeTabMenuLabel="Close tab"
											closeOtherTabsLabel="Close others"
											closeAllTabsLabel="Close all"
											diffBadgeLabel="Changes"
											isActive={tabs.activeTabId === tab.id}
											canCloseOtherTabs={tabs.tabs.length > 1}
											onActivateTab={id => setTabs(current => setActiveSidePaneTab(current, id))}
											onCloseTab={id => setTabs(current => closeSidePaneTab(current, id))}
											onCloseOtherTabs={id => setTabs(current => closeOtherSidePaneTabs(current, id))}
											onCloseAllTabs={() => setTabs(closeAllSidePaneTabs())}
										/>
									))}
								</TabsList>
								{tabs.tabs.map(
									tab =>
										tab.type === "subagent-session" && (
											<TabsContent key={tab.id} value={tab.id}>
												<Transcript
													sessionId={tab.childSessionId}
													projection={projections[tab.childSessionId]}
												/>
											</TabsContent>
										),
								)}
							</Tabs>
						</SortableContext>
					</DndContext>
				)}
			</main>
		</ZCodeIntlProvider>
	);
}
