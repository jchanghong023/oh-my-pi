import { ChevronDown, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DevInputTarget, DevStage } from "../../../coding-agent/src/spec-driven/types";
import { AgentDrawer } from "../components/agents/AgentDrawer";
import { Composer } from "../components/shell/Composer";
import { Transcript } from "../components/transcript/Transcript";
import type { ComposerPort } from "../lib/client";
import type { ToolRenderHost } from "../tool-render";
import { stripAnsi } from "../tool-render/util";
import { inputTargetIdentity, type WorkbenchClient } from "./client";
import { NativeInteraction } from "./NativeInteraction";

const STAGE_ACTORS: Record<DevStage, string> = {
	business: "业务 Agent",
	requirements: "需求 Agent",
	solution: "方案 Agent",
	planning: "计划 Agent",
	executing: "执行 Agent",
	st: "执行 Agent",
	pr: "执行 Agent",
	testing: "执行 Agent",
};

export interface DevConversationProps {
	client: WorkbenchClient;
	target: DevInputTarget | null;
	stage?: DevStage;
	active: boolean;
	readOnly: boolean;
	enabled: boolean;
	inputReady: boolean;
	operations?: ReactNode;
	onError(message: string): void;
	onLeave(): void;
}

/** Dev owns only presentation; all conversation and approval behavior stays native. */
export function DevConversation({
	client,
	target: viewedTarget,
	stage = "business",
	active,
	readOnly,
	enabled,
	inputReady,
	operations,
	onError,
	onLeave,
}: DevConversationProps): ReactNode {
	const boundTarget = useRef(viewedTarget);
	if (active) boundTarget.current = viewedTarget;
	const target = boundTarget.current;
	const identity = inputTargetIdentity(target);
	const replica = client.replica;
	const subscribe = useCallback((listener: () => void) => replica.subscribe(listener), [replica]);
	const getSnapshot = useCallback(() => replica.getSnapshot(), [replica]);
	const latest = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const frozen = useRef(latest);
	if (active) frozen.current = latest;
	const snap = frozen.current;
	const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
	const nativeView = client.nativeView(target);
	const usable = enabled || (active && state.joined !== null);
	const locked = readOnly || !active || !usable || snap.readOnly || state.joined?.canWrite === false;
	const phase = !state.connected ? "reconnecting" : active && usable && !target ? "live" : snap.phase;
	const composer = useMemo<ComposerPort>(
		() =>
			target
				? client.composer(target)
				: {
						sendPrompt: (text, images) =>
							usable
								? client.submitInputForSelection(text, images)
								: Promise.resolve({ kind: "rejected", message: "请先选择需求或开始业务写作" }),
						sendUiResponse: () => Promise.resolve({ kind: "rejected", message: "当前没有待回答的会话请求" }),
						sendAbort: () => Promise.resolve({ kind: "rejected", message: "当前没有运行中的会话" }),
					},
		[client, identity, usable],
	);
	const onDraftChange = useCallback(
		(text: string, owner: string, edited: boolean) => {
			if (!locked && target && owner === identity) client.rememberDraft(target, text, edited);
		},
		[client, identity, locked],
	);
	const predictionEnabled =
		active &&
		!locked &&
		inputReady &&
		phase === "live" &&
		!snap.working &&
		!snap.uiRequest &&
		!state.nativeUi.some(request => target && request.sessionId === target.sessionId);
	useEffect(() => {
		if (predictionEnabled && target) void client.refreshComposerPrediction(target).catch(() => {});
	}, [client, identity, predictionEnabled]);
	const onPredictionShown = useCallback(() => {
		if (predictionEnabled && target) client.composerPredictionFeedback(target, "shown");
	}, [client, identity, predictionEnabled]);
	const onPredictionAccepted = useCallback(
		(rank: number) => {
			if (predictionEnabled && target) client.composerPredictionFeedback(target, "accepted", rank);
		},
		[client, identity, predictionEnabled],
	);
	const messagePrediction = useMemo(
		() =>
			predictionEnabled &&
			state.composerPrediction &&
			inputTargetIdentity(state.composerPrediction.target) === identity
				? {
						identity,
						choices: state.composerPrediction.choices,
						onShown: onPredictionShown,
						onAccepted: onPredictionAccepted,
					}
				: undefined,
		[identity, predictionEnabled, state.composerPrediction, onPredictionShown, onPredictionAccepted],
	);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const agentIds = useMemo(() => new Set(snap.agents.map(agent => agent.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			toolsExpanded: nativeView?.toolsExpanded,
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedAgent(id);
			},
		}),
		[agentIds, nativeView?.toolsExpanded],
	);
	const drawerAgent = active ? snap.agents.find(agent => agent.id === selectedAgent) : undefined;
	const [joinOpen, setJoinOpen] = useState(false);
	const [usernameOrLink, setUsernameOrLink] = useState("");
	const [name, setName] = useState("");
	const [joining, setJoining] = useState(false);
	const [modelCapability, setModelCapability] = useState<{ identity: string; supported: boolean } | null>(null);
	const [modelPending, setModelPending] = useState<string | null>(null);
	useEffect(() => {
		if (!active || !target || !usable || !state.connected) return;
		let cancelled = false;
		void client.commands(target).then(
			commands => {
				if (!cancelled)
					setModelCapability({ identity, supported: commands.some(command => command.name === "model") });
			},
			() => {
				if (!cancelled) setModelCapability({ identity, supported: false });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [client, target, identity, active, usable, state.connected]);
	const requests = state.nativeUi.filter(
		request =>
			target &&
			request.sessionId === target.sessionId &&
			("kind" in target || request.generation === target.generation),
	);
	const model = snap.state?.model;
	const modelLabel = model && (
		<>
			<span className="dw-model-name">{model.name || model.id}</span>
			{snap.state?.thinkingLevel && <span className="dw-model-effort">{snap.state.thinkingLevel}</span>}
		</>
	);
	const modelControl =
		modelLabel &&
		(modelCapability?.identity === identity && modelCapability.supported ? (
			<button
				type="button"
				className="dw-model-picker"
				aria-label={`切换模型：${model?.name || model?.id}`}
				title="切换当前会话模型，不修改全局配置"
				disabled={
					locked || phase !== "live" || modelPending === identity || requests.length > 0 || !!snap.uiRequest
				}
				onClick={() => {
					if (!target || modelPending === identity) return;
					setModelPending(identity);
					void client
						.nativeCommand(target, "model", [])
						.then(
							result => {
								if (result.kind === "rejected" || result.kind === "unknown") onError(result.message);
							},
							error => onError(String(error)),
						)
						.finally(() => setModelPending(current => (current === identity ? null : current)));
				}}
			>
				{modelLabel}
				<ChevronDown size={12} aria-hidden="true" />
			</button>
		) : (
			<span className="dw-model-label" title={`${model?.provider}/${model?.id}`}>
				{modelLabel}
			</span>
		));
	const widgets = (placement: "aboveEditor" | "belowEditor") =>
		nativeView &&
		Array.from(nativeView.widgets)
			.filter(([, widget]) => widget.placement === placement)
			.map(([key, widget]) => (
				<div className="dw-native-widget" data-native-widget={key} key={key}>
					{widget.content.map(stripAnsi).join("\n")}
				</div>
			));
	return (
		<div className="dw-session" hidden={!active}>
			<header className="dw-chat-header">
				<div className="dw-chat-title">
					<h2>
						<Sparkles size={17} aria-hidden="true" />
						<span className="dw-chat-actor">{STAGE_ACTORS[stage]}</span>
					</h2>
					<span className="dw-chat-badge">Collab</span>
				</div>
				<p className="dw-chat-description">同一需求，共享上下文，一起把事情做完。</p>
			</header>
			<div className="dw-participants" aria-label="会话参与者">
				<div className="dw-participant-list">
					{snap.state?.participants.map((participant, index) => (
						<span
							className="dw-participant"
							key={`${participant.name}:${index}`}
							title={`${participant.name}${participant.readOnly ? " · 只读" : ""}`}
						>
							<span className="dw-participant-avatar" aria-hidden="true">
								{Array.from(participant.name)[0]}
							</span>
							<span className="dw-participant-name">{participant.name}</span>
							{participant.readOnly && <span className="dw-participant-role">只读</span>}
						</span>
					))}
				</div>
				<span className="dw-participant-summary">
					{state.joined
						? state.joined.ended
							? "共享会话已结束"
							: state.joined.canWrite
								? "你已加入"
								: "你已加入 · 只读"
						: snap.state?.participants.length
							? `${snap.state.participants.length} 位参与者`
							: target
								? "当前阶段原生会话"
								: "尚未开始会话"}
				</span>
				{state.joined ? (
					<button type="button" className="dw-collab-toggle" data-action="collab-leave" onClick={onLeave}>
						离开会话
					</button>
				) : (
					<button
						type="button"
						className="dw-collab-toggle"
						data-action="join-session"
						disabled={!state.connected}
						onClick={() => setJoinOpen(true)}
					>
						加入会话
					</button>
				)}
			</div>
			<div className="dw-transcript">
				{!usable ? (
					<div className="dw-empty">选择左侧需求后开始对话，或加入已有共享会话。</div>
				) : (
					<Transcript
						entries={snap.entries}
						stream={snap.stream}
						streamDone={snap.streamDone}
						activeTools={snap.activeTools}
						working={snap.working}
						host={toolHost}
						phase={phase}
					/>
				)}
			</div>
			{operations}
			<div className="dw-composer-wrap">
				{state.statuses.map((status, index) => (
					<p role="status" data-native-status="command" key={index}>
						{stripAnsi(status)}
					</p>
				))}
				{nativeView?.workingMessage && <p role="status">{stripAnsi(nativeView.workingMessage)}</p>}
				{nativeView &&
					Array.from(nativeView.statuses).map(([key, text]) => (
						<p role="status" data-native-status={key} key={key}>
							{stripAnsi(text)}
						</p>
					))}
				{[...snap.notices, ...(nativeView?.notices ?? [])].map((notice, index) => (
					<p role={notice.level === "error" ? "alert" : "status"} key={`${notice.id}:${index}`}>
						{stripAnsi(notice.message)}
					</p>
				))}
				{snap.phase === "ended" && <p role="status">会话已结束：{snap.endedReason}</p>}
				{!state.connected && <p role="status">连接已断开，输入不会自动重发。</p>}
				{state.unknownInput && (
					<button
						type="button"
						onClick={() => {
							void client.inspectInput().then(
								result => onError(result.kind === "accepted" ? "宿主已接收输入" : result.message),
								error => onError(String(error)),
							);
						}}
					>
						查询未确认输入回执
					</button>
				)}
				{requests.map(request => (
					<NativeInteraction
						key={request.requestId}
						client={client}
						request={request}
						readOnly={locked}
						onError={onError}
					/>
				))}
				{widgets("aboveEditor")}
				<Composer
					client={composer}
					variant="dev"
					toolbar={modelControl}
					identity={identity}
					editorUpdate={active ? nativeView?.editorUpdate : null}
					onDraftChange={onDraftChange}
					messagePrediction={messagePrediction}
					phase={phase}
					readOnly={locked || (!inputReady && !snap.uiRequest)}
					uiRequest={snap.uiRequest}
					working={snap.working}
					queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
				/>
				<div className="dw-composer-footnote">Enter 发送 · Shift + Enter 换行</div>
				{widgets("belowEditor")}
			</div>
			{drawerAgent && target && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedAgent(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client.agents(target)}
						readOnly={locked}
						host={toolHost}
						onClose={() => setSelectedAgent(null)}
					/>
				</>
			)}
			{joinOpen && (
				<div className="dw-modal-backdrop">
					<form
						className="dw-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="dw-join-title"
						onSubmit={event => {
							event.preventDefault();
							if (joining) return;
							setJoining(true);
							void client
								.join(usernameOrLink.trim(), name.trim())
								.then(
									() => setJoinOpen(false),
									error => onError(String(error)),
								)
								.finally(() => setJoining(false));
						}}
					>
						<h2 id="dw-join-title">加入共享会话</h2>
						<label>
							用户名或邀请链接
							<input
								aria-label="用户名或邀请链接"
								required
								value={usernameOrLink}
								onChange={event => setUsernameOrLink(event.target.value)}
							/>
						</label>
						<label>
							显示姓名
							<input
								aria-label="加入时显示的姓名"
								required
								value={name}
								onChange={event => setName(event.target.value)}
							/>
						</label>
						<p>使用已有 Collab 路由加入，不会自动跟随下一阶段的 Agent。</p>
						<button type="submit" data-action="collab-join" disabled={joining || !state.connected}>
							加入
						</button>
						<button type="button" disabled={joining} onClick={() => setJoinOpen(false)}>
							取消
						</button>
					</form>
				</div>
			)}
		</div>
	);
}
