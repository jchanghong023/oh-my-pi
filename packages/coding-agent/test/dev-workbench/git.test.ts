import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DevWorkflowGit } from "../../src/dev-workbench/workflow-git";
import type { DevOperationReceipt, DevProject } from "../../src/dev-workbench/workflow-types";
import { WorkflowConsumerFixture, workflowGit } from "./workflow-fixture";

async function setup() {
	const fixture = await WorkflowConsumerFixture.create();
	const git = new DevWorkflowGit();
	const registeredAt = new Date().toISOString();
	const project: DevProject = {
		...(await git.inspect(fixture.project)),
		id: "project-git",
		name: "Git consumer",
		revision: 0,
		createdAt: registeredAt,
		updatedAt: registeredAt,
	};
	const worktree = await git.createWorktree(project, "development", "sr-git", "worktree-git");
	await workflowGit(worktree.path, ["config", "user.name", "Git consumer"], fixture.env);
	await workflowGit(worktree.path, ["config", "user.email", "consumer@example.invalid"], fixture.env);
	await workflowGit(worktree.path, ["config", "commit.gpgsign", "false"], fixture.env);
	return { fixture, git, project, worktree };
}
function receipt(operationId: string): DevOperationReceipt {
	return {
		operationId,
		commandDigest: "consumer",
		type: "publishMaterials",
		status: "running",
		startedAt: new Date().toISOString(),
		revision: 0,
		steps: [],
	};
}
function recorder(operation: DevOperationReceipt) {
	return async (name: string, detail: string) => {
		operation.steps.push({ name, detail, at: new Date().toISOString() });
	};
}

test("publication uses the SR index without consuming unrelated staged or dirty project content", async () => {
	const { fixture, git, project, worktree } = await setup();
	await using owned = fixture;
	await fs.writeFile(path.join(fixture.project, "root-private.txt"), "unrelated root bytes\n");
	await workflowGit(fixture.project, ["add", "--", "root-private.txt"], fixture.env);
	await fs.writeFile(path.join(worktree.path, "authorized.txt"), "approved scope\n");
	await fs.writeFile(path.join(worktree.path, "private.txt"), "unrelated staged SR bytes\n");
	await workflowGit(worktree.path, ["add", "--", "private.txt"], fixture.env);
	const operation = receipt("publish-scoped");
	await git.publish(
		project,
		worktree,
		["authorized.txt"],
		"Publish scoped material",
		false,
		operation,
		recorder(operation),
	);
	expect(await workflowGit(worktree.path, ["show", "HEAD:authorized.txt"], fixture.env)).toBe("approved scope");
	expect(await workflowGit(worktree.path, ["diff", "--cached", "--name-only"], fixture.env)).toBe("private.txt");
	expect(await workflowGit(fixture.project, ["diff", "--cached", "--name-only"], fixture.env)).toBe(
		"root-private.txt",
	);
	expect(await fs.readFile(path.join(worktree.path, "private.txt"), "utf8")).toBe("unrelated staged SR bytes\n");
}, 120_000);

test("a real rejected push preserves the commit and retries only the same fixed-SHA publication", async () => {
	const { fixture, git, project, worktree } = await setup();
	await using owned = fixture;
	await fs.writeFile(path.join(worktree.path, "authorized.txt"), "committed before push failure\n");
	await workflowGit(
		fixture.root,
		["--git-dir", path.join(fixture.root, "remote.git"), "config", "receive.denyNonFastForwards", "true"],
		fixture.env,
	);
	await workflowGit(worktree.path, ["push", "origin", `HEAD:refs/heads/${worktree.branch}`], fixture.env);
	const other = await git.createWorktree(project, "development", "sr-remote-conflict", "remote-conflict");
	await fs.writeFile(path.join(other.path, "remote-only.txt"), "real conflicting remote history\n");
	await workflowGit(other.path, ["add", "--", "remote-only.txt"], fixture.env);
	await workflowGit(other.path, ["commit", "-m", "Competing remote history"], fixture.env);
	await workflowGit(other.path, ["push", "origin", `HEAD:refs/heads/${worktree.branch}`], fixture.env);
	const operation = receipt("publish-retry");
	await expect(
		git.publish(project, worktree, ["authorized.txt"], "Publish once", true, operation, recorder(operation)),
	).rejects.toThrow();
	const committed = operation.steps.find(step => step.name === "commit")!.detail;
	expect(await workflowGit(worktree.path, ["rev-parse", "HEAD"], fixture.env)).toBe(committed);
	expect(operation.steps.some(step => step.name === "push")).toBe(false);
	await expect(
		git.publish(project, worktree, ["authorized.txt"], "Changed scope", true, operation, recorder(operation)),
	).rejects.toThrow("scope changed");
	await workflowGit(fixture.project, ["push", "origin", `:refs/heads/${worktree.branch}`], fixture.env);
	await git.publish(project, worktree, ["authorized.txt"], "Publish once", true, operation, recorder(operation));
	expect(await workflowGit(worktree.path, ["rev-parse", "HEAD"], fixture.env)).toBe(committed);
	expect(operation.steps.filter(step => step.name === "commit")).toHaveLength(1);
	expect(operation.steps.filter(step => step.name === "push")).toHaveLength(1);
	expect(
		(await workflowGit(worktree.path, ["ls-remote", "origin", `refs/heads/${worktree.branch}`], fixture.env)).split(
			/\s/u,
		)[0],
	).toBe(committed);
}, 120_000);

test("a lost commit receipt is recovered from the actual operation commit without another commit", async () => {
	const { fixture, git, project, worktree } = await setup();
	await using owned = fixture;
	await fs.writeFile(path.join(worktree.path, "authorized.txt"), "once\n");
	const operation = receipt("publish-lost-receipt");
	await expect(
		git.publish(project, worktree, ["authorized.txt"], "Publish once", false, operation, async (name, detail) => {
			if (name === "commit") throw new Error("receipt storage unavailable after real commit");
			await recorder(operation)(name, detail);
		}),
	).rejects.toThrow("receipt storage unavailable");
	const committed = await workflowGit(worktree.path, ["rev-parse", "HEAD"], fixture.env);
	await git.publish(project, worktree, ["authorized.txt"], "Publish once", false, operation, recorder(operation));
	expect(await workflowGit(worktree.path, ["rev-parse", "HEAD"], fixture.env)).toBe(committed);
	expect(operation.steps.find(step => step.name === "commit")?.detail).toBe(committed);
}, 120_000);

test("publication refuses the actual remote default branch before any commit or push", async () => {
	const { fixture, git, project } = await setup();
	await using owned = fixture;
	const before = await workflowGit(fixture.project, ["rev-parse", "HEAD"], fixture.env);
	await fs.writeFile(path.join(fixture.project, "user-file.txt"), "default branch user edit\n");
	const operation = receipt("default-denied");
	await expect(
		git.publish(
			project,
			{ path: fixture.project, branch: project.defaultBranch, baseCommit: before },
			["user-file.txt"],
			"Must not publish",
			true,
			operation,
			recorder(operation),
		),
	).rejects.toThrow("default");
	expect(await workflowGit(fixture.project, ["rev-parse", "HEAD"], fixture.env)).toBe(before);
	expect(operation.steps).toEqual([]);
	expect(await fs.readFile(path.join(fixture.project, "user-file.txt"), "utf8")).toBe("default branch user edit\n");
}, 120_000);
