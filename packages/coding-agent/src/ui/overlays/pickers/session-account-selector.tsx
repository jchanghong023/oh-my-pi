/** @jsxImportSource @oh-my-pi/pi-tui */
/** The account picker `/session pin` opens for the current model provider. */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { SessionPinAccount } from "../../../modes/view-model/overlays/session-account-selector";
import { SelectSheet } from "./select-sheet";

export interface SessionAccountSelectorProps {
	readonly provider: string;
	readonly accounts: readonly SessionPinAccount[];
	onSelect(account: SessionPinAccount): void;
	onCancel(): void;
}

/** What tells two accounts of one provider apart besides their label: the organization, project or host. */
function accountDetail(account: SessionPinAccount): string {
	const parts = [account.orgName ?? account.orgId, account.projectId, account.enterpriseUrl].filter(
		(part): part is string => typeof part === "string" && part.trim().length > 0 && !account.label.includes(part),
	);
	return parts.join(" · ");
}

export function SessionAccountSelector(props: SessionAccountSelectorProps): JSXNode {
	const byId = new Map(props.accounts.map(account => [String(account.credentialId), account]));
	const active = props.accounts.find(account => account.active);
	return (
		<SelectSheet
			title={`${props.provider} 账户`}
			subtitle="指定此会话发送请求时使用的账户"
			icon="key-round"
			noun="账户"
			items={props.accounts.map(account => ({
				id: String(account.credentialId),
				label: account.label,
				detail: accountDetail(account),
				mark: { text: account.email ?? account.label, seed: account.label },
			}))}
			initial={active ? String(active.credentialId) : undefined}
			current={active ? [String(active.credentialId)] : []}
			confirmLabel="固定"
			// Natively the active account carries the current check; the terminal list says it in words.
			term={{
				title: `选择此会话使用的 ${props.provider.replace(/\s+/g, " ")} 账户`,
				hint: null,
				labels: Object.fromEntries(
					props.accounts.map(account => [
						String(account.credentialId),
						{ label: account.label, detail: account.active ? "当前会话正在使用" : undefined },
					]),
				),
			}}
			onPick={id => {
				const account = byId.get(id);
				if (account) props.onSelect(account);
			}}
			onCancel={props.onCancel}
		/>
	);
}
