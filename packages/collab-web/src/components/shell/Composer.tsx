import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { CollabDirEntry } from "@oh-my-pi/pi-wire";
import { type CompletionItem, completionItems, directoryArgument } from "../../lib/completion";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;
/** Idle time before a `/move` prefix is sent to the host for directory suggestions. */
const DIR_SUGGEST_DEBOUNCE_MS = 120;

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
			<textarea
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

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [highlight, setHighlight] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const [dirs, setDirs] = useState<readonly CollabDirEntry[]>([]);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && text.trim().length > 0;

	// `/move <prefix>` and `/add-dir <prefix>` ask the host for directory
	// candidates; the effect cancels both the debounce and a late answer, so a
	// stale listing can never replace a newer one.
	const dirPrefix = directoryArgument(text)?.prefix ?? null;
	useEffect(() => {
		if (dirPrefix === null) {
			setDirs([]);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void client.fetchDirSuggestions(dirPrefix).then(entries => {
				if (!cancelled) setDirs(entries ?? []);
			});
		}, DIR_SUGGEST_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [client, dirPrefix]);

	const items = dismissed ? [] : completionItems(text, snapshot.commands, dirs);
	const active = items[Math.min(highlight, items.length - 1)];

	// A new query invalidates both the highlight and an Escape dismissal.
	useEffect(() => {
		setHighlight(0);
		setDismissed(false);
	}, [text]);

	const applyItem = useCallback((item: CompletionItem): void => {
		setText(item.insert);
		taRef.current?.focus();
	}, []);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (items.length > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				setHighlight(index => (index + step + items.length) % items.length);
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				if (active) applyItem(active);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setDismissed(true);
				return;
			}
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
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
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
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
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
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
		<div className="sh-composer">
			{items.length > 0 && (
				<div className="sh-cmd-menu" role="listbox" aria-label="commands">
					{items.map(item => (
						<button
							key={item.key}
							type="button"
							className="sh-cmd-menu-item"
							role="option"
							aria-selected={item === active}
							// mousedown, not click: the textarea must keep focus so a
							// completion can be extended by typing.
							onMouseDown={e => {
								e.preventDefault();
								applyItem(item);
							}}
						>
							<span className="sh-cmd-menu-name">{item.label}</span>
							{item.badge && <span className="sh-cmd-menu-badge">{item.badge}</span>}
							{item.hint && <span className="sh-cmd-menu-hint">{item.hint}</span>}
							{item.description && <span className="sh-cmd-menu-desc">{item.description}</span>}
						</button>
					))}
				</div>
			)}
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
}
