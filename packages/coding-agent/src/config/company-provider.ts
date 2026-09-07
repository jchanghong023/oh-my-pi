import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";

export const COMPANY_PROVIDER_ID = "company";

interface CompanyConfig {
	readonly baseUrl: string;
	readonly embeddingBaseUrl: string;
	readonly token: string;
}

type CompanySnapshot = { config: Readonly<CompanyConfig>; error?: never } | { config?: never; error: string };

function readStartupConfig(): CompanySnapshot {
	let text: string;
	try {
		text = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
	} catch {
		return {
			error: "Company provider unavailable: cannot read ~/.claude/settings.json. Restart OMP after fixing it.",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			error: "Company provider unavailable: ~/.claude/settings.json is not valid JSON. Restart OMP after fixing it.",
		};
	}
	const env = parsed && typeof parsed === "object" && "env" in parsed ? parsed.env : undefined;
	if (!env || typeof env !== "object") {
		return {
			error: "Company provider unavailable: Claude settings must contain env.ANTHROPIC_BASE_URL and env.ANTHROPIC_AUTH_TOKEN.",
		};
	}
	const url = "ANTHROPIC_BASE_URL" in env ? env.ANTHROPIC_BASE_URL : undefined;
	const token = "ANTHROPIC_AUTH_TOKEN" in env ? env.ANTHROPIC_AUTH_TOKEN : undefined;
	if (typeof url !== "string" || !url.trim()) {
		return { error: "Company provider unavailable: env.ANTHROPIC_BASE_URL is missing or empty in Claude settings." };
	}
	if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
		return {
			error: "Company provider unavailable: env.ANTHROPIC_AUTH_TOKEN is missing or invalid in Claude settings.",
		};
	}
	try {
		const endpoint = new URL(url.trim());
		if (
			!["http:", "https:"].includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		) {
			throw new Error("Invalid endpoint");
		}
		const baseUrl = endpoint.href.replace(/\/+$/, "").replace(/\/v1$/, "");
		// Non-enumerable credentials keep accidental config/debug serialization safe.
		const config = Object.defineProperty({ baseUrl, embeddingBaseUrl: `${baseUrl}/v1` }, "token", {
			value: token.trim(),
			enumerable: false,
		});
		return { config: Object.freeze(config) as Readonly<CompanyConfig> };
	} catch {
		return {
			error: "Company provider unavailable: env.ANTHROPIC_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.",
		};
	}
}

// Worker threads inherit the parent's snapshot in memory; they never read Claude settings.
const snapshotKey = "omp.company-provider.startup";
const startupSnapshot: CompanySnapshot = isMainThread
	? readStartupConfig()
	: ((getEnvironmentData(snapshotKey) as CompanySnapshot | undefined) ?? {
			error: "Company provider unavailable: no startup configuration snapshot in this worker.",
		});
if (isMainThread) {
	setEnvironmentData(
		snapshotKey,
		startupSnapshot.config
			? { config: { ...startupSnapshot.config, token: startupSnapshot.config.token } }
			: startupSnapshot,
	);
} else if (startupSnapshot.config) {
	Object.defineProperty(startupSnapshot.config, "token", { enumerable: false });
	Object.freeze(startupSnapshot.config);
}

export function getCompanyConfig(): Readonly<CompanyConfig> | undefined {
	return startupSnapshot.config;
}

export function getCompanyConfigError(): string | undefined {
	return startupSnapshot.error;
}
