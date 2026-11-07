import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer, type ComposerEditorUpdate } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient, guestAgentPort, guestComposerPort } from "./lib/client";
import type { AgentPort, ComposerPort, GuestSnapshot } from "./lib/client";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client) {
		return <ConnectScreen defaultName={storedName()} error={connectError} onConnect={connect} />;
	}
	return <Session client={client} onLeave={leave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const composer = useMemo(() => guestComposerPort(client), [client]);
	const agents = useMemo(() => guestAgentPort(client), [client]);
	return (
		<SessionSurface
			snapshot={snap}
			composer={composer}
			agents={agents}
			manageDocumentTitle
			onLeave={onLeave}
			onRejoin={onRejoin}
		/>
	);
}

export interface SessionSurfaceProps {
	snapshot: GuestSnapshot;
	composerIdentity?: string;
	composer: ComposerPort;
	agents: AgentPort;
	manageDocumentTitle?: boolean;
	active?: boolean;
	allowRejoin?: boolean;
	editorUpdate?: ComposerEditorUpdate | null;
	onDraftChange?(text: string, identity: string, edited: boolean): void;
	toolsExpanded?: boolean;
	aboveComposer?: ReactNode;
	belowComposer?: ReactNode;
	onLeave(): void;
	onRejoin(): void;
}

/** Native session presentation shared without sharing connection or execution ownership. */
export function SessionSurface({
	snapshot: snap,
	composer,
	composerIdentity,
	agents,
	active = true,
	allowRejoin = true,
	manageDocumentTitle = false,
	editorUpdate,
	onDraftChange,
	toolsExpanded,
	aboveComposer,
	belowComposer,
	onLeave,
	onRejoin,
}: SessionSurfaceProps): ReactNode {
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			toolsExpanded,
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds, toolsExpanded],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		if (manageDocumentTitle) document.title = `${title} · omp collab`;
	}, [title, manageDocumentTitle]);

	const drawerAgent = active && selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					{aboveComposer}
					<Composer
						client={composer}
						identity={composerIdentity}
						editorUpdate={editorUpdate}
						onDraftChange={onDraftChange}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
					/>
					{belowComposer}
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={agents}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			{snap.phase === "ended" && !allowRejoin ? (
				<div role="status">
					Shared session ended: {snap.endedReason}
					<button type="button" onClick={onLeave}>
						Leave ended guest session
					</button>
				</div>
			) : (
				<Banners
					phase={snap.phase}
					endedReason={snap.endedReason}
					loading={snap.loading}
					onRejoin={onRejoin}
					onNewLink={onLeave}
				/>
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
