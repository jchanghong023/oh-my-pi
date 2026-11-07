import type { CSSProperties, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./prediction.css";

export interface TextPredictionPort {
	complete(text: string, cursor: number): Promise<{ suffix: string | null }>;
	feedback(text: string, cursor: number, suffix: string, accepted: boolean): void;
}

/** Only the Dev workbench supplies a backend; ordinary Collab remains a plain textarea. */
export const TextPredictionContext = createContext<TextPredictionPort | null>(null);

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> };
interface Suggestion {
	text: string;
	cursor: number;
	suffix: string;
}

export function PredictiveTextarea({ ref, ...props }: Props): ReactNode {
	const port = useContext(TextPredictionContext);
	const element = useRef<HTMLTextAreaElement | null>(null);
	const mirror = useRef<HTMLDivElement | null>(null);
	const composing = useRef(false);
	const accepting = useRef(false);
	const [compositionActive, setCompositionActive] = useState(false);
	const [focused, setFocused] = useState(false);
	const [cursor, setCursor] = useState(-1);
	const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
	const [mirrorStyle, setMirrorStyle] = useState<CSSProperties>({});
	const value = String(props.value ?? "");
	const enabled = !!port && focused && !props.disabled && !props.readOnly && !compositionActive && cursor >= 0;
	const shown = enabled && suggestion?.text === value && suggestion.cursor === cursor ? suggestion : null;
	const observeCursor = (): void => {
		const input = element.current;
		setCursor(input && input.selectionStart === input.selectionEnd ? input.selectionStart : -1);
	};
	useEffect(() => {
		setSuggestion(null);
		if (!enabled || !port || !value) return;
		let current = true;
		const timer = setTimeout(() => {
			void port.complete(value, cursor).then(
				result => {
					if (current && result.suffix) setSuggestion({ text: value, cursor, suffix: result.suffix });
				},
				() => {},
			);
		}, 120);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [port, value, cursor, enabled]);
	useLayoutEffect(() => {
		const input = element.current;
		if (!port || !input) return;
		const style = getComputedStyle(input);
		setMirrorStyle({
			width: input.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth),
			font: style.font,
			letterSpacing: style.letterSpacing,
			lineHeight: style.lineHeight,
			padding: style.padding,
			borderWidth: style.borderWidth,
			borderStyle: "solid",
			borderColor: "transparent",
			textAlign: style.textAlign as CSSProperties["textAlign"],
			tabSize: style.tabSize,
			textIndent: style.textIndent,
		});
		if (mirror.current) {
			mirror.current.scrollTop = input.scrollTop;
			mirror.current.scrollLeft = input.scrollLeft;
		}
	}, [port, value, focused, shown?.suffix]);
	const input = (
		<textarea
			{...props}
			ref={node => {
				element.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) ref.current = node;
			}}
			onFocus={event => {
				setFocused(true);
				observeCursor();
				props.onFocus?.(event);
			}}
			onBlur={event => {
				setFocused(false);
				props.onBlur?.(event);
			}}
			onSelect={event => {
				observeCursor();
				props.onSelect?.(event);
			}}
			onChange={event => {
				if (shown && !composing.current && !accepting.current) {
					const next = event.currentTarget.value;
					const typed = next.slice(cursor, next.length - (value.length - cursor));
					const overlap = Math.min(typed.length, shown.suffix.length);
					if (
						overlap > 0 &&
						shown.suffix.slice(0, overlap).toLocaleLowerCase() !== typed.slice(0, overlap).toLocaleLowerCase()
					)
						port?.feedback(value, cursor, shown.suffix, false);
				}
				setSuggestion(null);
				observeCursor();
				props.onChange?.(event);
			}}
			onKeyDown={event => {
				if (
					shown &&
					!composing.current &&
					!event.nativeEvent.isComposing &&
					event.nativeEvent.keyCode !== 229 &&
					!event.altKey &&
					!event.ctrlKey &&
					!event.metaKey &&
					!event.shiftKey &&
					(event.key === "Tab" || event.key === "ArrowRight")
				) {
					event.preventDefault();
					port?.feedback(value, cursor, shown.suffix, true);
					const inserted = shown.suffix + (event.key === "Tab" ? " " : "");
					const next = value.slice(0, cursor) + inserted + value.slice(cursor);
					// Use the native setter/event so React and existing draft handlers see an ordinary edit.
					const input = event.currentTarget;
					const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
					if (setter) setter.call(input, next);
					else input.value = next;
					input.setSelectionRange(cursor + inserted.length, cursor + inserted.length);
					accepting.current = true;
					try {
						const change = input.ownerDocument.createEvent("Event");
						change.initEvent("input", true, false);
						input.dispatchEvent(change);
					} finally {
						accepting.current = false;
					}
					setSuggestion(null);
					observeCursor();
					return;
				}
				if (event.key === "Escape") setSuggestion(null);
				props.onKeyDown?.(event);
			}}
			onCompositionStart={event => {
				setCompositionActive(true);
				composing.current = true;
				setSuggestion(null);
				props.onCompositionStart?.(event);
			}}
			onCompositionEnd={event => {
				// Keep the confirming key out of prediction acceptance (including WebKit ordering).
				setTimeout(() => {
					composing.current = false;
					setCompositionActive(false);
					observeCursor();
				}, 0);
				props.onCompositionEnd?.(event);
			}}
			onScroll={event => {
				const mirror = event.currentTarget.nextElementSibling;
				if (mirror) {
					mirror.scrollTop = event.currentTarget.scrollTop;
					mirror.scrollLeft = event.currentTarget.scrollLeft;
				}
				props.onScroll?.(event);
			}}
		/>
	);
	if (!port) return input;
	return (
		<div className="sh-predictive-textarea">
			{input}
			<div ref={mirror} className="sh-prediction-mirror" aria-hidden="true" style={mirrorStyle}>
				{value.slice(0, cursor)}
				{shown && <span className="sh-word-prediction">{shown.suffix}</span>}
				{value.slice(cursor)}
			</div>
		</div>
	);
}
