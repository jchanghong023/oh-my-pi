import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { embedConfiguredApi } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});

function track<T extends { mockRestore(): void }>(spy: T): T {
	spies.push(spy);
	return spy;
}

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>) {
	const preconnect = globalThis.fetch.preconnect;
	return track(vi.spyOn(globalThis, "fetch")).mockImplementation(Object.assign(implementation, { preconnect }));
}

function embed(signal: AbortSignal) {
	return withMnemopiRuntimeOptions(
		{
			embeddings: {
				disabled: false,
				model: "fixture-embedding",
				apiUrl: "http://embedding.invalid/v1",
				apiKey: "",
				strictApi: true,
				requestTimeoutMs: 90_000,
				requestMaxAttempts: 10,
				requestRetryDelayMs: 10_000,
				retryTimeouts: true,
				signal,
			},
		},
		() => embedConfiguredApi(["section"]),
	);
}

function reply(): Response {
	return Response.json({ model: "fixture-embedding", data: [{ index: 0, embedding: [1, 2] }] });
}

function captureTimeouts(): AbortController[] {
	const timers: AbortController[] = [];
	track(vi.spyOn(AbortSignal, "timeout")).mockImplementation(() => {
		const controller = new AbortController();
		timers.push(controller);
		return controller.signal;
	});
	track(vi.spyOn(scheduler, "wait")).mockImplementation(async () => {});
	return timers;
}

describe("embedding request timeout recovery", () => {
	it("recovers after a request timeout with a fresh deadline and the caller still active", async () => {
		const timers = captureTimeouts();
		const caller = new AbortController();
		let calls = 0;
		mockFetch(async () => {
			if (++calls === 1) {
				timers[0]!.abort(new DOMException("request deadline", "TimeoutError"));
				throw timers[0]!.signal.reason;
			}
			return reply();
		});

		expect(await embed(caller.signal)).toEqual([new Float32Array([1, 2])]);
		expect(calls).toBe(2);
		expect(timers).toHaveLength(2);
		expect(timers[1]!.signal.aborted).toBe(false);
		expect(caller.signal.aborted).toBe(false);
	});

	it("retries a timeout while reading the body after successful response headers", async () => {
		const timers = captureTimeouts();
		let calls = 0;
		mockFetch(async (_input, init) => {
			if (++calls !== 1) return reply();
			const signal = init?.signal;
			expect(signal).toBeDefined();
			return new Response(
				new ReadableStream({
					start(controller) {
						signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
						timers[0]!.abort(new DOMException("response deadline", "TimeoutError"));
					},
				}),
			);
		});

		expect(await embed(new AbortController().signal)).toEqual([new Float32Array([1, 2])]);
		expect(calls).toBe(2);
	});

	it("retries a stalled HTTP response body after the per-attempt deadline", async () => {
		let calls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				if (++calls > 1) return reply();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("{"));
						},
					}),
				);
			},
		});
		try {
			const result = await withMnemopiRuntimeOptions(
				{
					embeddings: {
						disabled: false,
						model: "fixture-embedding",
						apiUrl: server.url.toString(),
						apiKey: "",
						strictApi: true,
						requestTimeoutMs: 500,
						requestMaxAttempts: 2,
						requestRetryDelayMs: 0,
						retryTimeouts: true,
					},
				},
				() => embedConfiguredApi(["section"]),
			);
			expect(result).toEqual([new Float32Array([1, 2])]);
			expect(calls).toBe(2);
		} finally {
			server.stop(true);
		}
	});

	it("stops repeated timeouts at ten attempts with fixed ten-second waits", async () => {
		const timers = captureTimeouts();
		const caller = new AbortController();
		const fetch = mockFetch(async () => {
			const timer = timers.at(-1)!;
			timer.abort(new DOMException("request deadline", "TimeoutError"));
			throw timer.signal.reason;
		});

		expect(await embed(caller.signal)).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(10);
		expect(timers).toHaveLength(10);
		expect(scheduler.wait).toHaveBeenCalledTimes(9);
		expect(scheduler.wait).toHaveBeenCalledWith(10_000, { signal: caller.signal });
	});

	it("uses the fixed delay for a rate limit even when the server suggests a longer wait", async () => {
		captureTimeouts();
		const caller = new AbortController();
		const fetch = track(vi.spyOn(globalThis, "fetch"))
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": "120" } }))
			.mockResolvedValue(reply());

		expect(await embed(caller.signal)).toEqual([new Float32Array([1, 2])]);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(scheduler.wait).toHaveBeenCalledTimes(1);
		expect(scheduler.wait).toHaveBeenCalledWith(10_000, { signal: caller.signal });
	});

	it("does not turn caller cancellation into a retry", async () => {
		captureTimeouts();
		const caller = new AbortController();
		const fetch = mockFetch(async () => {
			caller.abort(new DOMException("cancelled", "AbortError"));
			throw caller.signal.reason;
		});

		await expect(embed(caller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(scheduler.wait).not.toHaveBeenCalled();
	});

	it("stops immediately when cancelled during a retry wait", async () => {
		const caller = new AbortController();
		const wait = scheduler.wait.bind(scheduler);
		track(vi.spyOn(scheduler, "wait")).mockImplementation((delay, options) => {
			caller.abort(new DOMException("cancelled", "AbortError"));
			return wait(delay, options);
		});
		const fetch = track(vi.spyOn(globalThis, "fetch")).mockResolvedValue(new Response("busy", { status: 503 }));

		await expect(embed(caller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not retry a successful HTTP response with invalid vectors", async () => {
		captureTimeouts();
		const fetch = mockFetch(async () =>
			Response.json({ model: "fixture-embedding", data: [{ index: 0, embedding: [0, 0] }] }),
		);

		expect(await embed(new AbortController().signal)).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
