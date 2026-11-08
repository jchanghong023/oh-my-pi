import * as path from "node:path";
import type {
	SkillDiagnostic,
	SkillScope,
	SkillsListResult,
	SkillSummary,
} from "../../../../vendor/zcode-frontend/packages/shared/src/skills-types";
import { resolveContainedPath } from "../discovery/contained-path";
import { loadSkillPromptBody, type Skill } from "../extensibility/skills";
import { checkSkillReadAccess, SkillAccessDeniedError } from "../spec-driven/skill-policy";
import { assertNativeChat } from "./native-chat";
import type { WebGuiMethod, WebGuiServiceContext } from "./rpc-contract";

function scopeOf(skill: Skill, cwd: string): SkillScope {
	if (skill._source?.pluginName) return "plugin";
	const level = skill._source?.level ?? skill.source.split(":").at(-1);
	if (level === "project") return "workspace";
	if (level === "user" || level === "native") return "user";
	// Explicit SDK skills need not carry discovery metadata; classify their actual path, not a global root.
	const relative = path.relative(cwd, skill.filePath);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		? "workspace"
		: "user";
}

/** Exposes only the bound session's effective catalog; never scans inactive providers or personal roots. */
export function createNativeSkillMethods(context: WebGuiServiceContext): Readonly<Record<string, WebGuiMethod>> {
	return {
		list: async (): Promise<SkillsListResult> => {
			const session = assertNativeChat(context);
			const manager = session.sessionManager;
			const cwd = manager.getCwd();
			const catalog = session.skills;
			const diagnostics: SkillDiagnostic[] = session.skillWarnings.map(warning => ({
				code: "skill_scan_failed",
				severity: "warning",
				message: warning.message,
				path: warning.skillPath,
			}));
			const access = { scope: manager, getSessionBranch: () => manager.getBranch() };
			const skills: SkillSummary[] = [];
			for (const skill of catalog) {
				context.signal.throwIfAborted();
				let body = "";
				let enabled = true;
				try {
					checkSkillReadAccess(skill, access);
					let filePath = skill.filePath;
					if (skill.containRoot) {
						const target = await resolveContainedPath(skill.containRoot, filePath);
						if (target.status !== "ok") {
							throw new Error(`Native skill path is ${target.status}: ${filePath}`);
						}
						filePath = target.realPath;
					}
					body = await loadSkillPromptBody({ name: skill.name, filePath }, access);
				} catch (error) {
					// A policy-denied body is redacted, not made readable by opening its filesystem path directly.
					const denied = error instanceof SkillAccessDeniedError;
					enabled = !denied;
					diagnostics.push({
						code: "skill_read_failed",
						severity: denied ? "warning" : "error",
						message: error instanceof Error ? error.message : String(error),
						path: skill.filePath,
						skillName: skill.name,
					});
				}
				skills.push({
					id: skill.filePath,
					name: skill.name,
					description: skill.description,
					body,
					path: skill.filePath,
					sourcePath: skill._source?.path ?? skill.filePath,
					scope: scopeOf(skill, cwd),
					enabled,
					...(skill._source?.pluginName !== undefined && { pluginName: skill._source.pluginName }),
				});
			}
			assertNativeChat(context);
			if (session.sessionManager !== manager || manager.getCwd() !== cwd || session.skills !== catalog) {
				throw new Error("Native skill catalog changed while it was being read");
			}
			return { skills, capability: { userScopeAvailable: true }, diagnostics };
		},
	};
}
