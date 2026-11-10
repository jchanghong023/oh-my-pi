import type { AgentSession } from "../../session/agent-session";
import type { DevNativeSessionInfo } from "./session-source";

/** Dev-only protocol projection. It never registers or mutates an original WebGUI owner. */
export interface BrowserProjectRecord {
	readonly projectId: string;
	readonly root: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly mode: "dev";
	readonly phase: "active" | "exiting";
	readonly ownerId: string;
	readonly pid: number;
	readonly allowLan: boolean;
	readonly nativeSession?: AgentSession;
	readonly nativeSessions: ReadonlySet<AgentSession>;
	readonly pendingModelSelections: Set<Promise<void>>;
	readonly readInfo?: () => DevNativeSessionInfo;
}
const projects = new Map<string, BrowserProjectRecord>();
export function setDevNativeProject(project: BrowserProjectRecord): void {
	projects.set(project.projectId, project);
}
export function removeDevNativeProject(projectId: string): void {
	projects.delete(projectId);
}
export function readBrowserProject(projectId: string): BrowserProjectRecord | null {
	return projects.get(projectId) ?? null;
}
export function listBrowserProjects(): BrowserProjectRecord[] {
	return [...projects.values()];
}
export async function resolveBrowserProjectRoot(root: string): Promise<string> {
	const project = [...projects.values()].find(
		item => item.root === root || [...item.nativeSessions].some(session => session.sessionManager.getCwd() === root),
	);
	if (!project) throw new Error("Workspace is not registered with this Dev host");
	return project.root;
}
