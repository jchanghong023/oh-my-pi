import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyCodexResidencyHeader,
	getCodexAccountId,
	getCodexResidency,
	JWT_CLAIM_PATH,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";

function codexToken(auth: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
	const payload = Buffer.from(JSON.stringify({ [JWT_CLAIM_PATH]: auth }), "utf8").toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("getCodexResidency", () => {
	it("reads the data-residency claim of a region-pinned workspace", () => {
		const token = codexToken({
			chatgpt_account_id: "acct-1",
			chatgpt_data_residency: "us",
			chatgpt_compute_residency: "us",
		});

		expect(getCodexResidency(token)).toBe("us");
		// Same token still yields the account id — the claim block is shared.
		expect(getCodexAccountId(token)).toBe("acct-1");
	});

	it("prefers data residency over compute residency when they disagree", () => {
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "eu", chatgpt_compute_residency: "us" }))).toBe(
			"eu",
		);
	});

	it("falls back to compute residency when only that claim is present", () => {
		expect(getCodexResidency(codexToken({ chatgpt_compute_residency: "eu" }))).toBe("eu");
	});

	it("returns undefined for tokens without residency claims", () => {
		// The common case: a personal ChatGPT account, not pinned to any region.
		expect(getCodexResidency(codexToken({ chatgpt_account_id: "acct-1" }))).toBeUndefined();
	});

	it("sends no residency header for an unconstrained account (#16493)", () => {
		// Personal Plus tokens carry `no_constraint`; declaring it makes every request 404.
		const headers = new Headers();
		applyCodexResidencyHeader(headers, codexToken({ chatgpt_data_residency: "no_constraint" }));
		expect(headers.has(OPENAI_HEADERS.RESIDENCY)).toBe(false);
		// The authoritative data claim is not overridden by a compute residency.
		expect(
			getCodexResidency(codexToken({ chatgpt_data_residency: "no_constraint", chatgpt_compute_residency: "us" })),
		).toBeUndefined();
	});

	it("ignores blank and non-string claims instead of sending an empty header", () => {
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "   " }))).toBeUndefined();
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: 42 }))).toBeUndefined();
		expect(getCodexResidency(codexToken({ chatgpt_data_residency: "", chatgpt_compute_residency: "us" }))).toBe("us");
	});

	it("returns undefined for opaque non-JWT keys used by Codex-compatible proxies", () => {
		expect(getCodexResidency("opaque-proxy-key")).toBeUndefined();
		expect(getCodexResidency("not.a.jwt")).toBeUndefined();
	});

	it("applies residency without replacing caller-supplied Headers or record values", () => {
		const token = codexToken({ chatgpt_data_residency: "us" });
		const headers = new Headers();
		applyCodexResidencyHeader(headers, token);
		expect(headers.get(OPENAI_HEADERS.RESIDENCY)).toBe("us");

		const configured = { "X-OpenAI-Internal-Codex-Residency": "eu" };
		applyCodexResidencyHeader(configured, token);
		expect(configured).toEqual({ "X-OpenAI-Internal-Codex-Residency": "eu" });
	});
});

describe("Codex client version refresh", () => {
	it.each(["1", " TrUe ", "yes", "ON", "false"])(
		"respects OMP_OFFLINE=%j without discarding the cached version",
		offline => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-version-"));
			const agentDir = path.join(home, "agent");
			fs.mkdirSync(agentDir);
			fs.writeFileSync(
				path.join(agentDir, "codex-client-version.json"),
				JSON.stringify({ version: "999.0.0", checkedAt: 0 }),
			);
			try {
				const child = Bun.spawnSync(
					[
						process.execPath,
						"--eval",
						`
						let fetchCount = 0;
						globalThis.fetch = async () => {
							fetchCount++;
							return new Response(null, { status: 503 });
						};
						const { resolveModelCacheProviderId } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/provider-models/cache-provider-id.ts"))});
						const cacheProviderId = resolveModelCacheProviderId("openai-codex");
						const passiveFetchCount = fetchCount;
						const { getCodexClientVersion } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/wire/codex-version.ts"))});
						const version = getCodexClientVersion();
						console.log(JSON.stringify({ version, cacheProviderId, passiveFetchCount, fetchCount }));
						`,
					],
					{
						env: {
							...process.env,
							NODE_ENV: "production",
							PI_AI_CODEX_CLIENT_VERSION: "",
							PI_CODING_AGENT_DIR: agentDir,
							OMP_CONFIG_ROOT: path.join(home, ".omp"),
							PI_PROFILE: "",
							OMP_OFFLINE: offline,
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				expect(JSON.parse(child.stdout.toString())).toEqual({
					version: "999.0.0",
					cacheProviderId: "openai-codex:999.0.0",
					passiveFetchCount: 0,
					fetchCount: offline === "false" ? 1 : 0,
				});
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
			}
		},
	);
});
