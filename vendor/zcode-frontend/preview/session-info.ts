export const WEBGUI_SERVER_INFO_PATH = "/api/server-info";
export const WEBGUI_RPC_PATH = "/ws";
export const WEBGUI_UNAVAILABLE_CODE = "OMP_WEBGUI_NOT_IMPLEMENTED";
export const WEBGUI_SESSION_INFO_PATH = "/api/omp/session-info";
export const WEBGUI_PROJECTS_PATH = "/api/omp/projects";

export type BrowserProjectMode = "aireq" | "webgui";
export type BrowserProjectPhase = "entering" | "active" | "exiting";

export interface WebGuiProject {
	projectId: string;
	root: string;
	mode: BrowserProjectMode;
	phase: BrowserProjectPhase;
}

export interface WebGuiProjects {
	projects: WebGuiProject[];
}

export type WebGuiSessionInfo =
	| { bound: false }
	| {
			bound: true;
			cwd: string;
			sessionId: string;
			sessionName: string | null;
			model: { provider: string; id: string; name: string } | null;
			busy: boolean;
	  };
