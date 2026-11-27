import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SttTransport, SttWorkerInbound, SttWorkerOutbound } from "@oh-my-pi/pi-coding-agent/stt/asr-protocol";
import { startSttWorker } from "@oh-my-pi/pi-coding-agent/stt/asr-worker";
import { cfgSttLanguage } from "@oh-my-pi/pi-coding-agent/stt/settings";
import * as workerRuntime from "@oh-my-pi/pi-coding-agent/subprocess/worker-runtime";
import { getTinyModelsCacheDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

afterEach(() => vi.restoreAllMocks());

describe("local Whisper language contract", () => {
	let state: SettingsTestState | undefined;
	let temp: TempDir | undefined;

	beforeAll(async () => {
		state = beginSettingsTest();
		temp = await TempDir.create("@omp-stt-whisper-");
		setAgentDir(temp.path());
		// A cold model load prefetches Silero; batch transcription never opens the VAD.
		const vadDir = path.join(getTinyModelsCacheDir(), "istupakov", "silero-vad-onnx");
		await mkdir(vadDir, { recursive: true });
		await Bun.write(path.join(vadDir, "silero_vad.onnx"), "cached VAD fixture");
	});

	afterAll(async () => {
		restoreSettingsTestState(state);
		await temp?.remove();
	});

	it.each([
		{ configured: undefined, modelKey: "whisper-base" },
		{ configured: "zh-CN-u-nu-hanidec", modelKey: "whisper-small" },
		{ configured: "en-US", modelKey: "whisper-large-v3-turbo" },
	])("normalizes %j at the actual inference boundary", async ({ configured, modelKey }) => {
		const settings = Settings.isolated(configured === undefined ? {} : { "stt.language": configured });
		const infer = vi.fn(async (_audio: Float32Array, _options: unknown) => ({ text: " fixture transcript " }));
		const pipeline = vi.fn(async () => infer);
		const runtime = { env: {}, LogLevel: { ERROR: 0 }, pipeline };
		vi.spyOn(workerRuntime, "loadTransformersRuntime").mockResolvedValue(runtime);
		let receive: ((message: SttWorkerInbound) => void) | undefined;
		const completed = Promise.withResolvers<SttWorkerOutbound>();
		const transport: SttTransport = {
			onMessage: handler => {
				receive = handler;
				return () => {};
			},
			send: message => {
				if (message.type === "transcription" || message.type === "error") completed.resolve(message);
			},
		};
		startSttWorker(transport);
		const audio = Float32Array.of(0.2, -0.2);
		if (!receive) throw new Error("STT worker did not register its message handler");
		receive({
			type: "transcribe",
			id: "language-probe",
			modelKey,
			audio,
			language: cfgSttLanguage.get(settings),
		});
		expect(await completed.promise).toEqual({
			type: "transcription",
			id: "language-probe",
			text: "fixture transcript",
		});
		expect(infer).toHaveBeenCalledTimes(1);
		const call = infer.mock.calls[0];
		if (!call) throw new Error("Whisper inference was not called");
		expect(call[0]).toBe(audio);
		expect(call[1]).toMatchObject({
			language: configured === "en-US" ? "en" : "zh",
			task: "transcribe",
		});
	});
});
