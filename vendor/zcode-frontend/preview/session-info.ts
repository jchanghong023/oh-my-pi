export const WEBGUI_SESSION_INFO_PATH = "/api/omp/session-info";
export const WEBGUI_PROJECTS_PATH = "/api/omp/projects";
export const WEBGUI_SESSION_INFO_ORIGIN_ENV = "OMP_WEBGUI_SESSION_INFO_ORIGIN";
export const WEBGUI_DEV_TARGET_PATH = "/internal/omp/dev-target";
export const WEBGUI_CONTROL_TOKEN_ENV = "OMP_WEBGUI_CONTROL_TOKEN";

export type BrowserProjectMode = "dev" | "webgui";
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
