import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveClaudePaths } from "./claude-paths";

export const COMPANY_PROVIDER_ID = "company";

interface CompanyConfig {
	readonly baseUrl: string;
	readonly embeddingBaseUrl: string;
	readonly token: string;
}

type CompanySnapshot = ({ config: Readonly<CompanyConfig>; error?: never } | { config?: never; error: string }) & {
	diagnosticOperationId?: string;
	failureCategory?: string;
};

function readStartupConfig(): CompanySnapshot {
	const startedAt = performance.now();
	const operationId = String(logger.getLogContext().operation_id ?? `company-snapshot-${randomUUID()}`);
	const fields = { component: "company-provider", operation_id: operationId, restart_required: true };
	logger.info("Company startup snapshot started", {
		...fields,
		event: "company_snapshot_started",
		stage: "read",
		result: "started",
	});
	const unavailable = (error: string, category: string, stage: string, cause?: unknown): CompanySnapshot => {
		logger.warn("Company startup snapshot unavailable", {
			...fields,
			event: "company_snapshot_failed",
			stage,
			result: "unavailable",
			failure_category: category,
			cached_terminal: true,
			elapsed_ms: performance.now() - startedAt,
			...(cause === undefined ? {} : logger.diagnosticError(cause)),
		});
		return { error, failureCategory: category, diagnosticOperationId: operationId };
	};
	// Claude Code's active config directory (honors `CLAUDE_CONFIG_DIR`), the same
	// source OMP's `.claude` settings, skills, and session stores read.
	const settingsPath = join(resolveClaudePaths().configDir, "settings.json");
	let text: string;
	try {
		text = readFileSync(settingsPath, "utf8");
	} catch (error) {
		return unavailable(
			`Company provider unavailable: cannot read ${settingsPath}. Restart OMP after fixing it.`,
			"unreadable",
			"read",
			error,
		);
	}
	logger.info("Company startup snapshot read completed", {
		...fields,
		event: "company_snapshot_read_completed",
		stage: "read",
		result: "completed",
		elapsed_ms: performance.now() - startedAt,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return unavailable(
			`Company provider unavailable: ${settingsPath} is not valid JSON. Restart OMP after fixing it.`,
			"json",
			"parse",
			error,
		);
	}
	logger.info("Company startup snapshot validation started", {
		...fields,
		event: "company_snapshot_validation_started",
		stage: "validate",
		result: "started",
	});
	const env = parsed && typeof parsed === "object" && "env" in parsed ? parsed.env : undefined;
	if (!env || typeof env !== "object") {
		return unavailable(
			"Company provider unavailable: Claude settings must contain env.ANTHROPIC_BASE_URL and env.ANTHROPIC_AUTH_TOKEN.",
			"env",
			"validate",
		);
	}
	const url = "ANTHROPIC_BASE_URL" in env ? env.ANTHROPIC_BASE_URL : undefined;
	const token = "ANTHROPIC_AUTH_TOKEN" in env ? env.ANTHROPIC_AUTH_TOKEN : undefined;
	if (typeof url !== "string" || !url.trim()) {
		return unavailable(
			"Company provider unavailable: env.ANTHROPIC_BASE_URL is missing or empty in Claude settings.",
			"url_field",
			"validate",
		);
	}
	if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
		return unavailable(
			"Company provider unavailable: env.ANTHROPIC_AUTH_TOKEN is missing or invalid in Claude settings.",
			"token_field",
			"validate",
		);
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
		logger.info("Company startup snapshot completed", {
			...fields,
			event: "company_snapshot_completed",
			stage: "validate",
			result: "available",
			cached_terminal: true,
			elapsed_ms: performance.now() - startedAt,
		});
		return { config: Object.freeze(config) as Readonly<CompanyConfig>, diagnosticOperationId: operationId };
	} catch (error) {
		return unavailable(
			"Company provider unavailable: env.ANTHROPIC_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.",
			"url",
			"validate",
			error,
		);
	}
}

// Worker threads inherit the parent's snapshot in memory; they never read
// Claude settings. The main thread reads its snapshot lazily so a normal
// (non-offline) startup never touches `~/.claude/settings.json` and never
// holds the token in memory or hands it to workers.
const snapshotKey = "omp.company-provider.startup";
let mainSnapshot: CompanySnapshot | undefined;
let workerSnapshot: CompanySnapshot | undefined;
let mainReuseLogged = false;

