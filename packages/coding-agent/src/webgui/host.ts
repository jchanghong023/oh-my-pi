import type { DevWorkbenchHandle } from "../dev-workbench/host";
import type { AgentSession } from "../session/agent-session";
import { acquireBrowserProject } from "./project-registry";
import { readWebGuiSessionInfo } from "./session-source";
import { ensureSharedWebServer, runSharedWebGuiCommand } from "./shared-server";

export interface WebGuiHandle extends DevWorkbenchHandle {
	readonly projectId: string;
}

/** Keep failed startup settlement reachable by the terminal's exit/retry flow. */
export class WebGuiStartError extends AggregateError {
	constructor(errors: readonly unknown[], readonly handle: WebGuiHandle) {
		super(errors, "WebGUI startup and project settlement failed");
	}
}

/** Own only this project's read-only binding, never the shared browser server. */
export async function startWebGui(session: AgentSession): Promise<WebGuiHandle> {
	const lease = await acquireBrowserProject(session.sessionManager.getCwd(), "webgui");
	let closing: Promise<void> | undefined;
	const handle: WebGuiHandle = {
		projectId: lease.projectId,
		url: "",
		urls: [],
		loopbackUrl: "",
		close() {
			if (!closing) {
				const pending = (async () => {
					await lease.markExiting();
					await lease.close();
				})();
				closing = pending;
				void pending.catch(() => {
					if (closing === pending) closing = undefined;
				});
			}
			return closing;
		},
	};
	try {
		const shared = await ensureSharedWebServer();
		await lease.activate(() => readWebGuiSessionInfo(session));
		const selected = (address: string): string => {
			const url = new URL(address);
			url.searchParams.set("project", lease.projectId);
			return url.href;
		};
		handle.url = selected(shared.url);
		handle.urls = shared.urls.map(selected);
		handle.loopbackUrl = selected(shared.loopbackUrl);
		return handle;
	} catch (error) {
		try {
			await handle.close();
		} catch (cleanup) {
			throw new WebGuiStartError([error, cleanup], handle);
		}
		throw error;
	}
}

/** Standalone browsing does not create an Agent or acquire a project. */
export async function runWebGuiCommand(): Promise<void> {
	await runSharedWebGuiCommand();
}
