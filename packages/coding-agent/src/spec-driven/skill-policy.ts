import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import type { ResolveContext } from "../internal-urls/types";
import type { SessionEntry } from "../session/session-entries";

export const SPEC_DRIVEN_SKILL_PROVIDER = "spec-driven";

function hasExactGrant(skill: Skill, grants?: ReadonlySet<Readonly<Skill>>): boolean {
	if (!grants) return false;
	const filePath = path.resolve(skill.filePath);
	for (const grant of grants) if (grant.name === skill.name && grant.filePath === filePath) return true;
	return false;
}

export class SkillAccessDeniedError extends Error {
	constructor(name: string, reason: string) {
		super(`Skill access denied: ${name} (${reason})`);
		this.name = "SkillAccessDeniedError";
	}
}

/** Pass the same session-manager object to the controller, prompt builder and tool context. */
export interface SkillAccessContext {
	scope?: object;
	getSessionBranch?: () => readonly SessionEntry[];
}

const grantsByScope = new WeakMap<object, Set<Readonly<Skill>>>();

/** Authorize access to the exact bundled skill admitted for autoload in this session. */
export function grantSpecSkillAccess(scope: object, skill: Skill): () => void {
	let grants = grantsByScope.get(scope);
	if (!grants) {
		grants = new Set();
		grantsByScope.set(scope, grants);
	}
	const grant = { ...skill, filePath: path.resolve(skill.filePath) };
	grants.add(grant);
	return () => {
		grants.delete(grant);
	};
}

/** Program autoload addresses its exact resource even when an ordinary user skill owns the bare name. */
export function getGrantedSpecSkill(name: string, context?: SkillAccessContext): Readonly<Skill> | undefined {
	const grants = context?.scope ? grantsByScope.get(context.scope) : undefined;
	if (!grants) return undefined;
	for (const grant of grants) {
		if (grant.name === name) return grant;
	}
	return undefined;
}

export function skillAccessContext(context?: ResolveContext): SkillAccessContext {
	const manager = context?.session?.sessionManager;
	return {
		scope: manager ?? context?.session,
		getSessionBranch: manager ? () => manager.getBranch() : context?.getSessionBranch,
	};
}

export function isExplicitOnlySkill(skill: Pick<Skill, "source" | "_source" | "hide">): boolean {
	return (
		skill.hide === true &&
		(skill._source?.provider === SPEC_DRIVEN_SKILL_PROVIDER ||
			skill.source === "bundled-openspec" ||
			skill.source === "bundled-superpowers" ||
			skill.source === "bundled-jch")
	);
}

function hasBranchInvocation(skill: Skill, context?: SkillAccessContext): boolean {
	return (
		context?.getSessionBranch?.().some(entry => {
			if (entry.type !== "custom_message" || entry.customType !== "skill-prompt") return false;
			if (!entry.details || typeof entry.details !== "object") return false;
			const details = entry.details as { name?: unknown; path?: unknown };
			return (
				details.name === skill.name &&
				typeof details.path === "string" &&
				path.resolve(details.path) === path.resolve(skill.filePath)
			);
		}) ?? false
	);
}

/** Hidden user skills retain ordinary URI semantics; only hidden pinned resources require provenance. */
export function checkSkillReadAccess(skill: Skill, context?: SkillAccessContext): void {
	if (!isExplicitOnlySkill(skill)) return;
	const grants = context?.scope ? grantsByScope.get(context.scope) : undefined;
	if (hasExactGrant(skill, grants)) return;
	if (hasBranchInvocation(skill, context)) return;
	throw new SkillAccessDeniedError(skill.name, "explicit current-session invocation required");
}
