import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../src/session/session-manager";
import {
	buildRequirementSnapshot,
	canonicalJson,
	decodeRequirementPackage,
	encodeRequirementPackage,
	safeMaterialPath,
	sha256,
	validateRequirementContent,
} from "../../src/aireq-workbench/requirement-package";
import { AIReqWorkflowGit } from "../../src/aireq-workbench/workflow-git";
import { AIReqWorkflowService, AIReqWorkflowStore, type AIReqWorkflowPorts } from "../../src/aireq-workbench/workflow-store";
import type {
	AIReqNativeSessionRef,
	AIReqPackageManifest,
	AIReqProjectState,
	AIReqRequirementContent,
	AIReqWorkflowCommand,
} from "../../src/aireq-workbench/workflow-types";

const roots: string[] = [];
const nativeHistories: SessionManager[] = [];
afterEach(async () => {
	for (const manager of nativeHistories.splice(0)) await manager.close();
	for (const root of roots.splice(0)) await removeWithRetries(root);
});
async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-domain-"));
	roots.push(directory);
	const root = path.join(directory, "repo");
	await fs.mkdir(root);
	for (const name of ["objects", "refs/heads", "refs/tags", "hooks"])
		await fs.mkdir(path.join(root, ".git", name), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/trunk\n");
	await fs.writeFile(
		path.join(root, ".git", "config"),
		"[core]\nrepositoryformatversion = 0\nautocrlf = false\n[commit]\ngpgsign = false\n[user]\nname = Domain Contracts\nemail = domain@example.invalid\n",
	);
	const repo = vcs.requireGit(root);
	await repo.configSet("core.hooksPath", path.join(repo.info().gitDir, "hooks"));
	await fs.writeFile(path.join(root, "existing.txt"), "preserve user code\n");
	await repo.stageFiles(["existing.txt"]);
	await repo.commitCreate("initial", {});
	const store = new AIReqWorkflowStore(path.join(directory, "profile", "aireq"));
	const project = await store.registerProject(root, "Example");
	return { directory, root, repo, store, project };
}
const unavailable: AIReqWorkflowPorts = {
	review: async () => {
		throw new Error("Native reviewer unavailable");
	},
	settle: async () => {
		throw new Error("Native settlement unavailable");
	},
	start: async () => {
		throw new Error("Native session unavailable");
	},
};
function content(irId: string): AIReqRequirementContent {
	const markdown = (title: string) =>
		`# ${title}\n\n## Scope\nExplicit behavior and constraints.\n\n## Rules and exceptions\nReject conflicting operations and preserve files.\n\n## Acceptance\nGiven a confirmed input, observe the declared behavior.\n`;
	return {
		title: "AI-generated business title",
		document: { path: `docs/aireq/requirements/${irId}/ir.md`, content: markdown("Business requirement") },
		srs: [
			{
				id: "sr-one",
				title: "AI-generated system title",
				document: { path: `docs/aireq/requirements/${irId}/sr-one.md`, content: markdown("System requirement") },
			},
		],
		attachments: [
			{ path: `docs/aireq/requirements/${irId}/attachments/source.bin`, content: new Uint8Array([0, 255, 128, 42]) },
		],
	};
}
function realReviewer(directory: string): AIReqWorkflowPorts["review"] {
	return async input => {
		const manager = SessionManager.create(directory, path.join(directory, "independent-reviews"));
		nativeHistories.push(manager);
		manager.appendMessage({
			role: "user",
			content: `Review fixed snapshot ${input.snapshot.digest}; files: ${[...input.documents.keys()].join(", ")}`,
			timestamp: Date.now(),
		});
		await manager.ensureOnDisk();
		await manager.flush();
		return {
			id: `review-${manager.getSessionId()}`,
			snapshotDigest: input.snapshot.digest,
			passed: true,
			report: "Contract fixture independent review: complete fixed IR/SR snapshot accepted.",
			createdAt: new Date().toISOString(),
			reviewer: {
				...input.ref,
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile()!,
				role: "reviewer",
				phase: "requirements",
				round: 0,
			},
		};
	};
}
async function localDraft() {
	const owned = await fixture();
	const sessions: { manager: SessionManager; ref: AIReqNativeSessionRef }[] = [];
	const ports: AIReqWorkflowPorts = {
		...unavailable,
		start: async input => {
			const manager = SessionManager.create(
				input.worktree?.path ?? owned.root,
				path.join(owned.directory, "native-sessions"),
			);
			nativeHistories.push(manager);
			manager.appendMessage({
				role: "user",
				content: "Keep this native requirement history after removing navigation.",
				timestamp: Date.now(),
			});
			await manager.ensureOnDisk();
			await manager.flush();
			const ref: AIReqNativeSessionRef = {
				...input.ref,
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile()!,
				role: input.stage,
				phase: input.stage,
				round: input.round,
			};
			sessions.push({ manager, ref });
			return ref;
		},
		settle: async ref => {
			for (const session of sessions)
				if (session.ref.irId === ref.irId) {
					await session.manager.flush();
				}
		},
	};
	const service = new AIReqWorkflowService(owned.store, new AIReqWorkflowGit(), ports);
	await service.command({
		type: "createRelease",
		operationId: "local-release",
		expectedRevision: 0,
		projectId: owned.project.id,
		title: "Local release",
	});
	let state = await owned.store.read(owned.project.id);
	const created = await service.command({
		type: "createLocalDraft",
		operationId: "local-draft",
		expectedRevision: state.revision,
		projectId: owned.project.id,
		releaseId: state.releases[0]!.id,
	});
	if (created.status !== "completed" || !created.irId) throw new Error("Real local draft fixture failed");
	state = await owned.store.read(owned.project.id);
	const saved = await service.updateRequirements(
		{ projectId: owned.project.id, irId: created.irId },
		state.revision,
		"local-content",
		content(created.irId),
	);
	if (saved.status !== "completed") throw new Error("Real requirement material fixture failed");
	state = await owned.store.read(owned.project.id);
	return { ...owned, service, ports, sessions, group: state.groups[0]!, state };
}
async function importedFixture() {
	const { directory, root, repo, store } = await fixture();
	const receivingRoot = path.join(directory, "receiver");
	await vcs.clone(root, receivingRoot);
	const receiver = vcs.requireGit(receivingRoot);
	await receiver.configSet("user.name", "Domain Contracts");
	await receiver.configSet("user.email", "domain@example.invalid");
	await receiver.configSet("commit.gpgsign", "false");
	await receiver.configSet("core.autocrlf", "false");
	await receiver.configSet("core.hooksPath", path.join(receiver.info().gitDir, "hooks"));
	const project = await store.registerProject(receivingRoot, "Receiver");
	const irId = "imported-ir";
	const requirements = content(irId);
	requirements.srs.push({
		id: "sr-two",
		title: "Second system requirement",
		document: { path: `docs/aireq/requirements/${irId}/sr-two.md`, content: requirements.srs[0]!.document.content },
	});
	const unchangedContent = structuredClone(requirements);
	requirements.attachments.push({
		path: `docs/aireq/requirements/${irId}/requirements.json`,
		content: canonicalJson({
			version: 1,
			irId,
			title: requirements.title,
			documentPath: requirements.document.path,
			srs: requirements.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		}),
	});
	const snapshot = buildRequirementSnapshot("source-project", irId, requirements);
	const createdAt = "2026-11-10T00:00:00.000Z";
	const manifest: AIReqPackageManifest = {
		format: "omp-aireq-requirements",
		version: 1,
		packageId: "received-package",
		sourceProjectId: "source-project",
		repositoryId: project.repositoryId,
		irId,
		releaseId: "source-release",
		createdAt,
		snapshot,
		confirmation: { operationId: "source-confirm", snapshotDigest: snapshot.digest, confirmedAt: createdAt },
		review: {
			id: "source-review",
			snapshotDigest: snapshot.digest,
			passed: true,
			report: "Contract fixture: independent source review record.",
			reviewer: { sessionId: "source-review-session", role: "reviewer" },
			createdAt,
		},
		files: snapshot.files,
	};
	const files = new Map(
		[requirements.document, ...requirements.srs.map(sr => sr.document), ...requirements.attachments].map(
			doc =>
				[doc.path, typeof doc.content === "string" ? new TextEncoder().encode(doc.content) : doc.content] as const,
		),
	);
	const packagePath = path.join(directory, "source.zip");
	await encodeRequirementPackage(packagePath, manifest, files);
	const decoded = await decodeRequirementPackage(packagePath);
	const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), {
		...unavailable,
		settle: async ref => {
			const actual = await store.read(ref.projectId);
			expect(actual.activeSrId).toBe(ref.srId);
			expect(actual.groups.find(group => group.id === ref.irId)?.sessions).toEqual([]);
			if (ref.srId) expect(actual.srs.find(sr => sr.id === ref.srId)?.sessions).toEqual([]);
		},
	});
	await service.command({
		type: "createRelease",
		operationId: "receiver-release",
		expectedRevision: 0,
		projectId: project.id,
		title: "Receiving release",
	});
	let state = await store.read(project.id);
	const imported = await service.importPackage(
		{
			type: "importPackage",
			operationId: "receive-package",
			expectedRevision: state.revision,
			projectId: project.id,
			releaseId: state.releases[0]!.id,
			packageId: manifest.packageId,
		},
		decoded,
	);
	expect(imported.status).toBe("completed");
	state = await store.read(project.id);
	return { directory, repo, store, project, irId, unchangedContent, manifest, decoded, service, state };
}
describe("AIReq workflow domain contracts", () => {
	test("reads and restarts never initialize native sessions or change Git", async () => {
		const { root, repo, store, project } = await fixture();
		const before = await repo.statusPorcelain({});
		new AIReqWorkflowService(store, new AIReqWorkflowGit(), unavailable);
		const view = await new AIReqWorkflowStore(store.registryDirectory).view(project.id);
		expect(view.currentProjectId).toBe(project.id);
		expect(view.running).toEqual([]);
		expect(view.groups).toEqual([]);
		expect(await repo.statusPorcelain({})).toBe(before);
		expect(await fs.readFile(path.join(root, "existing.txt"), "utf8")).toBe("preserve user code\n");
	});
	test("all worktrees share one canonical project and CAS domain", async () => {
		const { directory, repo, store, project } = await fixture();
		const checkout = path.join(directory, "second");
		await repo.createBranch("second", "HEAD", false);
		await repo.worktreeAdd(checkout, "second", { detach: false, clone: false });
		const same = await store.registerProject(checkout, "Other checkout");
		expect(same.id).toBe(project.id);
		expect(same.commonDir).toBe(project.commonDir);
		expect((await store.listProjects()).length).toBe(1);
		await store.mutate(project.id, 0, "release-op", { type: "createRelease" }, async ({ state }) => {
			state.releases.push({
				id: "release-one",
				projectId: project.id,
				title: "Release",
				createdAt: new Date().toISOString(),
			});
		});
		expect((await new AIReqWorkflowStore(store.registryDirectory).read(same.id)).releases[0]?.id).toBe("release-one");
		await expect(
			store.mutate(project.id, 0, "stale-op", { type: "createRelease" }, async () => {
				throw new Error("must not run");
			}),
		).rejects.toThrow("Revision conflict");
	});
	test("root-scoped registration resolves target CAS without mutating a selected project and aliases replay deterministically", async () => {
		const selected = await fixture();
		const target = await fixture();
		const service = new AIReqWorkflowService(selected.store, new AIReqWorkflowGit(), unavailable);
		await service.command({
			type: "createRelease",
			operationId: "selected-release",
			expectedRevision: 0,
			projectId: selected.project.id,
			title: "Keep selected state",
		});
		const before = await selected.store.read(selected.project.id);
		const registeredBefore = await selected.store.listProjects();
		const registration = {
			type: "registerProject" as const,
			registrationScope: "target-root" as const,
			operationId: "target-registration",
			expectedRevision: 0,
			root: target.root,
			name: "Target",
		};
		for (const malformed of [
			{ ...registration, registrationScope: undefined },
			{ ...registration, expectedRevision: before.revision },
			{ ...registration, projectId: selected.project.id },
		])
			await expect(service.command(malformed as unknown as AIReqWorkflowCommand)).rejects.toThrow();
		expect(await selected.store.listProjects()).toEqual(registeredBefore);
		const registered = await service.command(registration);
		expect(registered.status).toBe("completed");
		expect(registered.projectId).toBe(target.project.id);
		expect(await selected.store.read(selected.project.id)).toEqual(before);
		const targetState = await selected.store.read(target.project.id);
		await service.command({
			type: "createRelease",
			operationId: "target-release",
			expectedRevision: targetState.revision,
			projectId: target.project.id,
			title: "Target release",
		});
		const alias = path.join(target.directory, "target-alias");
		await target.repo.createBranch("target-alias", "HEAD", false);
		await target.repo.worktreeAdd(alias, "target-alias", { detach: false, clone: false });
		expect(await service.command({ ...registration, root: alias })).toEqual(registered);
		const current = await selected.store.read(target.project.id);
		const reused = await service.command({
			...registration,
			operationId: "alias-registration",
			root: alias,
			name: "Do not rename",
		});
		expect(reused.projectId).toBe(target.project.id);
		expect(reused.status).toBe("completed");
		const after = await selected.store.read(target.project.id);
		expect(after.project.name).toBe(target.project.name);
		expect(after.releases).toEqual(current.releases);
		expect(after.groups).toEqual(current.groups);
		expect(await selected.store.read(selected.project.id)).toEqual(before);
		expect(await selected.store.listProjects()).toHaveLength(2);
		await expect(
			service.command({
				type: "createRelease",
				operationId: "stale-target-release",
				expectedRevision: 0,
				projectId: target.project.id,
				title: "Must reject",
			}),
		).rejects.toThrow("Revision conflict");
	});
	test("throwing or invalid independent reviews leave editable drafts, preserve failed receipts and explicitly retry", async () => {
		const owned = await localDraft();
		const ref = { projectId: owned.project.id, irId: owned.group.id };
		const review = realReviewer(owned.directory);
		let calls = 0;
		const service = new AIReqWorkflowService(owned.store, new AIReqWorkflowGit(), {
			...owned.ports,
			review: async input => {
				calls++;
				if (calls === 1) throw new Error("Real review callback failed");
				return review(input);
			},
		});
		const command = {
			type: "confirmRequirements" as const,
			operationId: "retry-confirmation",
			expectedRevision: owned.state.revision,
			...ref,
			snapshotDigest: owned.group.snapshot!.digest,
		};
		const failed = await service.command(command);
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("callback failed");
		let state = await owned.store.read(ref.projectId);
		expect(state.groups[0]!.status).toBe("draft");
		expect(state.groups[0]!.confirmation).toBeUndefined();
		expect(state.groups[0]!.review).toBeUndefined();
		expect((await owned.store.view(ref.projectId)).drafts[0]?.id).toBe(ref.irId);
		expect(state.groups[0]!.sessions).toEqual(owned.group.sessions);
		expect(await fs.readFile(owned.sessions[0]!.ref.sessionFile, "utf8")).toContain(
			"Keep this native requirement history",
		);
		const completed = await service.command(command);
		expect(completed.status).toBe("completed");
		expect(calls).toBe(2);
		expect(await service.command(command)).toEqual(completed);
		expect(calls).toBe(2);
		state = await owned.store.read(ref.projectId);
		const changed = content(ref.irId);
		changed.title = "Explicit edit after confirmation";
		expect(
			(await service.updateRequirements(ref, state.revision, "edit-before-invalid-review", changed)).status,
		).toBe("completed");
		state = await owned.store.read(ref.projectId);
		const invalidService = new AIReqWorkflowService(owned.store, new AIReqWorkflowGit(), {
			...owned.ports,
			review: async input => {
				const result = await review(input);
				return { ...result, reviewer: { ...owned.group.sessions[0]!, role: "reviewer" } };
			},
		});
		const invalid = await invalidService.command({
			...command,
			operationId: "invalid-review",
			expectedRevision: state.revision,
			snapshotDigest: state.groups[0]!.snapshot!.digest,
		});
		expect(invalid.status).toBe("failed");
		expect(
			invalid.receipt.steps.some(
				step => step.name === "review-result" && step.detail.includes("fixed IR/SR snapshot accepted"),
			),
		).toBe(true);
		state = await owned.store.read(ref.projectId);
		expect(state.groups[0]!.status).toBe("draft");
		expect(state.groups[0]!.confirmation).toBeUndefined();
		expect(state.groups[0]!.review).toBeUndefined();
		expect(
			(
				await service.command({
					...command,
					operationId: "fresh-valid-review",
					expectedRevision: state.revision,
					snapshotDigest: state.groups[0]!.snapshot!.digest,
				})
			).status,
		).toBe("completed");
	});
	test("snapshot mutation during review permanently invalidates that result but fresh confirmation remains usable", async () => {
		const owned = await localDraft();
		const ref = { projectId: owned.project.id, irId: owned.group.id };
		const file = path.join(owned.group.worktree!.path, owned.group.documentPath);
		const original = await fs.readFile(file);
		const review = realReviewer(owned.directory);
		let calls = 0;
		const service = new AIReqWorkflowService(owned.store, new AIReqWorkflowGit(), {
			...owned.ports,
			review: async input => {
				calls++;
				const result = await review(input);
				if (calls === 1) await fs.appendFile(file, "\nUncaptured late edit.\n");
				return result;
			},
		});
		const command = {
			type: "confirmRequirements" as const,
			operationId: "changed-during-review",
			expectedRevision: owned.state.revision,
			...ref,
			snapshotDigest: owned.group.snapshot!.digest,
		};
		const failed = await service.command(command);
		expect(failed.status).toBe("failed");
		expect(failed.receipt.steps.some(step => step.name === "review-invalidated")).toBe(true);
		expect(failed.receipt.steps.some(step => step.name === "review-result")).toBe(true);
		expect(await fs.readFile(file, "utf8")).toContain("Uncaptured late edit");
		let state = await owned.store.read(ref.projectId);
		expect(state.groups[0]!.status).toBe("draft");
		expect(state.groups[0]!.confirmation).toBeUndefined();
		expect(state.groups[0]!.review).toBeUndefined();
		await fs.writeFile(file, original);
		const retry = await service.command(command);
		expect(retry.status).toBe("failed");
		expect(retry.error).toContain("new operation");
		expect(calls).toBe(1);
		state = await owned.store.read(ref.projectId);
		expect(
			(
				await service.command({
					...command,
					operationId: "fresh-fixed-snapshot-review",
					expectedRevision: state.revision,
				})
			).status,
		).toBe("completed");
		expect(calls).toBe(2);
	});
	// Clone/import, two private-index publications/pushes and exact remote merge
	// checks share one budget, matching the real-Git publication integration tests.
	test("revised two-SR requirements publish owned deletion through private index, push and exact merge without foreign staging", async () => {
		const owned = await importedFixture();
		const { store, project, irId, repo, directory } = owned;
		const ref = { projectId: project.id, irId };
		const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), {
			...unavailable,
			settle: async () => {},
			review: realReviewer(directory),
		});
		let state = await store.read(project.id);
		let group = state.groups[0]!;
		const checkout = vcs.requireGit(group.worktree!.path);
		const first = await service.command({
			type: "publishMaterials",
			operationId: "two-sr-publish",
			expectedRevision: state.revision,
			...ref,
			scope: "requirements",
			paths: [...group.files, ...group.evidenceFiles!].map(file => file.path),
			message: "Publish two SRs",
			push: true,
		});
		expect(first.status).toBe("completed");
		const retiredPath = `docs/aireq/requirements/${irId}/sr-two.md`;
		const retiredBytes = await fs.readFile(path.join(group.worktree!.path, retiredPath));
		const revised = structuredClone(owned.unchangedContent);
		revised.srs = revised.srs.filter(sr => sr.id !== "sr-two");
		await fs.appendFile(path.join(group.worktree!.path, retiredPath), "\nUnrecorded retirement edit\n");
		state = await store.read(project.id);
		const failedEdit = await service.updateRequirements(ref, state.revision, "remove-second-sr", revised);
		expect(failedEdit.status).toBe("failed");
		expect(failedEdit.error).toContain("changed before retirement");
		await fs.writeFile(path.join(group.worktree!.path, retiredPath), retiredBytes);
		expect((await service.updateRequirements(ref, state.revision, "remove-second-sr", revised)).status).toBe(
			"completed",
		);
		state = await store.read(project.id);
		group = state.groups[0]!;
		expect(group.srIds).toEqual(["sr-one"]);
		expect(group.retiredFiles).toEqual([{ path: retiredPath, sha256: sha256(""), size: -1 }]);
		expect(
			await fs.readFile(
				path.join(project.commonDir, "omp-aireq-workflow-v1", "history", irId, "remove-second-sr", retiredPath),
			),
		).toEqual(retiredBytes);
		expect(
			await fs.readFile(
				path.join(
					project.commonDir,
					"omp-aireq-workflow-v1",
					"snapshots",
					irId,
					owned.manifest.snapshot.digest,
					retiredPath,
				),
			),
		).toEqual(retiredBytes);
		expect(
			(
				await service.command({
					type: "confirmRequirements",
					operationId: "confirm-one-sr",
					expectedRevision: state.revision,
					...ref,
					snapshotDigest: group.snapshot!.digest,
				})
			).status,
		).toBe("completed");
		state = await store.read(project.id);
		group = state.groups[0]!;
		const versions = [...group.files, ...group.evidenceFiles!, ...group.retiredFiles!];
		const publication = {
			type: "publishMaterials" as const,
			operationId: "one-sr-publish",
			expectedRevision: state.revision,
			...ref,
			scope: "requirements" as const,
			paths: versions.map(file => file.path),
			versions,
			message: "Retire second SR",
			push: true,
		};
		expect(
			(
				await service.command({
					...publication,
					operationId: "missing-deletion-scope",
					paths: publication.paths.filter(file => file !== retiredPath),
				})
			).status,
		).toBe("failed");
		state = await store.read(project.id);
		expect(
			(
				await service.command({
					...publication,
					operationId: "wrong-deletion-version",
					expectedRevision: state.revision,
					versions: versions.map(file => (file.path === retiredPath ? { ...file, size: 0 } : file)),
				})
			).status,
		).toBe("failed");
		await fs.writeFile(path.join(group.worktree!.path, "existing.txt"), "Keep foreign staging\n");
		await checkout.stageFiles(["existing.txt"]);
		await fs.writeFile(path.join(group.worktree!.path, "foreign.ts"), "export const untouched = true;\n");
		class LateResurrectionGit extends AIReqWorkflowGit {
			override async publish(...args: Parameters<AIReqWorkflowGit["publish"]>): Promise<void> {
				await fs.writeFile(path.join(args[1].path, retiredPath), retiredBytes);
				return super.publish(...args);
			}
		}
		state = await store.read(project.id);
		const lateService = new AIReqWorkflowService(store, new LateResurrectionGit(), {
			...unavailable,
			settle: async () => {},
		});
		const late = await lateService.command({
			...publication,
			operationId: "late-resurrection",
			expectedRevision: state.revision,
		});
		expect(late.status).toBe("failed");
		expect(late.error).toContain("versions changed");
		expect(late.receipt.steps.some(step => step.name === "commit")).toBe(false);
		await fs.rm(path.join(group.worktree!.path, retiredPath));
		state = await store.read(project.id);
		const published = await service.command({ ...publication, expectedRevision: state.revision });
		expect(published.status).toBe("completed");
		const commit = published.receipt.steps.find(step => step.name === "commit")!.detail;
		expect(await checkout.lsTree(commit, [retiredPath])).toEqual([]);
		expect((await checkout.showBlob(`${commit}:existing.txt`)).data.toString()).toBe("preserve user code\n");
		expect(await checkout.lsTree(commit, ["foreign.ts"])).toEqual([]);
		const status = await checkout.statusPorcelain({});
		expect(status).toContain("M  existing.txt");
		expect(status).toContain("?? foreign.ts");
		expect((await checkout.remoteRef("origin", `refs/heads/${group.worktree!.branch}`)).sha).toBe(commit);
		const exportedPath = path.join(directory, "one-sr.zip");
		await service.exportPackage(project.id, irId, exportedPath);
		const exported = await decodeRequirementPackage(exportedPath);
		expect(exported.manifest.snapshot.srs.map(sr => sr.id)).toEqual(["sr-one"]);
		expect(exported.files.has(retiredPath)).toBe(false);
		state = await store.read(project.id);
		expect(
			(
				await service.command({
					type: "markRequirementsPrSubmitted",
					operationId: "one-sr-pr",
					expectedRevision: state.revision,
					...ref,
					url: "https://company.example/requirements/revised",
				})
			).status,
		).toBe("completed");
		await repo.cherryPick(first.receipt.steps.find(step => step.name === "commit")!.detail);
		state = await store.read(project.id);
		const premature = await service.command({
			type: "markRequirementsMerged",
			operationId: "reject-old-two-sr-merge",
			expectedRevision: state.revision,
			...ref,
		});
		expect(premature.status).toBe("failed");
		expect(premature.error).toContain("exact confirmed IR/SR set");
		await repo.cherryPick(commit);
		state = await store.read(project.id);
		const merged = await service.command({
			type: "markRequirementsMerged",
			operationId: "one-sr-merge",
			expectedRevision: state.revision,
			...ref,
		});
		expect(merged.status).toBe("completed");
		state = await store.read(project.id);
		expect(state.groups[0]!.status).toBe("frozen");
		expect(state.groups[0]!.merge!.files).toContainEqual({ path: retiredPath, sha256: sha256(""), size: -1 });
		expect(await repo.lsTree("HEAD", [retiredPath])).toEqual([]);
		expect(state.srs.map(sr => sr.id)).toEqual(["sr-one"]);
	}, 120_000);
	test("completed receipts replay no effect; conflicting operation IDs reject", async () => {
		const { store, project } = await fixture();
		let effects = 0;
		const command = { type: "boundary" };
		const first = await store.mutate(project.id, 0, "one-op", command, async ({ step }) => {
			effects++;
			await step("files", "saved");
		});
		const repeated = await store.mutate(project.id, 0, "one-op", command, async () => {
			effects++;
		});
		expect(effects).toBe(1);
		expect(repeated.status).toBe("completed");
		expect(repeated.receipt).toEqual(first.receipt);
		await expect(store.mutate(project.id, 0, "one-op", { type: "different" }, async () => {})).rejects.toThrow(
			"different command",
		);
	});
	test("failed side effects retain checkpoints and retry before stale revision rejection", async () => {
		const { store, project } = await fixture();
		const command = { type: "publish-boundary" };
		let writes = 0;
		const failed = await store.mutate(project.id, 0, "retry-op", command, async ({ step }) => {
			writes++;
			await step("files", "actual-file-digest");
			throw new Error("push rejected");
		});
		expect(failed.status).toBe("failed");
		expect(failed.receipt.steps.map(s => s.name)).toEqual(["files"]);
		const resumed = await store.mutate(project.id, 0, "retry-op", command, async ({ receipt, step }) => {
			if (!receipt.steps.some(s => s.name === "files")) writes++;
			await step("push", "actual-remote-ref");
		});
		expect(resumed.status).toBe("completed");
		expect(writes).toBe(1);
		expect(resumed.receipt.steps.map(s => s.name)).toEqual(["files", "push"]);
	});
	test("unknown old-host lock blocks without takeover or deleting lock", async () => {
		const { store, project } = await fixture();
		const lock = path.join(project.commonDir, "omp-aireq-workflow-v1", "mutation.lock");
		await fs.mkdir(lock);
		await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ hostname: "other-machine", processId: 123 }));
		await expect(store.mutate(project.id, 0, "blocked-op", { type: "boundary" }, async () => {})).rejects.toThrow(
			"not automatically taken over",
		);
		expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")).hostname).toBe("other-machine");
	});
	test("unsupported and unknown state fields fail without migration or file mutation", async () => {
		const { store, project } = await fixture();
		const file = path.join(project.commonDir, "omp-aireq-workflow-v1", "state.json");
		const original = await fs.readFile(file, "utf8");
		for (const changed of [
			{ ...JSON.parse(original), version: 42 },
			{ ...JSON.parse(original), legacyStage: "business" },
		]) {
			const bytes = JSON.stringify(changed);
			await fs.writeFile(file, bytes);
			await expect(store.read(project.id)).rejects.toThrow();
			expect(await fs.readFile(file, "utf8")).toBe(bytes);
		}
	});
	test("browser intake creates no branch/worktree and keeps real failed native status", async () => {
		const { store, project, repo } = await fixture();
		const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), unavailable);
		await service.command({
			type: "createRelease",
			operationId: "release-op",
			expectedRevision: 0,
			projectId: project.id,
			title: "Release",
		});
		const releaseState = await store.read(project.id);
		const before = await repo.worktrees();
		const branches = await repo.listBranches(false);
		const result = await service.command({
			type: "createBrowserDraft",
			operationId: "draft-op",
			expectedRevision: releaseState.revision,
			projectId: project.id,
			releaseId: releaseState.releases[0]!.id,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("Native session unavailable");
		expect(await repo.worktrees()).toEqual(before);
		expect(await repo.listBranches(false)).toEqual(branches);
		const view = await store.view(project.id);
		expect(view.groups).toEqual([]);
		expect(view.drafts).toHaveLength(1);
		expect(view.drafts[0]!.worktree).toBeUndefined();
		expect(view.drafts[0]!.sessions).toEqual([]);
		const draft = view.drafts[0]!;
		const updated = await service.updateRequirements(
			{ projectId: project.id, irId: draft.id },
			view.revision,
			"content-op",
			content(draft.id),
		);
		expect(updated.status).toBe("completed");
		const current = await store.read(project.id);
		const group = current.groups[0]!;
		expect(group.snapshot?.srs.map(s => s.id)).toEqual(["sr-one"]);
		expect(group.confirmation).toBeUndefined();
		expect(group.status).toBe("draft");
		const binary = path.join(
			project.commonDir,
			"omp-aireq-workflow-v1",
			"drafts",
			group.id,
			`docs/aireq/requirements/${group.id}/attachments/source.bin`,
		);
		expect([...(await fs.readFile(binary))]).toEqual([0, 255, 128, 42]);
		const unchanged = await service.updateRequirements(
			{ projectId: project.id, irId: group.id },
			current.revision,
			"unchanged-content-op",
			content(group.id),
		);
		expect(unchanged.status).toBe("completed");
		expect((await store.read(project.id)).groups[0]!.revision).toBe(group.revision);
		await expect(
			service.exportPackage(project.id, group.id, path.join(project.commonDir, "denied.zip")),
		).rejects.toThrow("explicit confirmation");
	});
	test("premerge removal settles before its durable write and retains Git, bytes, snapshots and native history across restart", async () => {
		const owned = await localDraft();
		const { store, project, repo, group, sessions } = owned;
		const ref = { projectId: project.id, irId: group.id };
		const worktree = group.worktree!;
		const checkout = vcs.requireGit(worktree.path);
		await fs.writeFile(path.join(worktree.path, "existing.txt"), "keep staged user changes\n");
		await checkout.stageFiles(["existing.txt"]);
		await fs.writeFile(path.join(worktree.path, "untracked-code.ts"), "export const retained = true;\n");
		const beforeStatus = await checkout.statusPorcelain({});
		const beforeBranches = await repo.listBranches(false);
		const beforeWorktrees = await repo.worktrees();
		const beforeHead = await checkout.headSha();
		const stateFile = path.join(project.commonDir, "omp-aireq-workflow-v1", "state.json");
		const beforeState = await fs.readFile(stateFile, "utf8");
		const files = new Map<string, Buffer<ArrayBuffer>>();
		for (const file of group.files) {
			for (const root of [
				worktree.path,
				path.join(project.commonDir, "omp-aireq-workflow-v1", "snapshots", group.id, group.snapshot!.digest),
			]) {
				const absolute = path.join(root, file.path);
				files.set(absolute, await fs.readFile(absolute));
			}
		}
		const historyPath = sessions[0]!.ref.sessionFile;
		const history = await fs.readFile(historyPath);
		let settlements = 0;
		const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), {
			...owned.ports,
			settle: async (target, reason) => {
				settlements++;
				expect(target).toEqual(ref);
				expect(reason).toBe("delete-requirement");
				expect(await fs.readFile(stateFile, "utf8")).toBe(beforeState);
				await owned.ports.settle(target, reason);
			},
		});
		const command = {
			type: "deleteRequirement" as const,
			version: 1 as const,
			operationId: "remove-draft",
			expectedRevision: owned.state.revision,
			...ref,
		};
		const removed = await service.command(command);
		expect(removed.status).toBe("completed");
		expect(removed.irId).toBe(group.id);
		expect(removed.srId).toBeUndefined();
		expect(removed.deletion?.manualCloseNeeded).toBe(false);
		expect(removed.receipt.deletion).toEqual(removed.deletion);
		const restarted = new AIReqWorkflowStore(store.registryDirectory);
		const retained = await restarted.read(project.id);
		expect(retained.groups[0]).toEqual({
			...group,
			status: "deleted",
			revision: group.revision + 1,
			deletion: removed.deletion,
		});
		expect(retained.srs).toEqual(owned.state.srs);
		expect(retained.activeSrId).toBeUndefined();
		const view = await restarted.view(project.id);
		expect(view.groups).toEqual([]);
		expect(view.drafts).toEqual([]);
		expect(view.srs).toEqual([]);
		expect(view.materials).toEqual([]);
		expect(view.sessions).toEqual([]);
		expect(view.operations.find(operation => operation.operationId === command.operationId)?.deletion).toEqual(
			removed.deletion,
		);
		for (const [file, bytes] of files) expect(await fs.readFile(file)).toEqual(bytes);
		expect(await fs.readFile(historyPath)).toEqual(history);
		expect(await fs.readFile(path.join(worktree.path, "existing.txt"), "utf8")).toBe("keep staged user changes\n");
		expect(await fs.readFile(path.join(worktree.path, "untracked-code.ts"), "utf8")).toBe(
			"export const retained = true;\n",
		);
		expect(await checkout.statusPorcelain({})).toBe(beforeStatus);
		expect(await checkout.headSha()).toBe(beforeHead);
		expect(await repo.listBranches(false)).toEqual(beforeBranches);
		expect(await repo.worktrees()).toEqual(beforeWorktrees);
		const replay = await new AIReqWorkflowService(restarted, new AIReqWorkflowGit(), unavailable).command(command);
		expect(replay).toEqual(removed);
		expect(settlements).toBe(1);
		await expect(service.readMaterial(ref, group.documentPath)).rejects.toThrow();
		await expect(
			service.exportPackage(project.id, group.id, path.join(owned.directory, "deleted.zip")),
		).rejects.toThrow();
		let current = await store.read(project.id);
		const updated = await service.updateRequirements(ref, current.revision, "edit-deleted", content(group.id));
		expect(updated.status).toBe("failed");
		current = await store.read(project.id);
		const rebound = await service.bindSession(ref, current.revision, "bind-deleted", sessions[0]!.ref);
		expect(rebound.status).toBe("failed");
		current = await store.read(project.id);
		const output = await service.saveStageMaterials(
			{ ...ref, srId: "sr-one" },
			current.revision,
			"output-deleted",
			"solution",
			1,
			[],
		);
		expect(output.status).toBe("failed");
		const rejected: AIReqWorkflowCommand[] = [
			{ type: "startSr", operationId: "start-deleted", expectedRevision: 0, ...ref, srId: "sr-one" },
			{
				type: "publishMaterials",
				operationId: "publish-deleted",
				expectedRevision: 0,
				...ref,
				scope: "requirements",
				paths: group.files.map(file => file.path),
				message: "Cannot publish deleted requirements",
				push: false,
			},
			{
				type: "confirmRequirements",
				operationId: "confirm-deleted",
				expectedRevision: 0,
				...ref,
				snapshotDigest: group.snapshot!.digest,
			},
			{ type: "stop", operationId: "stop-deleted", expectedRevision: 0, ...ref },
		];
		for (const rejectedCommand of rejected) {
			rejectedCommand.expectedRevision = (await store.read(project.id)).revision;
			expect((await service.command(rejectedCommand)).status).toBe("failed");
		}
		expect((await store.read(project.id)).groups[0]).toEqual(retained.groups[0]);
		expect((await service.command(command)).receipt).toEqual(removed.receipt);
		expect(settlements).toBe(1);
	});
	test("settlement failure preserves original objects and failed receipt retries safely; stale or malformed deletion never settles", async () => {
		const owned = await localDraft();
		const { store, project, group } = owned;
		let fail = true;
		let settlements = 0;
		const stateFile = path.join(project.commonDir, "omp-aireq-workflow-v1", "state.json");
		const original = await fs.readFile(stateFile, "utf8");
		const branches = await owned.repo.listBranches(false);
		const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), {
			...owned.ports,
			settle: async (ref, reason) => {
				settlements++;
				if (fail) throw new Error("Owned recursive work failed to settle");
				await owned.ports.settle(ref, reason);
			},
		});
		const command = {
			type: "deleteRequirement" as const,
			version: 1 as const,
			operationId: "retry-removal",
			expectedRevision: owned.state.revision,
			projectId: project.id,
			irId: group.id,
		};
		for (const malformed of [
			{ ...command, version: undefined },
			{ ...command, version: 2 },
			{ ...command, srId: "sr-one" },
			{ ...command, projectId: undefined },
			{ ...command, irId: undefined },
		])
			await expect(service.command(malformed as unknown as AIReqWorkflowCommand)).rejects.toThrow();
		await expect(
			service.command({ ...command, operationId: "stale-removal", expectedRevision: command.expectedRevision - 1 }),
		).rejects.toThrow();
		expect(settlements).toBe(0);
		expect(await fs.readFile(stateFile, "utf8")).toBe(original);
		const failed = await service.command(command);
		expect(failed.status).toBe("failed");
		expect(failed.deletion).toBeUndefined();
		expect(failed.receipt.deletion).toBeUndefined();
		expect(failed.receipt.steps).toEqual([]);
		const unchanged = await new AIReqWorkflowStore(store.registryDirectory).read(project.id);
		expect(unchanged.groups).toEqual(owned.state.groups);
		expect(unchanged.srs).toEqual(owned.state.srs);
		expect(unchanged.activeSrId).toBe(owned.state.activeSrId);
		expect((await store.view(project.id)).drafts[0]?.id).toBe(group.id);
		expect(await owned.repo.listBranches(false)).toEqual(branches);
		fail = false;
		const completed = await service.command(command);
		expect(completed.status).toBe("completed");
		expect(settlements).toBe(2);
		const restarted = new AIReqWorkflowService(
			new AIReqWorkflowStore(store.registryDirectory),
			new AIReqWorkflowGit(),
			unavailable,
		);
		expect(await restarted.command(command)).toEqual(completed);
		await expect(restarted.command({ ...command, irId: "different-ir" })).rejects.toThrow();
		expect((await store.read(project.id)).groups[0]?.status).toBe("deleted");
	});
	test("a started SR blocks premerge record removal without freeing its development slot", async () => {
		const owned = await localDraft();
		const { store, project, group } = owned;
		const ref = { projectId: project.id, irId: group.id };
		await store.mutate(
			project.id,
			owned.state.revision,
			"started-sr-state",
			{ type: "native-started-boundary" },
			async ({ state }) => {
				const sr = state.srs[0]!;
				sr.worktree = group.worktree;
				sr.stage = "solution";
				sr.round = 1;
				sr.status = "developing";
				state.activeSrId = sr.id;
			},
		);
		const before = await store.read(project.id);
		let settlements = 0;
		const service = new AIReqWorkflowService(store, new AIReqWorkflowGit(), {
			...owned.ports,
			settle: async () => {
				settlements++;
				throw new Error("Forbidden states must not settle");
			},
		});
		const rejected = await service.command({
			type: "deleteRequirement",
			version: 1,
			operationId: "reject-started-removal",
			expectedRevision: before.revision,
			...ref,
		});
		expect(rejected.status).toBe("failed");
		expect(settlements).toBe(0);
		const after = await new AIReqWorkflowStore(store.registryDirectory).read(project.id);
		expect(after.groups).toEqual(before.groups);
		expect(after.srs).toEqual(before.srs);
		expect(after.activeSrId).toBe("sr-one");
		expect(after.groups[0]?.deletion).toBeUndefined();
		expect((await store.view(project.id)).activeSrId).toBe("sr-one");
	});
	test("persisted deletion cannot be revived or forged without its exact retained audit authority", async () => {
		const owned = await localDraft();
		const { store, project, group } = owned;
		await owned.service.command({
			type: "deleteRequirement",
			version: 1,
			operationId: "durable-removal",
			expectedRevision: owned.state.revision,
			projectId: project.id,
			irId: group.id,
		});
		const stateFile = path.join(project.commonDir, "omp-aireq-workflow-v1", "state.json");
		const saved = await fs.readFile(stateFile, "utf8");
		for (const mutate of [
			(state: AIReqProjectState) => {
				state.groups[0]!.status = "draft";
			},
			(state: AIReqProjectState) => {
				delete state.groups[0]!.deletion;
			},
			(state: AIReqProjectState) => {
				Object.assign(state.groups[0]!.deletion!, { platformClosed: true });
			},
			(state: AIReqProjectState) => {
				Object.assign(state.groups[0]!.deletion!, { version: 2 });
			},
			(state: AIReqProjectState) => {
				state.operations.find(operation => operation.type === "deleteRequirement")!.deletion!.manualCloseNeeded =
					true;
			},
			(state: AIReqProjectState) => {
				state.operations = state.operations.filter(operation => operation.type !== "deleteRequirement");
			},
		]) {
			const invalid = JSON.parse(saved) as AIReqProjectState;
			mutate(invalid);
			const bytes = JSON.stringify(invalid);
			await fs.writeFile(stateFile, bytes);
			await expect(new AIReqWorkflowStore(store.registryDirectory).read(project.id)).rejects.toThrow();
			expect(await fs.readFile(stateFile, "utf8")).toBe(bytes);
		}
		await fs.writeFile(stateFile, saved);
		expect((await new AIReqWorkflowStore(store.registryDirectory).view(project.id)).drafts).toEqual([]);
	});
	test("premerge imported requirement removal preserves provenance and records a real registered PR needing manual closure", async () => {
		const { directory, store, project, irId, manifest, decoded, service, state } = await importedFixture();
		const group = state.groups[0]!;
		const manifestPath = path.join(
			project.commonDir,
			"omp-aireq-workflow-v1",
			"packages",
			manifest.packageId,
			"manifest.json",
		);
		const manifestBytes = await fs.readFile(manifestPath);
		const published = await service.command({
			type: "publishMaterials",
			operationId: "publish-before-removal",
			expectedRevision: state.revision,
			projectId: project.id,
			irId,
			scope: "requirements",
			paths: [...group.files, ...group.evidenceFiles!].map(file => file.path),
			message: "Publish imported requirements for manual review",
			push: true,
		});
		expect(published.status).toBe("completed");
		let current = await store.read(project.id);
		const url = "https://company.example/requirements/removal-review";
		const submitted = await service.command({
			type: "markRequirementsPrSubmitted",
			operationId: "register-before-removal",
			expectedRevision: current.revision,
			projectId: project.id,
			irId,
			url,
		});
		expect(submitted.status).toBe("completed");
		current = await store.read(project.id);
		const before = current.groups[0]!;
		const checkout = vcs.requireGit(before.worktree!.path);
		const head = await checkout.headSha();
		const remote = vcs.requireGit(project.root);
		const branch = await remote.resolveRef(`refs/remotes/origin/${before.worktree!.branch}`);
		const removed = await service.command({
			type: "deleteRequirement",
			version: 1,
			operationId: "remove-manual-pr",
			expectedRevision: current.revision,
			projectId: project.id,
			irId,
		});
		expect(removed.status).toBe("completed");
		expect(removed.deletion?.manualCloseNeeded).toBe(true);
		expect(removed.deletion?.requirementsPrUrl).toBe(url);
		expect(removed.receipt.deletion).toEqual(removed.deletion);
		let retained = await new AIReqWorkflowStore(store.registryDirectory).read(project.id);
		expect(retained.groups[0]).toEqual({
			...before,
			status: "deleted",
			revision: before.revision + 1,
			deletion: removed.deletion,
		});
		expect(retained.groups[0]?.snapshot).toEqual(manifest.snapshot);
		expect(retained.groups[0]?.requirementsPr?.platformVerified).toBe(false);
		expect(await fs.readFile(manifestPath)).toEqual(manifestBytes);
		expect(await checkout.headSha()).toBe(head);
		expect(await remote.resolveRef(`refs/remotes/origin/${before.worktree!.branch}`)).toBe(branch);
		for (const file of manifest.files) {
			expect(await fs.readFile(path.join(before.worktree!.path, file.path))).toEqual(
				Buffer.from(decoded.files.get(file.path)!),
			);
			expect(
				await fs.readFile(
					path.join(
						project.commonDir,
						"omp-aireq-workflow-v1",
						"snapshots",
						irId,
						manifest.snapshot.digest,
						file.path,
					),
				),
			).toEqual(Buffer.from(decoded.files.get(file.path)!));
		}
		const duplicate = await service.importPackage(
			{
				type: "importPackage",
				operationId: "duplicate-after-removal",
				expectedRevision: retained.revision,
				projectId: project.id,
				releaseId: group.releaseId,
				packageId: manifest.packageId,
			},
			decoded,
		);
		expect(duplicate.status).toBe("failed");
		retained = await store.read(project.id);
		const renamedManifest = { ...manifest, packageId: "different-package-same-ir" };
		const renamed = await service.importPackage(
			{
				type: "importPackage",
				operationId: "same-ids-after-removal",
				expectedRevision: retained.revision,
				projectId: project.id,
				releaseId: group.releaseId,
				packageId: renamedManifest.packageId,
			},
			{ ...decoded, manifest: renamedManifest, digest: sha256(canonicalJson(renamedManifest)) },
		);
		expect(renamed.status).toBe("failed");
		expect((await store.read(project.id)).groups).toEqual(retained.groups);
		expect((await store.view(project.id)).groups).toEqual([]);
		expect(await fs.readFile(manifestPath)).toEqual(manifestBytes);
		await expect(
			service.exportPackage(project.id, irId, path.join(directory, "deleted-import.zip")),
		).rejects.toThrow();
	});
	test("cross-clone package source identity survives re-export and frozen PR facts cannot be downgraded", async () => {
		const { directory, repo, store, project, irId, unchangedContent, manifest, decoded, service } =
			await importedFixture();
		let state = await store.read(project.id);
		state = await store.read(project.id);
		let group = state.groups[0]!;
		expect(group.projectId).toBe(project.id);
		expect(group.snapshot?.projectId).toBe("source-project");
		expect(group.releaseId).not.toBe(manifest.releaseId);
		const reexportPath = path.join(directory, "reexport.zip");
		await service.exportPackage(project.id, irId, reexportPath);
		const reexported = await decodeRequirementPackage(reexportPath);
		expect(reexported.digest).toBe(decoded.digest);
		expect(reexported.manifest.sourceProjectId).toBe("source-project");
		expect(reexported.manifest.snapshot.projectId).toBe("source-project");
		expect(reexported.manifest.releaseId).toBe("source-release");
		const unchanged = await service.updateRequirements(
			{ projectId: project.id, irId },
			state.revision,
			"unchanged-import-content",
			unchangedContent,
		);
		expect(unchanged.status).toBe("completed");
		state = await store.read(project.id);
		group = state.groups[0]!;
		expect(group.status).toBe("confirmed");
		expect(group.snapshot?.projectId).toBe("source-project");
		const published = await service.command({
			type: "publishMaterials",
			operationId: "publish-requirements",
			expectedRevision: state.revision,
			projectId: project.id,
			irId,
			scope: "requirements",
			paths: [...group.files, ...group.evidenceFiles!].map(file => file.path),
			message: "Publish complete imported requirements and source review",
			push: true,
		});
		expect(published.status).toBe("completed");
		state = await store.read(project.id);
		const submitted = await service.command({
			type: "markRequirementsPrSubmitted",
			operationId: "register-manual-pr",
			expectedRevision: state.revision,
			projectId: project.id,
			irId,
			url: "https://company.example/requirements/1",
		});
		expect(submitted.status).toBe("completed");
		// A controlled native cherry-pick simulates content-preserving company rebase/squash delivery, not platform review.
		const committed = published.receipt.steps.find(step => step.name === "commit")!.detail;
		await repo.cherryPick(committed);
		state = await store.read(project.id);
		const merged = await service.command({
			type: "markRequirementsMerged",
			operationId: "register-real-git-merge",
			expectedRevision: state.revision,
			projectId: project.id,
			irId,
		});
		expect(merged.status).toBe("completed");
		state = await store.read(project.id);
		const frozen = state.groups[0]!;
		expect(frozen.status).toBe("frozen");
		const before = await fs.readFile(path.join(frozen.worktree!.path, frozen.documentPath));
		const downgrade = await service.command({
			type: "markRequirementsPrSubmitted",
			operationId: "reject-frozen-pr-downgrade",
			expectedRevision: state.revision,
			projectId: project.id,
			irId,
			url: "https://company.example/requirements/2",
		});
		expect(downgrade.status).toBe("failed");
		expect(downgrade.error).toContain("Frozen");
		const after = await store.read(project.id);
		expect(after.groups[0]!.status).toBe("frozen");
		expect(after.groups[0]!.merge).toEqual(frozen.merge);
		expect(after.groups[0]!.requirementsPr).toEqual(frozen.requirementsPr);
		expect((await fs.readFile(path.join(frozen.worktree!.path, frozen.documentPath))).equals(before)).toBe(true);
		const frozenRemoval = await service.command({
			type: "deleteRequirement",
			version: 1,
			operationId: "reject-frozen-removal",
			expectedRevision: after.revision,
			projectId: project.id,
			irId,
		});
		expect(frozenRemoval.status).toBe("failed");
		const preservedFrozen = await store.read(project.id);
		expect(preservedFrozen.groups).toEqual(after.groups);
		expect(preservedFrozen.srs).toEqual(after.srs);
		expect(preservedFrozen.activeSrId).toBe(after.activeSrId);
		const started = await service.command({
			type: "startSr",
			operationId: "real-sr-start-with-unavailable-native",
			expectedRevision: preservedFrozen.revision,
			projectId: project.id,
			irId,
			srId: "sr-one",
		});
		expect(started.status).toBe("failed");
		expect(started.error).toContain("Native session unavailable");
		let occupied = await store.read(project.id);
		expect(occupied.activeSrId).toBe("sr-one");
		expect(occupied.srs.find(sr => sr.id === "sr-one")?.worktree?.baseCommit).toBe(frozen.merge!.commit);
		expect(occupied.srs.find(sr => sr.id === "sr-two")?.status).toBe("pending");
		expect(occupied.groups[0]!.status).toBe("frozen");
		const beforeRemoval = occupied;
		const developingRemoval = await service.command({
			type: "deleteRequirement",
			version: 1,
			operationId: "reject-developing-removal",
			expectedRevision: occupied.revision,
			projectId: project.id,
			irId,
		});
		expect(developingRemoval.status).toBe("failed");
		occupied = await store.read(project.id);
		expect(occupied.groups).toEqual(beforeRemoval.groups);
		expect(occupied.srs).toEqual(beforeRemoval.srs);
		expect(occupied.activeSrId).toBe("sr-one");
		const blocked = await service.command({
			type: "startSr",
			operationId: "reject-second-sr",
			expectedRevision: occupied.revision,
			projectId: project.id,
			irId,
			srId: "sr-two",
		});
		expect(blocked.status).toBe("failed");
		expect(blocked.error).toContain("development slot");
		occupied = await store.read(project.id);
		const stopped = await service.command({
			type: "stop",
			operationId: "settle-idle-sr",
			expectedRevision: occupied.revision,
			projectId: project.id,
			irId,
			srId: "sr-one",
		});
		expect(stopped.status).toBe("completed");
		expect((await store.read(project.id)).activeSrId).toBe("sr-one");
	});
	test("formal content validation rejects missing SRs, duplicate members and private paths", () => {
		const valid = content("ir-one");
		expect(() => validateRequirementContent({ ...valid, srs: [] })).toThrow("at least one");
		expect(() => validateRequirementContent({ ...valid, srs: [valid.srs[0]!, valid.srs[0]!] })).toThrow(
			"Duplicate SR",
		);
		expect(() => safeMaterialPath("../escape.md")).toThrow();
		expect(() => safeMaterialPath("C:/server/secret.md")).toThrow();
		expect(() => safeMaterialPath("docs/.env")).toThrow();
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
	});
});
