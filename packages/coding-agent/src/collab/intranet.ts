import * as os from "node:os";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { offlineFromEnv } from "../cli/args";
import { withTimeoutSignal } from "../utils/fetch-timeout";
import { DEFAULT_RELAY_URL, normalizeRelayOrigin, parseCollabLink } from "./protocol";

export interface IntranetHostRegistration {
	username: string;
	hostname: string;
	link: string;
}

export function intranetCollabEnabled(): boolean {
	return offlineFromEnv();
}

export function intranetUsername(): string {
	let username: string;
	try {
		username = os.userInfo().username;
	} catch {
		throw new Error("Cannot determine the process login username for intranet collaboration.");
	}
	if (!isIntranetUsername(username)) {
		throw new Error("The process login username is missing or invalid for intranet collaboration.");
	}
	return username;
}

const defaultRelayHost = new URL(DEFAULT_RELAY_URL).hostname;

export function isPublicCollabRelay(url: URL): boolean {
	return url.hostname.replace(/\.$/, "") === defaultRelayHost;
}

/** Only call with the configured collab.relayUrl, never a CLI override or invitation. */
export function configuredIntranetRelayOrigin(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value.includes("://") ? value : `wss://${value}`);
	} catch {
		return undefined;
	}
	if (isPublicCollabRelay(url)) return undefined;
	const normalized = normalizeRelayOrigin(url.href, url.origin.replace(/^http:/, "ws:"));
	return "origin" in normalized ? normalized.origin : undefined;
}

export function isIntranetUsername(input: string): boolean {
	if (!("error" in parseCollabLink(input))) return false;
	return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(input) && !/^\d+$/.test(input);
}

export async function resolveIntranetUsername(configuredRelayUrl: string, username: string): Promise<string> {
	if (!intranetCollabEnabled()) {
		throw new Error("Intranet username lookup requires OMP_OFFLINE.");
	}
	if (!isIntranetUsername(username)) throw new Error("Invalid intranet collaboration username.");
	const origin = configuredIntranetRelayOrigin(configuredRelayUrl);
	if (!origin) throw new Error("Configure a valid intranet collab.relayUrl before using username lookup.");
	const url = new URL(`/collab/users/${encodeURIComponent(username)}`, origin.replace(/^ws/, "http"));
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			headers: { "Cache-Control": "no-store" },
			redirect: "error",
			proxy: getProxyForUrl("collab", url),
			signal: withTimeoutSignal(15_000),
		});
	} catch {
		throw new Error("Cannot reach the intranet collaboration relay for username lookup.");
	}
	if (response.status === 404) throw new Error(`User ${username} is offline or is not sharing a session.`);
	if (!response.ok) throw new Error(`Intranet collaboration lookup failed (HTTP ${response.status}).`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("The intranet collaboration relay returned an invalid lookup response.");
	}
	if (typeof body !== "object" || body === null || !("link" in body) || typeof body.link !== "string") {
		throw new Error("The intranet collaboration relay returned an invalid lookup response.");
	}
	const parsed = parseCollabLink(body.link, origin);
	if ("error" in parsed || new URL(parsed.wsUrl).origin !== origin) {
		throw new Error("The intranet collaboration relay returned an invalid room link.");
	}
	return body.link;
}
