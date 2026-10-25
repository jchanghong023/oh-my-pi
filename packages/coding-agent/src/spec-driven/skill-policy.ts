import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import type { ResolveContext } from "../internal-urls/types";
import type { SessionEntry } from "../session/session-entries";
import { resourceManifest } from "./vendor/archive.generated";

export const SPEC_DRIVEN_SKILL_PROVIDER = "spec-driven";

/** The only bundled Superpowers resources admitted to the ordinary skill catalog. */
export function isOrdinarySuperpowersSkill(name: string): boolean {
	return (
		name === "brainstorming" ||
		name === "systematic-debugging" ||
		name === "verification-before-completion" ||
		name === "writing-skills"
	);
}

/** Reserved bundled names that ordinary command hosts must not send as plain prompts. */
export function isDevOnlySuperpowersSkill(name: string): boolean {
	return (
		!isOrdinarySuperpowersSkill(name) &&
		resourceManifest.skills.some(skill => skill.source === "superpowers" && skill.name === name)
	);
}

type InvocationSkill = Pick<Skill, "name"> & Partial<Pick<Skill, "source" | "_source" | "filePath">>;

function requiresNativeGrant(skill: InvocationSkill): boolean {
	const bundled =
		skill.source === "bundled-superpowers" ||
		(skill._source?.provider === SPEC_DRIVEN_SKILL_PROVIDER && skill._source.pluginName === "superpowers");
	return bundled && !isOrdinarySuperpowersSkill(skill.name.split("/").at(-1)!);
}

function checkPhase(skill: Pick<Skill, "name">, state?: ScopeState): void {
	if (state?.policy && !state.policy.allowedSkills.includes(skill.name)) {
		throw new SkillAccessDeniedError(skill.name, `not allowed during ${state.policy.phase}`);
	}
}

function hasExactGrant(skill: InvocationSkill, state?: ScopeState): boolean {
	if (!state || !skill.filePath) return false;
	const filePath = path.resolve(skill.filePath);
	for (const grant of state.grants) if (grant.name === skill.name && grant.filePath === filePath) return true;
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

export interface SpecSkillPhasePolicy {
	phase: string;
	/** Resolved catalog names permitted for single-skill invocation during this phase. */
	allowedSkills: readonly string[];
}

interface ScopeState {
	policy?: SpecSkillPhasePolicy;
	grants: Set<Readonly<Skill>>;
}
const scopes = new WeakMap<object, ScopeState>();

function stateFor(scope: object): ScopeState {
	let state = scopes.get(scope);
	if (!state) {
		state = { grants: new Set() };
		scopes.set(scope, state);
	}
	return state;
}

/** Binding replacement invalidates old grants; disposing an old binding cannot clear its replacement. */
export function bindSpecSkillPolicy(scope: object, policy: SpecSkillPhasePolicy): () => void {
	const state: ScopeState = { policy: { ...policy, allowedSkills: [...policy.allowedSkills] }, grants: new Set() };
	scopes.set(scope, state);
	return () => {
		if (scopes.get(scope) === state) scopes.delete(scope);
	};
}

export function clearSpecSkillAccess(scope: object): void {
	scopes.delete(scope);
}

/** Native controller capability, not a model tool. Dispose when its autoload/run ends. */
export function grantSpecSkillAccess(scope: object, skill: Skill): () => void {
	const state = stateFor(scope);
	checkPhase(skill, state);
	if (requiresNativeGrant(skill) && !state.policy) {
		throw new SkillAccessDeniedError(skill.name, "native phase binding required");
	}
	const grant = { ...skill, filePath: path.resolve(skill.filePath) };
	state.grants.add(grant);
	return () => {
		state.grants.delete(grant);
	};
}

/** Program autoload addresses its exact resource even when an ordinary user skill owns the bare name. */
export function getGrantedSpecSkill(name: string, context?: SkillAccessContext): Readonly<Skill> | undefined {
	const state = context?.scope ? scopes.get(context.scope) : undefined;
	if (!state) return undefined;
	for (const grant of state.grants) {
		if (grant.name === name && (!requiresNativeGrant(grant) || state.policy)) return grant;
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

/** Run before reading/injecting any skill, including ordinary single-skill commands. */
export function checkSkillInvocation(skill: InvocationSkill, context?: SkillAccessContext): void {
	const state = context?.scope ? scopes.get(context.scope) : undefined;
	checkPhase(skill, state);
	if (requiresNativeGrant(skill) && (!state?.policy || !hasExactGrant(skill, state))) {
		throw new SkillAccessDeniedError(skill.name, "native phase binding and exact resource grant required");
	}
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
	checkSkillInvocation(skill, context);
	if (!isExplicitOnlySkill(skill)) return;
	const state = context?.scope ? scopes.get(context.scope) : undefined;
	if (hasExactGrant(skill, state)) return;
	if (hasBranchInvocation(skill, context)) return;
	throw new SkillAccessDeniedError(skill.name, "explicit current-session invocation required");
}
