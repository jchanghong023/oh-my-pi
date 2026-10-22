import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHttp400DumpPayload,
	pruneHttpRequestDumps,
	type RawHttpRequestDump,
	rewriteClinePassError,
	shouldDumpRejectedRequest,
} from "@oh-my-pi/pi-ai/utils/http-inspector";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const dump: RawHttpRequestDump = {
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-opus-4-8",
	method: "POST",
	url: "https://api.anthropic.com/v1/messages",
	headers: { "x-api-key": "secret-key", "content-type": "application/json" },
	body: { messages: [{ role: "user", content: "hi" }] },
};

describe("buildHttp400DumpPayload", () => {
	it("keeps request fields top-level and records the provider error response", () => {
		const message = "400 image exceeds 5 MB limit";
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, message), message);

		expect(payload.provider).toBe("anthropic");
		expect(payload.url).toBe("https://api.anthropic.com/v1/messages");
		expect(payload.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
		expect(payload.errorResponse).toEqual({ status: 400, message });
	});

	it("records the same message-derived status that enables dumping", () => {
		const message = "400 Bad Request: image exceeds 5 MB limit";
		const error = new Error(message);

		expect(shouldDumpRejectedRequest(error)).toBe(true);
		expect(buildHttp400DumpPayload(dump, error, message).errorResponse).toEqual({ status: 400, message });
	});

	it("redacts sensitive request headers while keeping the rest", () => {
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});

	it("redacts a query string carried by a configurable baseUrl (e.g. Bedrock gateway routing)", () => {
		const gatewayDump: RawHttpRequestDump = {
			...dump,
			url: "https://gateway.example.com/bedrock/model/anthropic.claude-opus-4-8/converse-stream?code=secret-token",
		};
		const payload = buildHttp400DumpPayload(gatewayDump, new HttpError(400, "x"), "x");

		expect(payload.url).not.toContain("secret-token");
		expect(payload.url).toBe(
			"https://gateway.example.com/bedrock/model/anthropic.claude-opus-4-8/converse-stream[redacted-query]",
		);
	});

	it("redacts provider-specific auth headers the fixed list never named", () => {
		const googleDump: RawHttpRequestDump = {
			provider: "google",
			api: "google-generative-ai",
			model: "gemini-2.5-flash",
			method: "POST",
			url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
			headers: {
				"x-goog-api-key": "AIzaSy-live-google-key",
				"x-amz-security-token": "aws-session-token",
				"content-type": "application/json",
			},
			body: { generationConfig: {} },
		};
		const payload = buildHttp400DumpPayload(googleDump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-goog-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["x-amz-security-token"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});
});

describe("declared authentication rejected-request diagnostics", () => {
	it("persists useful native HTTP 400 diagnostics without an arbitrary declared header credential", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-declared-auth-dump-"));
		const secret = "fixture-declared-header-material";
		const modelId = "declared-header-diagnostic-model";
		const requests: Array<{ authenticated: boolean; path: string; body: unknown }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const authenticated =
					request.headers.get("x-route") === secret &&
					!request.headers.has("authorization") &&
					!request.headers.has("x-api-key") &&
					!request.headers.has("api-key");
				requests.push({
					authenticated,
					path: new URL(request.url).pathname,
					body: await request.json(),
				});
				if (!authenticated) {
					return Response.json({ error: { message: "Missing declared authentication" } }, { status: 401 });
				}
				return Response.json(
					{
						error: {
							message: `fixture request content rejected; route=${secret}`,
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
			},
		});
		// A normal CLI child exercises real persistence; Bun's test process intentionally
		// does not write rejected-request dumps. No test-runtime guard is overridden.
		const script = `
			import { buildModel } from "@oh-my-pi/pi-catalog/build";
			import { streamSimple } from ${JSON.stringify(new URL("../src/stream.ts", import.meta.url).href)};
			import type { SimpleStreamOptions } from ${JSON.stringify(new URL("../src/types.ts", import.meta.url).href)};
			const model = buildModel({
				id: ${JSON.stringify(modelId)},
				name: "Declared header diagnostic fixture",
				api: "openai-completions",
				provider: "declared-header-diagnostic-local-fixture",
				baseUrl: ${JSON.stringify(`${server.url.origin}/v1`)},
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 128,
			});
			const options: SimpleStreamOptions = {
				requestAuth: { headers: { "X-rOuTe": ${JSON.stringify(secret)} } },
				headers: { "x-diagnostic-label": "ordinary-routing-context" },
				signal: AbortSignal.timeout(5000),
			};
			const result = await streamSimple(model, {
				messages: [{ role: "user", content: "Retain this diagnostic request body", timestamp: 0 }],
			}, options).result();
			console.log(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }));
		`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: import.meta.dir,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				TEMP: root,
				TMP: root,
				TMPDIR: root,
				HOME: root,
				USERPROFILE: root,
				OMP_CONFIG_ROOT: path.join(root, "config"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Real subprocess/network integration needs a wall-clock hang watchdog;
		// fake timers cannot terminate an unresponsive child process.
		const timeout = setTimeout(() => child.kill(), 10_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			// Boolean privacy assertions cannot print the fixture credential on failure.
			expect(stdout.includes(secret)).toBe(false);
			expect(stderr.includes(secret)).toBe(false);
			expect(exitCode).toBe(0);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.authenticated).toBe(true);
			expect(requests[0]?.path).toBe("/v1/chat/completions");
			const result = JSON.parse(stdout) as { stopReason: string; errorMessage: string };
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("400");
			expect(result.errorMessage).toContain("fixture request content rejected");
			const dumpPath = result.errorMessage
				.split("\n")
				.find(line => line.startsWith("raw-http-request="))
				?.slice("raw-http-request=".length);
			expect(dumpPath).toBeDefined();
			if (!dumpPath) throw new Error("Native rejection did not persist its diagnostic request");
			expect(path.relative(root, dumpPath).startsWith("..")).toBe(false);
			expect(path.isAbsolute(path.relative(root, dumpPath))).toBe(false);
			const serialized = await fs.readFile(dumpPath, "utf8");
			expect(serialized.includes(secret)).toBe(false);
			const payload = JSON.parse(serialized);
			expect(Object.keys(payload).sort()).toEqual(
				["provider", "api", "model", "method", "url", "headers", "body", "errorResponse"].sort(),
			);
			expect(payload.provider).toBe("declared-header-diagnostic-local-fixture");
			expect(payload.api).toBe("openai-completions");
			expect(payload.model).toBe(modelId);
			expect(payload.method).toBe("POST");
			expect(payload.url).toBe(`${server.url.origin}/v1/chat/completions`);
			expect(payload.body).toEqual(requests[0]?.body);
			expect(payload.body.model).toBe(modelId);
			expect(payload.body.messages).toContainEqual({
				role: "user",
				content: "Retain this diagnostic request body",
			});
			const headers = new Headers(payload.headers);
			expect(headers.get("x-route")).toBe("[redacted]");
			expect(headers.get("x-diagnostic-label")).toBe("ordinary-routing-context");
			expect(payload.errorResponse.status).toBe(400);
			expect(payload.errorResponse.message).toContain("fixture request content rejected");
		} finally {
			clearTimeout(timeout);
			child.kill();
			await child.exited;
			await server.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("shouldDumpRejectedRequest", () => {
	it("captures request-content rejections (400 bad request, 413 payload too large)", () => {
		expect(shouldDumpRejectedRequest(new HttpError(400, "bad request"))).toBe(true);
		expect(shouldDumpRejectedRequest(new HttpError(413, "payload too large"))).toBe(true);
	});

	it("skips auth, not-found, rate-limit, and retried 5xx errors that would spam dumps", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
			expect(shouldDumpRejectedRequest(new HttpError(status, "x"))).toBe(false);
		}
	});

	it("skips errors without an HTTP status", () => {
		expect(shouldDumpRejectedRequest(new Error("network reset"))).toBe(false);
	});
});

describe("rewriteClinePassError", () => {
	it("rewrites not-subscribed into free-tier guidance", () => {
		const rewritten = rewriteClinePassError("the user is not subscribed to required model plan", "cline-pass");
		expect(rewritten).toContain("requires a ClinePass subscription");
		expect(rewritten).toContain("free");
	});

	it("rewrites the alternate not-subscribed phrasing", () => {
		const rewritten = rewriteClinePassError(
			"No access to ClinePass subscription models yet. Subscribe to ClinePass",
			"cline-pass",
		);
		expect(rewritten).toContain("requires a ClinePass subscription");
	});

	it("rewrites organization-account restriction", () => {
		const rewritten = rewriteClinePassError(
			"organization accounts cannot use individual model inference subscriptions",
			"cline-pass",
		);
		expect(rewritten).toContain("organization accounts");
		expect(rewritten).toContain("personal Cline API key");
	});

	it("rewrites roster-rotation model-not-found into reselection guidance", () => {
		const rewritten = rewriteClinePassError("model not found", "cline-pass");
		expect(rewritten).toContain("removed this model from the roster");
		expect(rewritten).toContain("/model");
	});

	it("rewrites the client-surface gate into actionable guidance", () => {
		const rewritten = rewriteClinePassError(
			"Error 403: deepseek/deepseek-v4-flash is only available via Cline product surfaces. If you are using an old version of Cline, please update to the latest version",
			"cline-pass",
		);
		expect(rewritten).toContain("official product surfaces");
		expect(rewritten).toContain("/model");
	});

	it("leaves other providers untouched — the marker is too generic for them", () => {
		expect(rewriteClinePassError("model not found", "openrouter")).toBe("model not found");
	});

	it("leaves unrelated cline-pass errors untouched", () => {
		expect(rewriteClinePassError("500 internal server error", "cline-pass")).toBe("500 internal server error");
	});
});

describe("pruneHttpRequestDumps", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = Date.UTC(2026, 9, 1);

	async function writeDump(dir: string, name: string, bytes: number, ageMs: number): Promise<void> {
		const filePath = path.join(dir, name);
		await Bun.write(filePath, "x".repeat(bytes));
		const mtime = new Date(now - ageMs);
		await fs.utimes(filePath, mtime, mtime);
	}

	it("deletes dumps past the age limit and the oldest dumps beyond the size cap", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-http-dumps-"));
		roots.push(dir);
		await writeDump(dir, "newest.json", 400, 1_000);
		await writeDump(dir, "recent.json", 400, DAY_MS);
		await writeDump(dir, "older.json", 400, 2 * DAY_MS);
		await writeDump(dir, "expired.json", 10, 30 * DAY_MS);
		await writeDump(dir, "notes.txt", 5_000, 30 * DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000 });

		expect((await fs.readdir(dir)).sort()).toEqual(["newest.json", "notes.txt", "recent.json"]);
	});

	it("never deletes the dump it was asked to keep, even past the caps", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-http-dumps-keep-"));
		roots.push(dir);
		await writeDump(dir, "just-written.json", 2_000, 0);
		await writeDump(dir, "previous.json", 10, DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000, keep: "just-written.json" });

		expect(await fs.readdir(dir)).toEqual(["just-written.json"]);
	});
});
