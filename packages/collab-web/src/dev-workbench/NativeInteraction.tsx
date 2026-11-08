import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import type { DevNativeUiRequest, DevNativeUiResponse } from "../../../coding-agent/src/spec-driven/types";
import { Markdown } from "../components/transcript/Markdown";
import { PredictiveTextarea } from "../components/shell/PredictiveTextarea";
import type { WorkbenchClient } from "./client";

interface QuestionAnswer {
	selectedOptions: string[];
	customInput: string;
	note: string;
	noteOption: string;
	customInputImages: ImageContent[];
	noteImages: ImageContent[];
}
const EMPTY_ANSWER: QuestionAnswer = {
	selectedOptions: [],
	customInput: "",
	note: "",
	noteOption: "",
	customInputImages: [],
	noteImages: [],
};

function Images({
	value,
	onChange,
	onError,
	disabled,
	label,
}: {
	value: ImageContent[];
	onChange(images: ImageContent[]): void;
	onError(message: string): void;
	disabled: boolean;
	label: string;
}): ReactNode {
	return (
		<label>
			{label}
			<input
				type="file"
				multiple
				accept="image/*"
				disabled={disabled}
				onChange={event => {
					const files = Array.from(event.currentTarget.files ?? []);
					event.currentTarget.value = "";
					void Promise.all(
						files.map(
							file =>
								// FileReader completion is event-driven; a Promise bridges that native lifecycle.
								new Promise<ImageContent>((resolve, reject) => {
									if (!file.type.startsWith("image/")) {
										reject(new Error(`${file.name}: unsupported image type`));
										return;
									}
									const reader = new FileReader();
									reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
									reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
									reader.onload = () => {
										const data = String(reader.result);
										resolve({ type: "image", data: data.slice(data.indexOf(",") + 1), mimeType: file.type });
									};
									reader.readAsDataURL(file);
								}),
						),
					).then(
						images => onChange([...value, ...images]),
						error => onError(String(error)),
					);
				}}
			/>
			{value.map((image, index) => (
				<span key={index}>
					{image.mimeType} · {Math.ceil(image.data.length * 0.75)} bytes{" "}
					<button type="button" disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>
						移除附件 {index + 1}
					</button>
				</span>
			))}
		</label>
	);
}

