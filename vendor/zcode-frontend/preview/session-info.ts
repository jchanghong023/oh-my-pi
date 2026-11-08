export const WEBGUI_SESSION_INFO_PATH = "/api/omp/session-info";
export const WEBGUI_SESSION_INFO_ORIGIN_ENV = "OMP_WEBGUI_SESSION_INFO_ORIGIN";

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
