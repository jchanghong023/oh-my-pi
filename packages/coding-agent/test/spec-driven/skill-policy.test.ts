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
import type { CustomMessageEntry } from "../../src/session/session-entries";
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
		source: "bundled-openspec",
		hide: true,
	};
}

describe("pinned skill discovery and access", () => {
	it("catalogs and exposes all Superpowers while preserving other discovery boundaries", async () => {
		const ordinaryNames = [
			"openspec-apply-change",
			"openspec-archive-change",
			"openspec-explore",
			"openspec-propose",
			"openspec-sync-specs",
			"openspec-update-change",
		];
		const isHidden = (skill: CapabilitySkill) =>
			skill.frontmatter?.hide === true || skill.frontmatter?.disableModelInvocation === true;
		const resources = await ensureSpecDrivenResources();
		ordinaryNames.push(...resources.manifest.skills.filter(entry => entry.source === "superpowers").map(entry => entry.name));
		ordinaryNames.sort();
		const cwd = (await fixture()).baseDir;
		await fs.mkdir(path.join(cwd, "openspec"));
		const discovered = await loadCapability<CapabilitySkill>("skills", {
			cwd,
			providers: [SPEC_DRIVEN_SKILL_PROVIDER],
		});
		expect(
			discovered.all
				.filter(skill => skill._source.pluginName === "superpowers")
				.map(skill => skill.name)
				.sort(),
		).toEqual(
			resources.manifest.skills
				.filter(entry => entry.source === "superpowers")
				.map(entry => entry.name)
				.sort(),
		);
		for (const entry of resources.manifest.skills.filter(entry => entry.source !== "superpowers")) {
			expect(discovered.all.some(skill => skill.name === entry.name)).toBe(
				entry.source !== "openspec" || ordinaryNames.includes(entry.name),
			);
		}
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
			discovered.all.map(skill => {
				const entry = resources.manifest.skills.find(entry => entry.name === skill.name)!;
				return loadSpecDrivenSkill(entry.source, entry.name);
			}),
		);
		for (const discoveredSkill of discovered.all) {
			expect(discoveredSkill.path).toBe(skills.find(skill => skill.name === discoveredSkill.name)!.filePath);
		}
		const prompt = await buildSystemPrompt({
			skills,
			toolNames: ["read"],
			contextFiles: [],
			rules: [],
			cwd,
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

	it("allows execution and planning resources in ordinary sessions independently of scoped autoload grants", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "executing-plans");
		const planning = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const context = { session, skills: [skill, planning] };
		const url = parseInternalUrl(`skill://${skill.name}`);
		expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
		const revoke = grantSpecSkillAccess(session, skill);
		try {
			expect((await buildSkillPromptMessage(skill, { args: "" }, "autoload", { scope: session })).details.path).toBe(
				skill.filePath,
			);
			expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
			expect(await handler.locate(url, context)).toBe(skill.filePath);
			expect((await handler.resolve(url, { ...context, session: { ...session } })).sourcePath).toBe(skill.filePath);
			expect((await handler.resolve(parseInternalUrl(`skill://${planning.name}`), context)).sourcePath).toBe(planning.filePath);
		} finally {
			revoke();
		}
		expect(await handler.locate(url, context)).toBe(skill.filePath);
	});

	it("requires an exact resource grant despite branch provenance and rejects same-name resource substitution", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "subagent-driven-development");
		const substitute = { ...(await fixture()), name: skill.name, source: skill.source };
		const scope = {};
		const end = bindSpecSkillPolicy(scope, { phase: "executing", allowedSkills: [skill.name] });
		const access = { scope, getSessionBranch: () => [provenance(skill), provenance(substitute)] };
		try {
			await expect(buildSkillPromptMessage(skill, { args: "" }, "autoload", access)).rejects.toBeInstanceOf(
				SkillAccessDeniedError,
			);
			const revoke = grantSpecSkillAccess(scope, skill);
			try {
				expect((await buildSkillPromptMessage(skill, { args: "" }, "autoload", access)).details.path).toBe(
					skill.filePath,
				);
				await expect(buildSkillPromptMessage(substitute, { args: "" }, "user", access)).rejects.toBeInstanceOf(
					SkillAccessDeniedError,
				);
				expect(() => checkSkillReadAccess(substitute, access)).toThrow(SkillAccessDeniedError);
			} finally {
				revoke();
			}
			expect(() => checkSkillReadAccess(skill, access)).toThrow(SkillAccessDeniedError);
			const revokeSubstitute = grantSpecSkillAccess(scope, substitute);
			try {
				expect((await buildSkillPromptMessage(substitute, { args: "" }, "user", access)).details.path).toBe(
					substitute.filePath,
				);
				expect(() => checkSkillReadAccess(skill, access)).toThrow(SkillAccessDeniedError);
			} finally {
				revokeSubstitute();
			}
		} finally {
			end();
		}
		expect(() => checkSkillReadAccess(skill, { scope, getSessionBranch: () => [] })).not.toThrow();
	});

	it("keeps same-name personal skills callable while allowing bundled brainstorming handoffs", async () => {
		const bundled = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const custom = { ...(await fixture()), name: bundled.name, source: "custom:project" };
		const brainstorming = await loadSpecDrivenSkill("superpowers", "brainstorming");
		const invoked = await buildSkillPromptMessage(brainstorming, { args: "" }, "user");
		const branch = [provenance(brainstorming, invoked.details)];
		const brainstormingUrl = parseInternalUrl(`skill://${brainstorming.name}`);
		const brainstormingContext = { skills: [brainstorming], getSessionBranch: () => branch };
		expect((await handler.resolve(brainstormingUrl, brainstormingContext)).sourcePath).toBe(brainstorming.filePath);
		expect(await handler.locate(brainstormingUrl, brainstormingContext)).toBe(brainstorming.filePath);
		expect((await buildSkillPromptMessage(custom, { args: "" }, "user")).details.path).toBe(custom.filePath);
		const url = parseInternalUrl(`skill://${custom.name}`);
		const context = { skills: [custom], getSessionBranch: () => branch };
		expect((await handler.resolve(url, context)).sourcePath).toBe(custom.filePath);
		expect(await handler.locate(url, context)).toBe(custom.filePath);
		const bundledContext = { skills: [bundled], getSessionBranch: () => branch };
		expect((await handler.resolve(url, bundledContext)).sourcePath).toBe(bundled.filePath);
		expect(await handler.locate(url, bundledContext)).toBe(bundled.filePath);
		const personalInvocation = await buildSkillPromptMessage(custom, { args: "" }, "user");
		expect((await handler.resolve(url, {
			skills: [bundled],
			getSessionBranch: () => [provenance(custom, personalInvocation.details)],
		})).sourcePath).toBe(bundled.filePath);
		const explicit = await buildSkillPromptMessage(bundled, { args: "" }, "user", {
			getSessionBranch: () => branch,
		});
		expect(explicit.details.path).toBe(bundled.filePath);
		const authorized = {
			skills: [bundled],
			getSessionBranch: () => [...branch, provenance(bundled, explicit.details)],
		};
		expect((await handler.resolve(url, authorized)).sourcePath).toBe(bundled.filePath);
		expect(await handler.locate(url, authorized)).toBe(bundled.filePath);
	});

	it("preserves explicit OpenSpec invocation arguments without requiring invocation for reads", async () => {
		const skill = await loadSpecDrivenSkill("openspec", "openspec-propose");
		const url = parseInternalUrl(`skill://${skill.name}`);
		const context = { skills: [skill], getSessionBranch: () => [] };
		expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
		const invoked = await buildSkillPromptMessage(skill, { args: "change-name $ARGUMENTS {{literal}}" }, "user");
		expect(invoked.message).toContain("change-name $ARGUMENTS {{literal}}");
		expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
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

	it("resolves Dev-granted skill resources while denying another ungranted skill", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "subagent-driven-development");
		const other = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const end = bindSpecSkillPolicy(session, { phase: "executing", allowedSkills: [skill.name, other.name] });
		const revoke = grantSpecSkillAccess(session, skill);
		try {
			for (const relative of [
				"SKILL.md",
				"references/fix-loop.md",
				"references/final-review.md",
				"scripts/review-package",
			]) {
				const url = parseInternalUrl(`skill://${skill.name}/${relative}`);
				const context = { session, skills: [skill, other] };
				const located = await handler.locate(url, context);
				expect(located).toBe(path.join(skill.baseDir, relative));
				expect(await handler.locate(url, { ...context, session: { ...session } })).toBe(path.join(skill.baseDir, relative));
			}
			await expect(
				handler.resolve(parseInternalUrl(`skill://${other.name}`), { session, skills: [skill, other] }),
			).rejects.toBeInstanceOf(SkillAccessDeniedError);
		} finally {
			revoke();
			end();
		}
	});

	it("invalidates prior grants on policy replacement while ordinary sessions retain access", async () => {
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const allowed = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const endRequirements = bindSpecSkillPolicy(session, { phase: "requirements", allowedSkills: [allowed.name] });
		const revoke = grantSpecSkillAccess(session, allowed);
		const url = parseInternalUrl(`skill://${allowed.name}`);
		try {
			expect((await handler.resolve(url, { session, skills: [allowed] })).sourcePath).toBe(allowed.filePath);
			expect((await handler.resolve(url, { session: { ...session }, skills: [allowed] })).sourcePath).toBe(allowed.filePath);
			const endSolution = bindSpecSkillPolicy(session, { phase: "solution", allowedSkills: [] });
			try {
				// A stale disposer must not restore the requirements grant or remove the replacement policy.
				endRequirements();
				expect(() => grantSpecSkillAccess(session, allowed)).toThrow(SkillAccessDeniedError);
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
			expect((await handler.resolve(url, { session, skills: [allowed] })).sourcePath).toBe(allowed.filePath);
		} finally {
			revoke();
			endRequirements();
		}
	});

	it("keeps personal collision precedence while retaining direct bundled resource loading", async () => {
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
		const selected = skills.find(skill => skill.name === "writing-plans")!;
		expect((await buildSkillPromptMessage(selected, { args: "" }, "user")).details.path).toBe(overridePath);
		const url = parseInternalUrl("skill://writing-plans");
		expect((await handler.resolve(url, { skills })).sourcePath).toBe(overridePath);
		expect(await handler.locate(url, { skills })).toBe(overridePath);
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

	it("opens ordinary planning and its resources without current-branch invocation", async () => {
		const skill = await loadSpecDrivenSkill("superpowers", "writing-plans");
		const url = parseInternalUrl(`skill://${skill.name}`);
		const context = { skills: [skill], getSessionBranch: () => [] };
		expect((await handler.resolve(url, context)).sourcePath).toBe(skill.filePath);
		expect(await handler.locate(url, context)).toBe(skill.filePath);
	});

	it("uses scoped program grants for real resources while ordinary sessions remain readable", async () => {
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
			expect((await handler.resolve(url, { session: { ...session }, skills: [skill] })).sourcePath).toBe(skill.filePath);
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
			["verification-before-completion", "systematic-debugging", "writing-skills"].map(name =>
				loadSpecDrivenSkill("superpowers", name),
			),
		);
		const resources = await ensureSpecDrivenResources();
		skills.push(
			...(await Promise.all(
				resources.manifest.skills
					.filter(entry => entry.source === "openspec")
					.map(entry => loadSpecDrivenSkill("openspec", entry.name)),
			)),
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
		const pinned = await loadSpecDrivenSkill("jch", "jch-grill-me");
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
				handler.resolve(parseInternalUrl(`skill://${pinned.name}`), { skills: [] }),
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
