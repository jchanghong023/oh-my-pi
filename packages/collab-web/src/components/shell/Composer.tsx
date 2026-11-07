import type { CollabUiRequest, ImageContent } from "@oh-my-pi/pi-wire";
import { Paperclip, SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject, SetStateAction } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComposerPort, ConnectionPhase, SubmitResult } from "../../lib/client";
import { PredictiveTextarea } from "./PredictiveTextarea";
import "./composer-prediction.css";

export interface ComposerProps {
	client: ComposerPort;
	/** Exact owner/session/generation. Changing it never transfers an existing draft. */
	identity?: string;
	editorUpdate?: ComposerEditorUpdate | null;
	onDraftChange?(text: string, identity: string, edited: boolean): void;
	messagePrediction?: ComposerMessagePrediction;
	/** Dev presentation only; ordinary Collab keeps its existing controls and copy. */
	variant?: "default" | "dev";
	toolbar?: ReactNode;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
}

export interface ComposerMessagePrediction {
	identity: string;
	choices: readonly string[];
	onShown(): void;
	onAccepted(rank: number): void;
}

export interface ComposerEditorUpdate {
	identity: string;
	revision: number;
	text: string;
}

export interface ComposerDraft {
	text: string;
	images: readonly ImageContent[];
	attachmentNames: readonly string[];
}
const EMPTY_DRAFT: ComposerDraft = { text: "", images: [], attachmentNames: [] };