function ensureStartupSnapshot(): CompanySnapshot {
	if (!isMainThread) {
		if (!workerSnapshot) {
			const snapshot = (getEnvironmentData(snapshotKey) as CompanySnapshot | undefined) ?? {
				error: "Company provider unavailable: no startup configuration snapshot in this worker.",
			};
			if (snapshot.config) {
				Object.defineProperty(snapshot.config, "token", { enumerable: false });
				Object.freeze(snapshot.config);
			}
			workerSnapshot = snapshot;
			logger.info("Company worker startup snapshot reused", {
				component: "company-provider",
				event: "company_snapshot_reused",
				stage: "worker",
				result: snapshot.config ? "available" : "unavailable",
				source: "worker_snapshot",
				operation_id: snapshot.diagnosticOperationId ?? `company-snapshot-${randomUUID()}`,
				failure_category: snapshot.failureCategory ?? (snapshot.config ? undefined : "worker_snapshot_missing"),
				restart_required: true,
				config_read: false,
			});
		}
		return workerSnapshot;
	}
	if (!mainSnapshot) {
		const operationId = logger.getLogContext().operation_id ?? `company-snapshot-${randomUUID()}`;
		const snapshot = logger.withLogContext({ operation_id: operationId }, readStartupConfig);
		try {
			setEnvironmentData(
				snapshotKey,
				snapshot.config ? { ...snapshot, config: { ...snapshot.config, token: snapshot.config.token } } : snapshot,
			);
		} catch (error) {
			logger.error("Company startup snapshot publication failed", {
				component: "company-provider",
				event: "company_snapshot_publication_failed",
				stage: "worker_publish",
				result: "failed",
				operation_id: operationId,
				...logger.diagnosticError(error),
			});
			throw error;
		}
		mainSnapshot = snapshot;
	} else if (!mainReuseLogged) {
		mainReuseLogged = true;
		logger.info("Company cached startup snapshot reused", {
			component: "company-provider",
			event: "company_snapshot_reused",
			stage: "cache",
			result: mainSnapshot.config ? "available" : "unavailable",
			source: "main_snapshot",
			operation_id: mainSnapshot.diagnosticOperationId,
			failure_category: mainSnapshot.failureCategory,
			restart_required: true,
			config_read: false,
		});
	}
	return mainSnapshot;
}

// The company lane only exists in OMP_OFFLINE processes: normal startups get no
// company provider, models, embedding fallback, or startup warnings. Workers
// read the flag lazily; it is always set before any worker can spawn.
const offlineKey = "omp.company-provider.offline";
let offlineEnabled = false;

function companyLaneActive(): boolean {
	return isMainThread ? offlineEnabled : getEnvironmentData(offlineKey) === true;
}

/** Enables or disables the company lane for this process; call before any consumer reads it. */
export function setCompanyOfflineEnabled(enabled: boolean): void {
	if (!isMainThread) return;
	const operationId = logger.getLogContext().operation_id ?? `company-lane-${randomUUID()}`;
	offlineEnabled = enabled;
	setEnvironmentData(offlineKey, enabled);
	logger.info("Company process lane configured", {
		component: "company-provider",
		event: "company_lane_configured",
		stage: "policy",
		result: "completed",
		company_enabled: enabled,
		snapshot_read_allowed: enabled,
		operation_id: operationId,
	});
	// Publish the snapshot (and only then hand it to workers) before any worker
	// can spawn; normal startups skip the Claude settings read entirely.
	if (enabled) logger.withLogContext({ operation_id: operationId }, ensureStartupSnapshot);
}

/** Whether the company lane is active in this process (regardless of configuration validity). */
export function isCompanyLaneActive(): boolean {
	return companyLaneActive();
}

export function getCompanyConfig(): Readonly<CompanyConfig> | undefined {
	return companyLaneActive() ? ensureStartupSnapshot().config : undefined;
}

export function getCompanyConfigError(): string | undefined {
	return companyLaneActive() ? ensureStartupSnapshot().error : undefined;
}
