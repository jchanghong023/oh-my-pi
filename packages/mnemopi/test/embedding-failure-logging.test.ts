import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	available,
	embed,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

async function withLocalModelEnv(fn: () => Promise<void>): Promise<void> {
	const snapshot = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
	resetEmbeddingProviderForTests();
	try {
		await fn();
	} finally {
		for (const [key, value] of snapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => resetEmbeddingProviderForTests());

describe("embedding failure logging", () => {
	for (const debug of [false, true]) {
		it(`keeps initialization failure nonfatal and redacted with runtime debug ${debug}`, async () => {
			const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
			const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				await withLocalModelEnv(async () => {
					setLocalModelInitializerForTests(async () => {
						throw new Error("PRIVATEEMBEDDINGINIT /private/model.onnx Bearer PRIVATEKEY");
					});
					expect(await withMnemopiRuntimeOptions({ debug }, () => embed(["private input"]))).toBeNull();
					const selected = debug ? warnSpy : debugSpy;
					expect(selected).toHaveBeenCalledWith(
						"mnemopi: local embedding model failed to load",
						expect.objectContaining({ model: expect.any(String), error_type: "Error" }),
					);
					const serialized = JSON.stringify(selected.mock.calls);
					expect(serialized).not.toContain("PRIVATEEMBEDDINGINIT");
					expect(serialized).not.toContain("PRIVATEKEY");
					expect(serialized).not.toContain("/private/model.onnx");
				});
			} finally {
				debugSpy.mockRestore();
				warnSpy.mockRestore();
			}
		});
	}

	it("redacts local inference failures while preserving the null fallback", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			await withLocalModelEnv(async () => {
				setLocalModelInitializerForTests(async () => ({
					embed() {
						throw new Error("PRIVATEEMBEDDINGCOMPUTE /private/model.onnx");
					},
				}));
				expect(await embed(["PRIVATEINPUT"])).toBeNull();
				expect(debugSpy).toHaveBeenCalledWith(
					"mnemopi: local embedding failed",
					expect.objectContaining({ textCount: 1, error_type: "Error" }),
				);
				expect(JSON.stringify(debugSpy.mock.calls)).not.toContain("PRIVATEEMBEDDINGCOMPUTE");
				expect(JSON.stringify(debugSpy.mock.calls)).not.toContain("PRIVATEINPUT");
				expect(JSON.stringify(debugSpy.mock.calls)).not.toContain("/private/model.onnx");
			});
		} finally {
			debugSpy.mockRestore();
		}
	});
});

describe("embedding provider failure logging", () => {
	// embed()/available() short-circuit on MNEMOPI_NO_EMBEDDINGS; keep an ambient value from masking the provider path.
	let savedNoEmbeddings: string | undefined;
	beforeEach(() => {
		savedNoEmbeddings = process.env.MNEMOPI_NO_EMBEDDINGS;
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
	});
	afterEach(() => {
		if (savedNoEmbeddings === undefined) {
			delete process.env.MNEMOPI_NO_EMBEDDINGS;
		} else {
			process.env.MNEMOPI_NO_EMBEDDINGS = savedNoEmbeddings;
		}
	});

	// Fails mid-stream, the way a provider whose backend drops does.
	const failingProvider = (message: string) => ({
		embed: async function* (_texts: readonly string[]): AsyncGenerator<number[][]> {
			yield* [];
			throw new Error(message);
		},
	});

	it("logs a failing runtime provider at debug level and still returns null", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await withMnemopiRuntimeOptions(
				{ embeddings: { provider: failingProvider("provider exploded") } },
				() => embed(["one", "two"]),
			);

			expect(result).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ textCount: 2, error: expect.stringContaining("provider exploded") }),
			);
			expect(warnSpy).not.toHaveBeenCalledWith("mnemopi: embedding provider failed", expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("escalates a failing runtime provider to warn when runtime debug is enabled", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await withMnemopiRuntimeOptions(
				{ debug: true, embeddings: { provider: failingProvider("provider exploded again") } },
				() => embed(["hello"]),
			);

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ error: expect.stringContaining("provider exploded again") }),
			);
			expect(debugSpy).not.toHaveBeenCalledWith("mnemopi: embedding provider failed", expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("logs a failing provider installed with setEmbeddingProvider", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			setEmbeddingProviderForTests(failingProvider("override exploded"));

			expect(await embed(["hello"])).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ textCount: 1, error: expect.stringContaining("override exploded") }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("logs a provider whose availability check throws and reports it unavailable", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			setEmbeddingProviderForTests({
				embed: async function* (texts: readonly string[]): AsyncGenerator<number[][]> {
					yield texts.map(() => [0.1]);
				},
				available: () => {
					throw new Error("availability probe exploded");
				},
			});

			expect(await available()).toBe(false);
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider availability check failed",
				expect.objectContaining({ error: expect.stringContaining("availability probe exploded") }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});
});
