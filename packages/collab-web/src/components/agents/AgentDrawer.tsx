import type { AgentSnapshot, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { AgentPort, SubmitResult } from "../../lib/client";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { decideTranscriptPoll } from "../../lib/transcript-poll";
import type { TranscriptProps } from "../transcript/Transcript";
import { Transcript } from "../transcript/Transcript";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;
/** Consecutive unchanged polls of a non-running agent before the loop stops. */
const IDLE_POLLS_BEFORE_STOP = 4;

export function AgentDrawer(props: {
	agent: AgentSnapshot;
	progress?: SubagentProgressPayload;
	lifecycle?: SubagentLifecyclePayload;
	client: AgentPort;
	/** View-link guests: hide kill/revive/chat (the host rejects them anyway). */
	readOnly?: boolean;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	onClose(): void;
}): ReactNode {
	const { agent, progress, lifecycle, client, readOnly, host, onClose } = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [commandError, setCommandError] = useState<string | null>(null);
	const sendCommand = async (cmd: "chat" | "kill" | "revive", text?: string): Promise<SubmitResult> => {
		setSending(true);
		setCommandError(null);
		try {
			const result = await client.sendAgentCmd(cmd, agent.id, text);
			if (result.kind === "rejected" || result.kind === "unknown") setCommandError(result.message);
			return result;
		} catch (error) {
			const message = `Acceptance unknown: ${error instanceof Error ? error.message : String(error)}`;
			setCommandError(message);
			return { kind: "unknown", message };
		} finally {
			setSending(false);
		}
	};
	/** Resumes a stopped poll loop; null while no loop is mounted. */
	const resumePollingRef = useRef<(() => void) | null>(null);
	const quiescentRef = useRef(false);
	quiescentRef.current = agent.status !== "running";

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Live transcript: poll the host-side session file while the drawer is
	// open, appending parsed JSONL entries. State resets when the agent
	// changes; the interval and any in-flight reply are dropped on cleanup.
	// Once the agent is not running, no partial JSONL line is pending, and
	// IDLE_POLLS_BEFORE_STOP consecutive polls find the file unchanged, the
	// loop stops; host activity for the agent resumes it (effect below).
	// A frame-level host error is terminal: stop polling and show it (the
	// host replies with an unchanged cursor, so retrying would loop hot).
	useEffect(() => {
		setEntries([]);
		setFetchError(null);
		if (!agent.hasSessionFile) return;
		let disposed = false;
		let failed = false;
		let inFlight = false;
		let cursor = 0;
		let carry = "";
		let acc: readonly SessionEntry[] = [];
		let idlePolls = 0;
		let timer: Timer | null = null;
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const poll = async (): Promise<void> => {
			if (disposed || failed || inFlight) return;
			inFlight = true;
			try {
				const reply = await client.fetchTranscript(agent.id, cursor);
				if (disposed) return;
				const decision = decideTranscriptPoll(reply, carry);
				switch (decision.action) {
					case "retry":
						return; // timeout/transient → keep polling from the same cursor
					case "stop":
						failed = true;
						stopPolling();
						setFetchError(decision.message);
						return;
					case "advance": {
						const grew = decision.newSize !== cursor;
						cursor = decision.newSize;
						carry = decision.carry;
						if (decision.fresh.length > 0) {
							acc = [...acc, ...decision.fresh];
							setEntries(acc);
						}
						idlePolls = grew || !quiescentRef.current ? 0 : idlePolls + 1;
						if (carry === "" && idlePolls >= IDLE_POLLS_BEFORE_STOP) stopPolling();
						return;
					}
				}
			} finally {
				inFlight = false;
			}
		};
		const startPolling = () => {
			idlePolls = 0;
			void poll();
			timer = setInterval(() => {
				void poll();
			}, POLL_MS);
		};
		resumePollingRef.current = () => {
			if (!disposed && !failed && timer === null) startPolling();
		};
		startPolling();
		return () => {
			disposed = true;
			resumePollingRef.current = null;
			stopPolling();
		};
	}, [agent.id, agent.hasSessionFile, client]);

	// Progress/lifecycle bus frames and status/activity changes for this agent
	// restart a stopped loop; a running loop ignores them.
	useEffect(() => {
		resumePollingRef.current?.();
	}, [progress, lifecycle, agent.status, agent.lastActivity]);

	const sendChat = async (): Promise<void> => {
		const text = draft.trim();
		if (!text || sending) return;
		const result = await sendCommand("chat", text);
		if (result.kind === "accepted" || result.kind === "sent") setDraft(current => (current === draft ? "" : current));
	};

	const p = progress?.progress;
	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;

	return (
		<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{agent.displayName}</span>
					<span className={`ag-chip ag-chip--${agent.status}`}>{agent.status}</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{agent.status === "running" && !readOnly ? (
						<button
							type="button"
							className="ag-btn ag-btn--danger"
							disabled={sending}
							onClick={() => void sendCommand("kill")}
						>
							<OctagonX size={13} aria-hidden />
							kill
						</button>
					) : null}
					{(agent.status === "parked" || agent.status === "aborted") && !readOnly ? (
						<button
							type="button"
							className="ag-btn"
							disabled={sending}
							onClick={() => void sendCommand("revive")}
						>
							<RotateCcw size={13} aria-hidden />
							revive
						</button>
					) : null}
					<button type="button" className="ag-iconbtn" aria-label="close" onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			{p ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">tok</span>
						<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span className="ag-stat" title={`context ${fmtTokens(p.contextTokens ?? 0)}`}>
							<span className="ag-stat-label">ctx</span>
							<span className="ag-gauge">
								<span
									className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
									style={{ width: `${ctxPct}%` }}
								/>
							</span>
						</span>
					) : null}
					<span className="ag-stat">
						<span className="ag-stat-label">cost</span>
						<span className="ag-stat-value">{fmtCost(p.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">tools</span>
						<span className="ag-stat-value">{p.toolCount}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
					</span>
				</div>
			) : null}
			<div className="ag-drawer-body">
				{agent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={agent.status === "running" && fetchError === null}
							host={host}
						/>
						{fetchError !== null ? (
							<div className="ag-fetch-error" role="alert">
								transcript unavailable: {fetchError}
							</div>
						) : null}
					</>
				) : (
					<div className="ag-empty">no transcript available</div>
				)}
			</div>
			{commandError && <div role="alert">{commandError}</div>}
			{!readOnly && (
				<form
					className="ag-chat"
					onSubmit={e => {
						e.preventDefault();
						void sendChat();
					}}
				>
					<input
						className="ag-chat-input"
						value={draft}
						placeholder={`message ${agent.displayName}…`}
						onChange={e => setDraft(e.target.value)}
					/>
					<button
						type="submit"
						className="ag-iconbtn"
						aria-label="send"
						disabled={sending || draft.trim().length === 0}
					>
						<SendHorizontal size={15} aria-hidden />
					</button>
				</form>
			)}
		</aside>
	);
}
