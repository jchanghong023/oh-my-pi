import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { offlineFromEnv } from "@oh-my-pi/pi-utils";
import { OAuthOfflineError } from "../error";
import type { FetchImpl } from "../types";

function isIntranetAddress(address: string, allowMetadata: boolean): boolean {
	if (isIP(address) === 4) {
		return (
			/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address) ||
			(allowMetadata && (address === "169.254.169.254" || address === "169.254.170.2" || address === "169.254.170.23"))
		);
	}
	return address === "::1" || /^(?:fc|fd)[0-9a-f]{2}:/i.test(address);
}

export async function isIntranetEndpoint(url: URL, allowMetadata = false): Promise<boolean> {
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) return isIntranetAddress(host, allowMetadata);
	try {
		const addresses = await lookup(host, { all: true });
		return addresses.length > 0 && addresses.every(({ address }) => isIntranetAddress(address, allowMetadata));
	} catch {
		return false;
	}
}

/** Validate the actual credential endpoint, not an associated inference or resource URL. */
export async function assertOfflineCredentialEndpoint(provider: string, input: string | URL): Promise<void> {
	const url = URL.parse(input);
	if (!url || !(await isIntranetEndpoint(url, true))) throw new OAuthOfflineError(provider);
}

/** Guard credential requests only; the inference and fetch-tool transports are unchanged. */
export function credentialFetch(provider: string, fetchImpl: FetchImpl = fetch): FetchImpl {
	if (!offlineFromEnv()) return fetchImpl;
	return async (input, init) => {
		const url = input instanceof Request ? input.url : input;
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		signal?.throwIfAborted();
		await assertOfflineCredentialEndpoint(provider, url);
		signal?.throwIfAborted();
		return fetchImpl(input, { ...init, redirect: "error" });
	};
}

/** Use when a grant is public-only or its destination cannot be verified (e.g. a remote broker). */
export function assertOnlineCredentialExchange(provider: string): void {
	if (offlineFromEnv()) throw new OAuthOfflineError(provider);
}
