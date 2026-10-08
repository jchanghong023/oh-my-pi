import { getOAuthCredentialProvider, getOAuthProviders, type OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth";
import type { ModelRegistry } from "../../config/model-registry";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";

import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function oauthLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return `API key #${row.id}`;
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(row: StoredAuthCredential, label: string): string {
	const credential = row.credential;
	if (credential.type === "api_key") return `stored API key #${row.id}`;
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	row: StoredAuthCredential,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity || row.credential.type !== "oauth") return false;
	const credential = row.credential;
	// The org GATES the base identity rather than replacing it: mismatched org
	// presence or different orgs never match — an org-scoped active session
	// must not preselect the bare-email legacy row, and a bare-email active
	// row must not mark org-scoped siblings active via the shared email. A
	// SHARED org still requires the base-identity match below: two Team seats
	// share one orgId yet own distinct rows. Only an org-only active identity
	// (no base identifiers recovered at all) matches on the org alone.
	if (activeIdentity.orgId !== undefined || credential.orgId !== undefined) {
		if (credential.orgId !== activeIdentity.orgId) return false;
		if (
			activeIdentity.accountId === undefined &&
			activeIdentity.email === undefined &&
			activeIdentity.projectId === undefined
		) {
			return true;
		}
	}
	// When both sides carry an email it decides: Codex Team seats share an
	// account id and Antigravity accounts share one Google project.
	if (activeIdentity.email !== undefined && credential.email !== undefined) {
		return credential.email === activeIdentity.email;
	}
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

export function toLogoutAccounts(
	provider: string,
	credentials: StoredAuthCredential[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			const label = oauthLabel(row);
			const active =
				row.credential.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(row, label),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}

export interface LogoutCommandUI {
	selectProvider(providers: readonly OAuthProviderInfo[]): Promise<string | undefined>;
	selectAccount(provider: OAuthProviderInfo, accounts: LogoutAccount[]): Promise<number | undefined>;
}

export type LogoutCommandResult =
	| { status: "cancelled" }
	| { status: "skipped"; level: "info" | "warning" | "error"; message: string }
	| { status: "removed"; account: LogoutAccount; remainingSource?: string };

/** One logout operation, shared by the native selectors and protocol-backed dialogs. */
export async function logoutProviderForCommand(
	session: Pick<AgentSession, "modelRegistry" | "sessionId" | "sessionGeneration" | "isDisposed">,
	providerId: string | undefined,
	ui: LogoutCommandUI,
	signal?: AbortSignal,
): Promise<LogoutCommandResult> {
	const providers = getOAuthProviders();
	let provider = providerId ? providers.find(candidate => candidate.id === providerId) : undefined;
	if (providerId && !provider) {
		return { status: "skipped", level: "warning", message: `Unknown OAuth provider: ${providerId}` };
	}
	const modelRegistry = session.modelRegistry;
	const sessionId = session.sessionId;
	const generation = session.sessionGeneration;
	const authStorage = modelRegistry.authStorage;
	await authStorage.credentials.reload();
	if (!provider) {
		const storedProviders = providers.filter(candidate =>
			authStorage.credentials.has(getOAuthCredentialProvider(candidate.id)),
		);
		if (storedProviders.length === 0) {
			return {
				status: "skipped",
				level: "info",
				message: "No stored provider credentials to log out. Remove env or config auth at its source.",
			};
		}
		const selectedProviderId = await ui.selectProvider(storedProviders);
		if (selectedProviderId === undefined) return { status: "cancelled" };
		provider = storedProviders.find(candidate => candidate.id === selectedProviderId);
		if (!provider) {
			return { status: "skipped", level: "error", message: "The selected logout provider is no longer available." };
		}
	}
	// Login providers may store credentials under a different id (storeCredentialsAs).
	const storageProvider = getOAuthCredentialProvider(provider.id);
	const accounts = toLogoutAccounts(storageProvider, authStorage.credentials.list(storageProvider), {
		activeIdentity: authStorage.oauth.identity(storageProvider, session.sessionId),
		activeApiKey: authStorage.keys.source(storageProvider)?.kind === "api_key",
	});
	if (accounts.length === 0) {
		const source = authStorage.keys.describe(storageProvider, session.sessionId);
		const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
		return {
			status: "skipped",
			level: "error",
			message: `Logout skipped: no stored credentials for ${provider.id}.${suffix}`,
		};
	}
	const selectedCredentialId = await ui.selectAccount(provider, accounts);
	if (selectedCredentialId === undefined) return { status: "cancelled" };
	const account = accounts.find(candidate => candidate.credentialId === selectedCredentialId);
	if (!account) {
		return { status: "skipped", level: "error", message: "The selected logout account is no longer available." };
	}
	signal?.throwIfAborted();
	if (
		session.isDisposed ||
		session.sessionGeneration !== generation ||
		session.sessionId !== sessionId ||
		session.modelRegistry !== modelRegistry
	) {
		return {
			status: "skipped",
			level: "error",
			message: "Logout cancelled: the session changed during account selection.",
		};
	}
	const removed = await authStorage.credentials.removeById(storageProvider, account.credentialId);
	if (!removed) {
		return {
			status: "skipped",
			level: "error",
			message: `Logout skipped: ${account.label} is no longer stored for ${provider.id}.`,
		};
	}
	await modelRegistry.refreshProvider(storageProvider, "online");
	return {
		status: "removed",
		account,
		remainingSource: authStorage.keys.describe(storageProvider, sessionId),
	};
}

export function formatLogoutCommandResult(
	result: LogoutCommandResult,
): { level: "info" | "warning" | "error"; message: string } | undefined {
	if (result.status === "cancelled") return undefined;
	if (result.status === "skipped") return result;
	const lines = [
		`Successfully logged out ${result.account.label} from ${result.account.provider}`,
		"Credential removed from stored auth.",
	];
	if (result.remainingSource) {
		lines.push(`${result.account.provider} is still authenticated via ${result.remainingSource}`);
	}
	return { level: result.remainingSource ? "warning" : "info", message: lines.join("\n") };
}

/** Stored accounts `/logout` can remove for `provider`, active first. Reloads the store to see other processes' changes. */
export async function listLogoutAccounts(
	authStorage: AuthStorage,
	loginProvider: string,
	sessionId: string,
): Promise<LogoutAccount[]> {
	const provider = getOAuthCredentialProvider(loginProvider);
	await authStorage.credentials.reload();
	return toLogoutAccounts(provider, authStorage.credentials.list(provider), {
		activeIdentity: authStorage.oauth.identity(provider, sessionId),
		activeApiKey: authStorage.keys.source(provider)?.kind === "api_key",
	});
}

/**
 * Removes one stored credential and refreshes the provider's models.
 * `removed: false` means the credential was already gone; `remainingSource`
 * names the auth source that still authenticates the provider, if any.
 */
export async function logoutCredential(
	modelRegistry: ModelRegistry,
	loginProvider: string,
	credentialId: number,
	sessionId: string,
): Promise<{ removed: boolean; remainingSource?: string }> {
	const provider = getOAuthCredentialProvider(loginProvider);
	const authStorage = modelRegistry.authStorage;
	// Reload so an id stored by another process is found, not reported missing.
	await authStorage.credentials.reload();
	if (!(await authStorage.credentials.removeById(provider, credentialId))) return { removed: false };
	// Provider-scoped online refresh so the removed credential's stale
	// endpoint/deployment models are invalidated deterministically; the
	// default all-provider `online-if-uncached` would reuse the fresh
	// authoritative cache row and keep showing models the credential
	// unlocked (#5780). Other providers are left untouched.
	await modelRegistry.refreshProvider(provider, "online");
	return { removed: true, remainingSource: authStorage.keys.describe(provider, sessionId) };
}
