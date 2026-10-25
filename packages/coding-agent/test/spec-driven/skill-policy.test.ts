import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "../../src/discovery";
import {
	buildSkillPromptMessage,
	loadSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
	type Skill,
} from "../../src/extensibility/skills";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { SkillProtocolHandler } from "../../src/internal-urls/skill-protocol";
import { MCPManager } from "../../src/mcp/manager";
import type { CustomMessageEntry, SessionEntry } from "../../src/session/session-entries";
import { ensureSpecDrivenResources, loadSpecDrivenSkill } from "../../src/spec-driven/resources";
import {
	bindSpecSkillPolicy,
	checkSkillReadAccess,
	clearSpecSkillAccess,
	grantSpecSkillAccess,
	SkillAccessDeniedError,
	SPEC_DRIVEN_SKILL_PROVIDER,
} from "../../src/spec-driven/skill-policy";
import { buildSystemPrompt } from "../../src/system-prompt";
import type { Skill as CapabilitySkill } from "../../src/capability/skill";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";

const handler = new SkillProtocolHandler();
const temporary: string[] = [];
afterEach(async () => {
	resetActiveSkillsForTests();
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function provenance(
	skill: Skill,
	details: { name: string; path: string } = { name: skill.name, path: skill.filePath },
): CustomMessageEntry {
	return {
		type: "custom_message",
		customType: "skill-prompt",
		id: "invocation",
		parentId: null,
		timestamp: new Date().toISOString(),
		content: "",
		display: true,
		attribution: "user",
		details,
	};
}

async function fixture(): Promise<Skill> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-access-"));
	temporary.push(baseDir);
	const filePath = path.join(baseDir, "SKILL.md");
	await fs.writeFile(filePath, "---\nname: fixture\ndescription: fixture\n---\nBehavior fixture\n");
	return {
		name: "fixture",
		description: "fixture",
		filePath,
		baseDir,
		containRoot: baseDir,
		source: "bundled-superpowers",
		hide: true,
	};
}

describe("pinned skill discovery and access", () => {
	it("discovers exactly ten ordinary original skills without indexing controlled methods or hidden entrypoints", async () => {
		const ordinaryNames = [
			"writing-plans",
			"subagent-driven-development",
			"executing-plans",
			"using-git-worktrees",
			"test-driven-development",
			"requesting-code-review",
			"finishing-a-development-branch",
			"writing-skills",
			"systematic-debugging",
			"verification-before-completion",
		].sort();
		const isHidden = (skill: CapabilitySkill) =>
			skill.frontmatter?.hide === true || skill.frontmatter?.disableModelInvocation === true;
		const resources = await ensureSpecDrivenResources();
		const discovered = await loadCapability<CapabilitySkill>("skills", { providers: [SPEC_DRIVEN_SKILL_PROVIDER] });
		expect(discovered.all.map(skill => skill.name).sort()).toEqual(
			resources.manifest.skills.map(skill => skill.name).sort(),
		);
		expect(
			discovered.all
				.filter(skill => !isHidden(skill))
				.map(skill => skill.name)
				.sort(),
		).toEqual(ordinaryNames);
		for (const skill of discovered.all) {
			if (ordinaryNames.includes(skill.name)) {
				expect(skill.frontmatter?.hide).not.toBe(true);
				expect(skill.frontmatter?.disableModelInvocation).not.toBe(true);
			} else {
				expect(isHidden(skill)).toBe(true);
				expect(skill.frontmatter?.disableModelInvocation).toBe(true);
			}
			expect(skill._source.provider).toBe(SPEC_DRIVEN_SKILL_PROVIDER);
		}
		const skills = await Promise.all(
			resources.manifest.skills.map(entry => loadSpecDrivenSkill(entry.source, entry.name)),
		);
		for (const discoveredSkill of discovered.all) {
			expect(discoveredSkill.path).toBe(skills.find(skill => skill.name === discoveredSkill.name)!.filePath);
		}
		const prompt = await buildSystemPrompt({
			skills,
			toolNames: ["read"],
			contextFiles: [],
			rules: [],
			cwd: os.tmpdir(),
		});
		const rendered = JSON.stringify(prompt.systemPrompt);
		expect(
			skills
				.filter(skill => !skill.hide)
				.map(skill => skill.name)
				.sort(),
		).toEqual(ordinaryNames);
		setActiveSkills(skills);
		expect((await handler.complete()).map(entry => entry.value).sort()).toEqual(ordinaryNames);
		for (const skill of skills) {
			const url = parseInternalUrl(`skill://${skill.name}`);
			const context = { skills, getSessionBranch: () => [] };
			if (ordinaryNames.includes(skill.name)) {
				expect(rendered).toContain(skill.name);
				const resolved = await handler.resolve(url, context);
				expect(resolved.sourcePath).toBe(skill.filePath);
				expect(await handler.locate(url, context)).toBe(skill.filePath);
			} else {
				expect(rendered).not.toContain(skill.name);
				await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
				await expect(handler.locate(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
			}
		}
	});

	it("requires explicit branch-local invocation for every bundled OpenSpec skill", async () => {
		const resources = await ensureSpecDrivenResources();
		for (const entry of resources.manifest.skills.filter(entry => entry.source === "openspec")) {
			const skill = await loadSpecDrivenSkill("openspec", entry.name);
			const url = parseInternalUrl(`skill://${skill.name}`);
			const context = { skills: [skill], getSessionBranch: () => [] };
			await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
			const invoked = await buildSkillPromptMessage(skill, { args: "change-name $ARGUMENTS {{literal}}" }, "user");
			const authorized = { skills: [skill], getSessionBranch: () => [provenance(skill, invoked.details)] };
			expect((await handler.resolve(url, authorized)).sourcePath).toBe(skill.filePath);
			expect(invoked.message).toContain("change-name $ARGUMENTS {{literal}}");
			await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
		}
	});

	it("opens hidden Grill-me and its metadata only after explicit current-branch invocation", async () => {
		const skill = await loadSpecDrivenSkill("jch", "jch-grill-me");
		setActiveSkills([skill]);
		expect(await handler.complete()).toEqual([]);
		const url = parseInternalUrl("skill://jch-grill-me");
		const metadataUrl = parseInternalUrl("skill://jch-grill-me/agents/openai.yaml");
		const context = { skills: [skill], getSessionBranch: () => [] };
		await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
		await expect(handler.locate(metadataUrl, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
		const invoked = await buildSkillPromptMessage(skill, { args: "" }, "user");
		const authorized = { skills: [skill], getSessionBranch: () => [provenance(skill, invoked.details)] };
		expect((await handler.resolve(url, authorized)).sourcePath).toBe(skill.filePath);
		const metadataPath = path.join(skill.baseDir, "agents", "openai.yaml");
		expect(await handler.locate(metadataUrl, authorized)).toBe(metadataPath);
		expect((await handler.resolve(metadataUrl, authorized)).content).toBe(await fs.readFile(metadataPath, "utf8"));
		await expect(handler.resolve(metadataUrl, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
	});

	it("resolves adapted SDD references and scripts inside the granted effective branch, never the ordinary tree", async () => {
		const ordinary = await loadSpecDrivenSkill("superpowers", "subagent-driven-development");
		const effective = await loadSpecDrivenSkill("superpowers", ordinary.name, { role: "executor" });
		expect(effective.filePath).not.toBe(ordinary.filePath);
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const end = bindSpecSkillPolicy(session, { phase: "executor", allowedSkills: [effective.name] });
		const revoke = grantSpecSkillAccess(session, effective);
		try {
			for (const relative of [
				"SKILL.md",
				"references/fix-loop.md",
				"references/final-review.md",
				"scripts/review-package",
			]) {
				const url = parseInternalUrl(`skill://${effective.name}/${relative}`);
				const context = { session, skills: [ordinary] };
				const located = await handler.locate(url, context);
				expect(located).toBe(path.join(effective.baseDir, relative));
				expect(located).not.toBe(path.join(ordinary.baseDir, relative));
			}
			for (const relative of ["references/fix-loop.md", "references/final-review.md"]) {
				expect(
					(await fs.readFile(path.join(effective.baseDir, relative))).equals(
						await fs.readFile(path.join(ordinary.baseDir, relative)),
					),
				).toBe(false);
			}
		} finally {
			revoke();
			end();
		}
	});

	it("denies phase-incompatible effective loading and invocation without leaking grants into solution or another session", async () => {
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const allowed = await loadSpecDrivenSkill("jch", "jch-grill-me", { role: "requirements" });
		const endRequirements = bindSpecSkillPolicy(session, { phase: "requirements", allowedSkills: [allowed.name] });
		const revoke = grantSpecSkillAccess(session, allowed);
		const url = parseInternalUrl(`skill://${allowed.name}`);
		try {
			expect((await handler.resolve(url, { session, skills: [allowed] })).sourcePath).toBe(allowed.filePath);
			await expect(handler.resolve(url, { session: { ...session }, skills: [allowed] })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			const endSolution = bindSpecSkillPolicy(session, { phase: "solution", allowedSkills: [] });
			try {
				// A stale disposer must not restore the requirements grant or remove the replacement policy.
				endRequirements();
				for (const [source, name] of [
					["jch", "jch-grill-me"],
					["superpowers", "brainstorming"],
					["superpowers", "writing-plans"],
					["superpowers", "subagent-driven-development"],
				] as const) {
					await expect(loadSpecDrivenSkill(source, name, { role: "solution" })).rejects.toThrow();
				}
				await expect(handler.resolve(url, { session, skills: [allowed] })).rejects.toBeInstanceOf(
					SkillAccessDeniedError,
				);
				await expect(handler.locate(url, { session, skills: [allowed] })).rejects.toBeInstanceOf(
					SkillAccessDeniedError,
				);
				await expect(
					buildSkillPromptMessage(allowed, { args: "" }, "autoload", { scope: session }),
				).rejects.toBeInstanceOf(SkillAccessDeniedError);
			} finally {
				endSolution();
			}
			await expect(handler.resolve(url, { session, skills: [allowed] })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
		} finally {
			revoke();
			endRequirements();
		}
	});

	it("keeps ordinary collision precedence but trusted autoload resolves the resource rather than the override", async () => {
		const original = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const override = await fixture();
		const overridePath = path.join(override.baseDir, "writing-plans", "SKILL.md");
		await fs.mkdir(path.dirname(overridePath));
		await fs.writeFile(
			overridePath,
			"---\nname: writing-plans\ndescription: local override\n---\nLocal authored instructions\n",
		);
		const { skills } = await loadSkills({
			cwd: override.baseDir,
			customDirectories: [override.baseDir],
			enablePiUser: false,
			enablePiProject: false,
		});
		expect(skills.find(skill => skill.name === "writing-plans")?.filePath).toBe(overridePath);
		expect((await loadSpecDrivenSkill("superpowers", "writing-plans")).filePath).toBe(original.filePath);
	});

	it("denies known resources in resolve and locate before filesystem or MCP side effects", async () => {
		const skill = await fixture();
		await fs.rm(skill.filePath);
		const url = parseInternalUrl(`skill://${skill.name}`);
		const mcp = spyOn(MCPManager, "load").mockResolvedValue(undefined);
		try {
			await expect(handler.resolve(url, { skills: [skill] })).rejects.toBeInstanceOf(SkillAccessDeniedError);
			await expect(handler.locate(url, { skills: [skill] }, { create: true })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			expect(mcp).not.toHaveBeenCalled();
		} finally {
			mcp.mockRestore();
		}
	});

	it("authorizes only exact current branch invocation provenance, including native autoload", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "brainstorming");
		const url = parseInternalUrl(`skill://${skill.name}`);
		for (const invocation of ["user", "autoload"] as const) {
			const built = await buildSkillPromptMessage(skill, { args: "" }, invocation);
			let branch: readonly SessionEntry[] = [provenance(skill, built.details)];
			const context = { skills: [skill], getSessionBranch: () => branch };
			expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
			expect(await handler.locate(url, context)).toBe(skill.filePath);
			await expect(handler.resolve(url, { skills: [skill], getSessionBranch: () => [] })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			branch = [provenance(skill, { name: skill.name, path: `${skill.filePath}.old` })];
			await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
			branch = [];
			await expect(handler.locate(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
		}
	});

	it("uses scoped program grants for real resource resolve and locate without leaking to another tool session", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "brainstorming");
		const url = parseInternalUrl(`skill://${skill.name}`);
		const override = { ...(await fixture()), name: skill.name, source: "custom:project" };
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const end = bindSpecSkillPolicy(session, { phase: "plan", allowedSkills: [skill.name] });
		const revoke = grantSpecSkillAccess(session, skill);
		try {
			expect((await handler.resolve(url, { session, skills: [skill] })).sourcePath).toBe(skill.filePath);
			expect(await handler.locate(url, { session, skills: [skill] })).toBe(skill.filePath);
			expect((await handler.resolve(url, { session, skills: [override] })).sourcePath).toBe(skill.filePath);
			await expect(handler.resolve(url, { session: { ...session }, skills: [skill] })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			revoke();
			await expect(handler.locate(url, { session, skills: [skill] })).rejects.toBeInstanceOf(SkillAccessDeniedError);
		} finally {
			revoke();
			end();
		}
	});

	it("scopes program grants by session and clears old grants on replacement or lifecycle end", async () => {
		const skill = await fixture();
		const scope = {};
		const dispose = bindSpecSkillPolicy(scope, { phase: "plan", allowedSkills: [skill.name] });
		const revoke = grantSpecSkillAccess(scope, skill);
		expect(() => checkSkillReadAccess(skill, { scope })).not.toThrow();
		expect(() => checkSkillReadAccess(skill, { scope: {} })).toThrow(SkillAccessDeniedError);
		revoke();
		expect(() => checkSkillReadAccess(skill, { scope })).toThrow(SkillAccessDeniedError);
		grantSpecSkillAccess(scope, skill);
		const endReplacement = bindSpecSkillPolicy(scope, { phase: "execution", allowedSkills: [skill.name] });
		dispose();
		expect(() => checkSkillReadAccess(skill, { scope })).toThrow(SkillAccessDeniedError);
		grantSpecSkillAccess(scope, skill);
		clearSpecSkillAccess(scope);
		expect(() => checkSkillReadAccess(skill, { scope })).toThrow(SkillAccessDeniedError);
		endReplacement();
	});

	it("rejects wrong-stage single invocation before reading even an ordinary skill", async () => {
		const skill = await fixture();
		const ordinary = { ...skill, source: "custom:project", hide: false };
		const scope = {};
		const end = bindSpecSkillPolicy(scope, { phase: "requirements", allowedSkills: ["jch-grill-me"] });
		await fs.rm(skill.filePath);
		try {
			await expect(buildSkillPromptMessage(ordinary, { args: "" }, "user", { scope })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			await expect(buildSkillPromptMessage(skill, { args: "" }, "autoload", { scope })).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
		} finally {
			end();
		}
	});

	it("rejects visible bundled skills in the wrong spec stage before ordinary-access exemption", async () => {
		const skills = await Promise.all(
			["verification-before-completion", "systematic-debugging", "writing-plans"].map(name =>
				loadSpecDrivenSkill("superpowers", name),
			),
		);
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const end = bindSpecSkillPolicy(session, { phase: "requirements", allowedSkills: ["jch-grill-me"] });
		try {
			for (const skill of skills) {
				expect(skill.hide).not.toBe(true);
				const url = parseInternalUrl(`skill://${skill.name}`);
				const context = { session, skills, getSessionBranch: () => [] };
				expect(() => checkSkillReadAccess(skill, { scope: session })).toThrow("not allowed during requirements");
				await expect(handler.resolve(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
				await expect(handler.locate(url, context)).rejects.toBeInstanceOf(SkillAccessDeniedError);
				for (const invocation of ["user", "autoload"] as const) {
					await expect(
						buildSkillPromptMessage(skill, { args: "" }, invocation, { scope: session }),
					).rejects.toBeInstanceOf(SkillAccessDeniedError);
				}
			}
		} finally {
			end();
		}
	});

	it("does not enumerate hidden names and keeps user-authored hidden resources readable", async () => {
		const pinned = await loadSpecDrivenSkill("superpowers", "brainstorming");
		const custom = { ...(await fixture()), name: "my-hidden-skill", source: "custom:project" };
		setActiveSkills([pinned, custom]);
		expect(await handler.complete()).toEqual([]);
		expect((await handler.resolve(parseInternalUrl(`skill://${custom.name}`))).sourcePath).toBe(custom.filePath);
		const mcp = spyOn(MCPManager, "load").mockResolvedValue(undefined);
		try {
			let failure: unknown;
			try {
				await handler.resolve(parseInternalUrl("skill://unknown-skill"));
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			for (const name of [pinned.name, custom.name]) expect((failure as Error).message).not.toContain(name);
			await expect(
				handler.resolve(parseInternalUrl("skill://brainstorming"), { skills: [] }),
			).rejects.toBeInstanceOf(SkillAccessDeniedError);
			expect(mcp).toHaveBeenCalledTimes(1);
		} finally {
			mcp.mockRestore();
		}
	});

	it("preserves percent-encoded resource names after current-session authorization", async () => {
		const skill = await fixture();
		const name = "reference notes 100%.txt";
		const filePath = path.join(skill.baseDir, name);
		await fs.writeFile(filePath, "authorized reference");
		const context = { skills: [skill], getSessionBranch: () => [provenance(skill)] };
		const url = parseInternalUrl(`skill://${skill.name}/${encodeURIComponent(name)}`);
		expect((await handler.resolve(url, context)).content).toBe("authorized reference");
		expect(await handler.locate(url, context)).toBe(filePath);
	});

	it("preserves traversal and canonical containment after authorization", async () => {
		const skill = await fixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-outside-"));
		temporary.push(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "outside");
		await fs.symlink(outside, path.join(skill.baseDir, "escape"), process.platform === "win32" ? "junction" : "dir");
		const context = { skills: [skill], getSessionBranch: () => [provenance(skill)] };
		const escaped = parseInternalUrl(`skill://${skill.name}/escape/secret.txt`);
		await expect(handler.resolve(escaped, context)).rejects.toThrow("outside the plugin root");
		await expect(handler.locate(escaped, context)).rejects.toThrow("outside the plugin root");
		await expect(handler.locate(escaped, context, { create: true })).rejects.toThrow("outside the plugin root");
		// Normalization previously aliased ../secret.txt to this in-root file, not the external secret.
		// Both consumers must reject the original traversal syntax rather than resolve that alias.
		await fs.writeFile(path.join(skill.baseDir, "secret.txt"), "inside");
		for (const relative of [
			"../secret.txt",
			"%2e%2e/secret.txt",
			"nested/%2E%2e/secret.txt",
			"%2e%2e%2fsecret.txt",
			"..%5csecret.txt",
		]) {
			const url = parseInternalUrl(`skill://${skill.name}/${relative}`);
			await expect(handler.resolve(url, context)).rejects.toThrow("Path traversal");
			await expect(handler.locate(url, context)).rejects.toThrow("Path traversal");
			await expect(handler.locate(url, context, { create: true })).rejects.toThrow("Path traversal");
		}
	});
});
