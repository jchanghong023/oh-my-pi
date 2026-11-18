import type { TinyModelDtype } from "../tiny/dtype";
import { dictationDefaultSelectors } from "./settings";

/**
 * On-device speech-to-text model registry. Each tier maps a stable settings key
 * onto a locally-runnable ASR model and the engine that loads it:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline or native streaming model,
 *   loaded by the native `sherpa-onnx-node` addon. Used for NVIDIA Parakeet
 *   and Nemotron.
 *
 * The worker resolves the spec by key and loads the model lazily (kept warm
 * afterwards). Both engines run inside the hard-killed subprocess worker.
 */

/** ASR runtime that loads a given tier's model. */
export type SttEngine = "transformers" | "sherpa";

interface SttModelBase {
	/** Canonical catalog model id sent over the worker protocol. */
	key: string;
	engine: SttEngine;
	/** Hugging Face repo id (transformers.js ONNX repo, or sherpa-onnx model repo). */
	repo: string;
	/** English-only checkpoint: rejects a configured source `language`. */
	englishOnly: boolean;
	label: string;
	description: string;
	/** Approximate on-disk download size for the shipped weights (UI hint). */
	sizeHint: string;
}

/** A Whisper-family tier loaded via the transformers.js ASR pipeline. */
export interface TransformersSttModelSpec extends SttModelBase {
	engine: "transformers";
	/** ONNX precision used unless overridden by `PI_TINY_DTYPE` / `providers.tinyModelDtype`. */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx tier loaded natively, with offline or online recognition. */
export interface SherpaSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** Recognizer API: offline utterance decoding or native online streaming. */
	mode: "offline" | "online";
	/** sherpa-onnx model family (e.g. `nemo_transducer`); empty for automatic detection. */
	modelType: string;
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec;

/**
 * Speech models supported by the local worker.
 * Whisper uses transformers.js; Parakeet and native streaming Nemotron use
 * sherpa-onnx.
 */
export const STT_MODELS = [
	{
		key: "whisper-base",
		engine: "transformers",
		repo: "onnx-community/whisper-base",
		dtype: "q8",
		englishOnly: false,
		label: "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
		sizeHint: "~60 MB",
	},
	{
		key: "whisper-small",
		engine: "transformers",
		repo: "onnx-community/whisper-small",
		dtype: "q8",
		englishOnly: false,
		label: "Balanced (Whisper small)",
		description: "Whisper small, multilingual. More accurate than Fast, still light on CPU/RAM.",
		sizeHint: "~190 MB",
	},
	{
		key: "whisper-large-v3-turbo",
		engine: "transformers",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "q4",
		englishOnly: false,
		label: "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
		sizeHint: "~600 MB",
	},
	{
		key: "parakeet-tdt-0.6b-v3",
		engine: "sherpa",
		mode: "offline",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: false,
		label: "Parakeet TDT v3 (SoTA)",
		description:
			"NVIDIA Parakeet TDT 0.6B v3, 25 European languages. Open ASR Leaderboard leader — best accuracy and far fastest decoding.",
		sizeHint: "~680 MB",
	},
	{
		key: "nemotron-streaming-en-0.6b",
		engine: "sherpa",
		mode: "online",
		repo: "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25",
		modelType: "",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: true,
		label: "Nemotron 0.6B (live streaming, English)",
		description:
			"NVIDIA Nemotron Speech 0.6B, English only. Native streaming recognition with live words while you speak; 160 ms audio chunks.",
		sizeHint: "~630 MB",
	},
] as const satisfies readonly SttModelSpec[];

export type SttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}; `key` is the literal tier union. */
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_VALUES = [
	"whisper-base",
	"whisper-small",
	"whisper-large-v3-turbo",
	"parakeet-tdt-0.6b-v3",
	"nemotron-streaming-en-0.6b",
] as const satisfies readonly SttModelKey[];

type MissingSttModelValue = Exclude<SttModelKey, (typeof STT_MODEL_VALUES)[number]>;
type ExtraSttModelValue = Exclude<(typeof STT_MODEL_VALUES)[number], SttModelKey>;
const STT_MODEL_VALUES_MATCH_REGISTRY: MissingSttModelValue extends never
	? ExtraSttModelValue extends never
		? true
		: never
	: never = true;
void STT_MODEL_VALUES_MATCH_REGISTRY;

export const STT_MODEL_OPTIONS = STT_MODELS.map(({ key, label, description }) => ({
	value: key,
	label,
	description,
})) satisfies ReadonlyArray<{ value: SttModelKey; label: string; description: string }>;

export function isSttModelKey(value: string): value is SttModelKey {
	return STT_MODELS.some(model => model.key === value);
}

export function getSttModelSpec(key: string): SttModel | undefined {
	return STT_MODELS.find(model => model.key === key);
}

/** Resolve the first available local model in the language's catalog policy. */
export function getDefaultLocalSttModel(language?: string): SttModel {
	for (const selector of dictationDefaultSelectors(language)) {
		if (!selector.startsWith("local/")) continue;
		const model = getSttModelSpec(selector.slice("local/".length));
		if (model) return model;
	}
	throw new Error("Catalog dictation defaults must include a supported local model.");
}

/** Resolve a catalog model id, falling back to the language's default when unknown. */
export function resolveSttModelSpec(key: string | undefined, language?: string): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getDefaultLocalSttModel(language);
}