/** Answers the actual native wait object; request identity and generation travel unchanged. */
export function NativeInteraction({
	request,
	client,
	onError,
	readOnly = false,
}: {
	request: DevNativeUiRequest;
	client: WorkbenchClient;
	readOnly?: boolean;
	onError(message: string): void;
}): ReactNode {
	const [value, setValue] = useState(request.prefill ?? "");
	const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
	const [sending, setPending] = useState(false);
	const pending = sending || readOnly;
	const respond = async (answer: DevNativeUiResponse["value"]): Promise<void> => {
		if (pending) return;
		setPending(true);
		try {
			await client.respond(request, answer);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	};
	const update = (id: string, patch: Partial<QuestionAnswer>): void =>
		setAnswers(current => ({ ...current, [id]: { ...(current[id] ?? EMPTY_ANSWER), ...patch } }));
	return (
		<section
			className="dw-native-ui"
			role="dialog"
			aria-label={request.title}
			data-native-request={request.requestId}
		>
			<h3>{request.title}</h3>
			<small>
				{request.sessionId} · generation {request.generation}
			</small>
			{request.kind === "approve" ? (
				<>
					{request.approval ? (
						<>
							<Markdown text={request.approval.full} />
							<button type="button" disabled={pending} onClick={() => void respond("once")}>
								仅本次批准
							</button>
							{request.approval.session && (
								<button type="button" disabled={pending} onClick={() => void respond("session")}>
									{request.approval.session}
								</button>
							)}
							{request.approval.grants?.map(grant => (
								<span key={grant.scope}>
									<button
										type="button"
										disabled={pending}
										onClick={() => void respond({ grant: grant.scope, always: false })}
									>
										{grant.label}
									</button>
									<button
										type="button"
										disabled={pending}
										onClick={() => void respond({ grant: grant.scope, always: true })}
									>
										{grant.alwaysLabel}
									</button>
								</span>
							))}
							<button type="button" disabled={pending} onClick={() => void respond("deny")}>
								拒绝
							</button>
						</>
					) : (
						<p role="alert">宿主未提供审批范围，不能批准。</p>
					)}
				</>
			) : request.kind === "ask" ? (
				<>
					{request.questions?.map(question => {
						const answer = answers[question.id] ?? EMPTY_ANSWER;
						return (
							<fieldset key={question.id} disabled={pending}>
								<legend>{question.header ?? question.id}</legend>
								<Markdown text={question.question} />
								{question.options.map((option, index) => (
									<label key={index}>
										<span>
											<input
												type={question.multi ? "checkbox" : "radio"}
												name={`${request.requestId}-${question.id}`}
												checked={answer.selectedOptions.includes(option.label)}
												onChange={event =>
													update(question.id, {
														selectedOptions: question.multi
															? event.target.checked
																? [...answer.selectedOptions, option.label]
																: answer.selectedOptions.filter(label => label !== option.label)
															: [option.label],
													})
												}
											/>{" "}
											{option.label}
											{question.recommended === index ? "（推荐，但未代选）" : ""}
										</span>
										{option.description && <Markdown text={option.description} />}
										{option.preview && <Markdown text={option.preview} />}
									</label>
								))}
								<label>
									自定义答案（保留原文）
									<PredictiveTextarea
										value={answer.customInput}
										onChange={event => update(question.id, { customInput: event.target.value })}
									/>
								</label>
								<Images
									label="答案附件"
									value={answer.customInputImages}
									disabled={pending}
									onError={onError}
									onChange={customInputImages => update(question.id, { customInputImages })}
								/>
								<label>
									补充说明
									<PredictiveTextarea
										value={answer.note}
										onChange={event => update(question.id, { note: event.target.value })}
									/>
								</label>
								<label>
									说明对应的选项
									<select
										value={answer.noteOption}
										onChange={event => update(question.id, { noteOption: event.target.value })}
									>
										<option value="">自定义答案</option>
										{question.options.map(option => (
											<option key={option.label} value={option.label}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<Images
									label="说明附件"
									value={answer.noteImages}
									disabled={pending}
									onError={onError}
									onChange={noteImages => update(question.id, { noteImages })}
								/>
							</fieldset>
						);
					})}
					<button
						type="button"
						disabled={pending || !request.questions?.length}
						onClick={() =>
							void respond({
								kind: "submit",
								results: (request.questions ?? []).map(question => {
									const answer = answers[question.id] ?? EMPTY_ANSWER;
									return {
										id: question.id,
										question: question.question,
										options: question.options.map(option => option.label),
										multi: question.multi ?? false,
										selectedOptions: answer.selectedOptions,
										customInput: answer.customInput,
										customInputImages: answer.customInputImages,
										note: answer.note,
										noteImages: answer.noteImages,
										noteOption: answer.noteOption || undefined,
									};
								}),
							})
						}
					>
						提交全部问题的原始回答
					</button>
					<button type="button" disabled={pending} onClick={() => void respond({ kind: "chat" })}>
						讨论此问题
					</button>
				</>
			) : request.kind === "select" ? (
				request.options?.map((option, index) => (
					<button
						type="button"
						disabled={pending}
						key={index}
						onClick={() => void respond(typeof option === "string" ? option : option.label)}
					>
						{typeof option === "string" ? (
							option
						) : (
							<>
								{option.label}
								<small>{option.description}</small>
							</>
						)}
					</button>
				))
			) : request.kind === "confirm" ? (
				<>
					<button type="button" disabled={pending} onClick={() => void respond(true)}>
						确认
					</button>
					<button type="button" disabled={pending} onClick={() => void respond(false)}>
						拒绝
					</button>
				</>
			) : (
				<>
					{request.secret ? (
						<input
							type="password"
							aria-label={request.title}
							autoComplete="off"
							value={value}
							disabled={pending}
							onChange={event => setValue(event.target.value)}
						/>
					) : (
						<PredictiveTextarea
							value={value}
							disabled={pending}
							onChange={event => setValue(event.target.value)}
						/>
					)}
					<button type="button" disabled={pending} onClick={() => void respond(value)}>
						提交原文
					</button>
				</>
			)}
			<button type="button" disabled={pending} onClick={() => void respond(null)}>
				取消（不授权）
			</button>
		</section>
	);
}