/** Ordinary local sent and native owner accepted consume their port's draft; unknown/rejected never do. */
export function settleComposerDraft(current: ComposerDraft, sent: ComposerDraft, result: SubmitResult): ComposerDraft {
	if (result.kind !== "accepted" && result.kind !== "sent") return current;
	return {
		text: current.text === sent.text ? "" : current.text,
		images: current.images === sent.images ? [] : current.images,
		attachmentNames: current.images === sent.images ? [] : current.attachmentNames,
	};
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/** Prediction shortcuts never consume modified keys or an IME confirmation. */
function composerPredictionKey(
	e: KeyboardEvent<HTMLTextAreaElement>,
	composing: boolean,
): "accept" | "previous" | "next" | "dismiss" | null {
	if (composing || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return null;
	if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
	if (e.key === "Tab" || e.key === "ArrowRight") return "accept";
	if (e.key === "ArrowUp") return "previous";
	if (e.key === "ArrowDown") return "next";
	if (e.key === "Escape") return "dismiss";
	return null;
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<PredictiveTextarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	identity = "standalone",
	editorUpdate,
	onDraftChange,
	messagePrediction,
	variant = "default",
	toolbar,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
}: ComposerProps): ReactNode {
	const [drafts, setDrafts] = useState<Readonly<Record<string, ComposerDraft>>>({});
	const draft = drafts[identity] ?? EMPTY_DRAFT;
	const { text, images, attachmentNames } = draft;
	const update = <K extends keyof ComposerDraft>(key: K, value: SetStateAction<ComposerDraft[K]>): void => {
		setDrafts(current => {
			const previous = current[identity] ?? EMPTY_DRAFT;
			const next =
				typeof value === "function" ? (value as (old: ComposerDraft[K]) => ComposerDraft[K])(previous[key]) : value;
			return { ...current, [identity]: { ...previous, [key]: next } };
		});
	};
	const setText = (value: SetStateAction<string>): void => update("text", value);
	const setImages = (value: SetStateAction<readonly ImageContent[]>): void => update("images", value);
	const setAttachmentNames = (value: SetStateAction<readonly string[]>): void => update("attachmentNames", value);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const acceptedPredictionCursor = useRef<{ identity: string; text: string } | null>(null);
	useLayoutEffect(() => {
		const accepted = acceptedPredictionCursor.current;
		if (!accepted) return;
		acceptedPredictionCursor.current = null;
		if (accepted.identity === identity && accepted.text === text)
			taRef.current?.setSelectionRange(text.length, text.length);
	}, [identity, text]);
	const [pending, setPending] = useState(false);
	const [sendError, setSendError] = useState<{ identity: string; message: string } | null>(null);
	const pendingRef = useRef(false);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const appliedEditorUpdates = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		if (
			!editorUpdate ||
			editorUpdate.identity !== identity ||
			appliedEditorUpdates.current.get(identity) === editorUpdate.revision
		)
			return;
		appliedEditorUpdates.current.set(identity, editorUpdate.revision);
		setDrafts(current => {
			const previous = current[identity] ?? EMPTY_DRAFT;
			const retained =
				previous.text && previous.text !== editorUpdate.text
					? { [`${identity}:before-native:${editorUpdate.revision}`]: previous }
					: {};
			return { ...current, ...retained, [identity]: { ...previous, text: editorUpdate.text } };
		});
	}, [identity, editorUpdate]);
	const observedDraft = useRef<{ identity: string; text: string } | null>(null);
	useLayoutEffect(() => {
		const previous = observedDraft.current;
		const edited = previous?.identity === identity && previous.text !== text;
		observedDraft.current = { identity, text };
		onDraftChange?.(text, identity, edited);
	}, [text, identity, onDraftChange]);

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	const canSend = canPrompt && !pending && (text.trim().length > 0 || images.length > 0);
	const [predictionSelection, setPredictionSelection] = useState<{
		prediction: ComposerMessagePrediction;
		rank: number;
	} | null>(null);
	const [dismissedPrediction, setDismissedPrediction] = useState<ComposerMessagePrediction | null>(null);
	const visiblePrediction =
		canPrompt &&
		!pending &&
		!uiRequest &&
		!text &&
		messagePrediction?.identity === identity &&
		messagePrediction.choices.length > 0 &&
		dismissedPrediction !== messagePrediction
			? messagePrediction
			: null;
	const predictionRank = predictionSelection?.prediction === visiblePrediction ? predictionSelection.rank : 0;
	useEffect(() => {
		visiblePrediction?.onShown();
	}, [visiblePrediction]);
	const acceptPrediction = (rank: number): void => {
		if (!visiblePrediction || composingRef.current) return;
		const choice = visiblePrediction.choices[rank];
		if (choice === undefined) return;
		// The existing draft observer handles native-editor sync; accepting never submits or moves attachments.
		acceptedPredictionCursor.current = { identity, text: choice };
		setText(choice);
		visiblePrediction.onAccepted(rank);
		taRef.current?.focus();
	};

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const submit = useCallback(
		async (operation: () => Promise<SubmitResult>): Promise<SubmitResult> => {
			if (pendingRef.current) return { kind: "rejected", message: "Submission already in progress" };
			pendingRef.current = true;
			setPending(true);
			setSendError(null);
			try {
				const result = await operation();
				if (result.kind === "rejected" || result.kind === "unknown")
					setSendError({ identity, message: result.message });
				return result;
			} catch (error) {
				const message = `Acceptance unknown: ${error instanceof Error ? error.message : String(error)}. Draft retained; no automatic resend.`;
				setSendError({ identity, message });
				return { kind: "unknown", message };
			} finally {
				pendingRef.current = false;
				setPending(false);
			}
		},
		[identity],
	);

	const send = useCallback(async (): Promise<void> => {
		const trimmed = text.trim();
		if ((!trimmed && images.length === 0) || !live || readOnly || pendingRef.current) return;
		const result = await submit(() => client.sendPrompt(trimmed, images));
		setDrafts(current => ({
			...current,
			[identity]: settleComposerDraft(current[identity] ?? EMPTY_DRAFT, draft, result),
		}));
	}, [client, live, readOnly, text, images, submit, identity, draft]);

	const attach = async (files: FileList | null): Promise<void> => {
		if (!files) return;
		try {
			const selected = Array.from(files);
			for (const file of selected) {
				if (!file.type.startsWith("image/")) throw new Error(`${file.name}: only image attachments are supported`);
			}
			const loaded = await Promise.all(
				selected.map(
					file =>
						new Promise<ImageContent>((resolve, reject) => {
							const reader = new FileReader();
							reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
							reader.onload = () => {
								const dataUrl = String(reader.result);
								resolve({ type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: file.type });
							};
							reader.readAsDataURL(file);
						}),
				),
			);
			setImages(current => [...current, ...loaded]);
			setAttachmentNames(current => [...current, ...selected.map(file => file.name)]);
		} catch (error) {
			setSendError({ identity, message: error instanceof Error ? error.message : String(error) });
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (visiblePrediction) {
			const action = composerPredictionKey(e, composingRef.current);
			if (action) {
				e.preventDefault();
				if (action === "accept") acceptPrediction(predictionRank);
				else if (action === "dismiss") setDismissedPrediction(visiblePrediction);
				else {
					const count = visiblePrediction.choices.length;
					setPredictionSelection({
						prediction: visiblePrediction,
						rank: (predictionRank + (action === "next" ? 1 : count - 1)) % count,
					});
				}
				return;
			}
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			void send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div
				className={`sh-composer sh-composer-ask${variant === "dev" ? " dw-composer" : ""}`}
				data-testid="composer"
				aria-busy={pending}
			>
				<div className="sh-ask-title">{uiRequest.title}</div>
				{sendError && (
					<div role="alert" data-input-owner={sendError.identity}>
						{sendError.identity}: {sendError.message}
					</div>
				)}
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									disabled={pending}
									onClick={() => void submit(() => client.sendUiResponse(uiRequest.reqId, label))}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => void submit(() => client.sendUiResponse(uiRequest.reqId, value))}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button
						type="button"
						className="sh-btn"
						disabled={pending}
						onClick={() => void submit(() => client.sendUiResponse(uiRequest.reqId))}
					>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => void submit(() => client.sendAbort())}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			className={`sh-composer${variant === "dev" ? " dw-composer" : ""}${visiblePrediction ? " sh-composer-has-prediction" : ""}`}
			data-testid="composer"
			aria-busy={pending}
		>
			{sendError && (
				<div role="alert" data-input-owner={sendError.identity}>
					{sendError.identity}: {sendError.message}
				</div>
			)}
			{Object.entries(drafts).some(([key, value]) => key !== identity && (value.text || value.images.length)) && (
				<details>
					<summary>其他会话保留的草稿（未自动转交）</summary>
					{Object.entries(drafts)
						.filter(([key, value]) => key !== identity && (value.text || value.images.length))
						.map(([key, value]) => (
							<article key={key}>
								<strong>{key}</strong>
								<pre>{value.text}</pre>
								<p>{value.attachmentNames.join(", ")}</p>
								<button
									type="button"
									disabled={pending}
									onClick={() => setDrafts(current => ({ ...current, [identity]: value }))}
								>
									明确复制到当前会话草稿（不发送）
								</button>
							</article>
						))}
				</details>
			)}
			{attachmentNames.map((name, index) => (
				<button
					type="button"
					key={`${index}-${name}`}
					disabled={pending}
					onClick={() => {
						setImages(current => current.filter((_, i) => i !== index));
						setAttachmentNames(current => current.filter((_, i) => i !== index));
					}}
					aria-label={`Remove ${name}`}
				>
					{name} ×
				</button>
			))}
			<div className="sh-composer-inner">
				<PredictiveTextarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					aria-label={variant === "dev" ? "会话输入" : undefined}
					placeholder={
						visiblePrediction
							? visiblePrediction.choices[predictionRank]
							: variant === "dev"
								? readOnly
									? "当前会话只读"
									: live
										? "描述你的想法，或输入 / 使用命令与技能"
										: "等待会话连接…"
								: readOnly
									? "Read-only session — watching only"
									: live
										? "Prompt the host agent…"
										: "Waiting for the session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					<label
						className={`sh-btn${variant === "dev" ? " dw-composer-attach" : ""}`}
						title={variant === "dev" ? "附加图片" : undefined}
					>
						{variant === "dev" ? <Paperclip size={15} aria-hidden="true" /> : "Attach images"}
						<input
							aria-label={variant === "dev" ? "附加图片" : "Attach images"}
							type="file"
							accept="image/*"
							multiple
							disabled={!canPrompt || pending}
							onChange={event => {
								void attach(event.currentTarget.files);
								event.currentTarget.value = "";
							}}
						/>
					</label>
					{toolbar}
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => void submit(() => client.sendAbort())}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => void send()}
						disabled={!canSend}
						aria-label={variant === "dev" ? "发送消息" : undefined}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
			{visiblePrediction && (
				<div className="sh-message-predictions" aria-label="下一条消息预测">
					<span className="sh-message-prediction-hint">Tab / → 插入，不发送 · ↑ / ↓ 选择</span>
					{visiblePrediction.choices.map((choice, rank) => (
						<button
							type="button"
							key={rank}
							className="sh-message-prediction-choice"
							aria-pressed={rank === predictionRank}
							onMouseDown={event => event.preventDefault()}
							onClick={() => acceptPrediction(rank)}
						>
							<span aria-hidden="true">{rank + 1}.</span> {choice}
						</button>
					))}
				</div>
			)}
		</div>
	);
});
