import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildRequirementSnapshot,
	canonicalJson,
	encodeRequirementPackage,
	sha256,
} from "../../src/dev-workbench/requirement-package";
import type { DevPackageManifest, DevRequirementContent } from "../../src/dev-workbench/workflow-types";
import type { RawFileEntry } from "../../src/session/session-entries";
import { registeredFixtureProject } from "./fixture";
import { WorkflowConsumerFixture, pollWorkflow, workflowNativeContext } from "./workflow-fixture";

test("explicit imported premerge revision uses local native history and invalidates source approval without losing binary material", async () => {
	const irId = "external-revision-ir";
	const srId = "external-revision-sr";
	const prefix = `docs/dev/requirements/${irId}/`;
	const markdown =
		"# Greeting requirement\n\n## Scope\nReturn a greeting for the supplied name.\n\n## Rules\nPreserve the supplied name.\n\n## Scenarios\nA named caller receives a greeting.\n\n## Acceptance\nThe result contains the complete supplied name.\n";
	const original: DevRequirementContent = {
		title: "Preserve greeting names",
		document: { path: `${prefix}ir.md`, content: markdown },
		srs: [{ id: srId, title: "Greeting name preservation", document: { path: `${prefix}sr.md`, content: markdown } }],
		attachments: [{ path: `${prefix}source.bin`, content: new Uint8Array([0, 255, 1, 128]) }],
	};
	original.attachments.push({
		path: `${prefix}requirements.json`,
		content: canonicalJson({
			version: 1,
			irId,
			title: original.title,
			documentPath: original.document.path,
			srs: original.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		}),
	});
	const revision =
		"\n## Requested business revision\nTrim outer whitespace while preserving internal spaces. Empty input means world.\n";
	const revised: DevRequirementContent = {
		title: original.title,
		document: { ...original.document, content: markdown + revision },
		srs: original.srs.map(sr => ({ ...sr, document: { ...sr.document, content: markdown + revision } })),
		attachments: [],
	};
	let written = false;
	let context: Record<string, unknown> | undefined;
	await using fixture = await WorkflowConsumerFixture.create({
		reply: request => {
			context = workflowNativeContext(request);
			if (!context || context.role !== "requirements")
				throw new Error("Only the explicit local requirements actor may call the test provider");
			if (written)
				return {
					text: "The complete requested revision is written; human confirmation and independent review remain pending.",
				};
			written = true;
			const outputs = context.outputPaths as string[];
			return { tool: { name: "write", args: { path: outputs[0], content: JSON.stringify(revised) } } };
		},
	});
	const browser = await fixture.start();
	let view = await browser.view();
	const project = await registeredFixtureProject(view.projects, fixture.project);
	const release = await browser.command({
		type: "createRelease",
		projectId: project.id,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
		title: "Imported review revision",
	});
	expect(release.response.ok).toBe(true);
	expect(release.result.status).toBe("completed");
	view = await browser.view(project.id);
	const releaseId = view.releases[0]!.id;
	const snapshot = buildRequirementSnapshot("external-source-project", irId, original);
	const createdAt = new Date().toISOString();
	// External ZIP review provenance is input data, not a local reviewer or recovered chat.
	const manifest: DevPackageManifest = {
		format: "omp-dev-requirements",
		version: 1,
		packageId: "external-revision-package",
		sourceProjectId: "external-source-project",
		repositoryId: project.repositoryId,
		irId,
		releaseId: "external-source-release",
		createdAt,
		snapshot,
		files: snapshot.files,
		confirmation: { operationId: "external-confirmation", snapshotDigest: snapshot.digest, confirmedAt: createdAt },
		review: {
			id: "external-review",
			snapshotDigest: snapshot.digest,
			passed: true,
			report: "External source review provenance.",
			reviewer: { sessionId: "external-reviewer-history", role: "reviewer" },
			createdAt,
		},
	};
	const encoder = new TextEncoder();
	const files = new Map(
		[original.document, ...original.srs.map(sr => sr.document), ...original.attachments].map(file => [
			file.path,
			typeof file.content === "string" ? encoder.encode(file.content) : file.content,
		]),
	);
	const sourceZip = path.join(fixture.root, "external-original.zip");
	await encodeRequirementPackage(sourceZip, manifest, files);
	const zip = await fs.readFile(sourceZip);
	const upload = await browser.request(`workflow/packages?projectId=${encodeURIComponent(project.id)}`, {
		method: "POST",
		headers: { "content-type": "application/zip" },
		body: zip,
	});
	expect(upload.ok).toBe(true);
	const uploaded = (await upload.json()) as { packageId: string };
	const imported = await browser.command({
		type: "importPackage",
		projectId: project.id,
		expectedRevision: view.revision,
		operationId: crypto.randomUUID(),
		releaseId,
		packageId: uploaded.packageId,
	});
	expect(imported.response.ok).toBe(true);
	expect(imported.result.status).toBe("completed");
	await browser.bind(project.id, irId);
	view = await browser.view(project.id);
	const before = view.groups.find(group => group.id === irId)!;
	expect(before.status).toBe("confirmed");
	expect(before.sessions).toEqual([]);
	expect(fixture.provider.requests).toHaveLength(0);
	expect(before.snapshot).toEqual(snapshot);
	expect(before.confirmation).toEqual(manifest.confirmation);
	expect(before.review).toMatchObject({
		...manifest.review,
		reviewer: { ...manifest.review.reviewer, sourceProjectId: manifest.sourceProjectId, imported: true },
	});
	expect(before.files).toEqual(manifest.files);
	expect(await fs.readFile(path.join(before.worktree!.path, `${prefix}source.bin`))).toEqual(
		Buffer.from([0, 255, 1, 128]),
	);
	expect(await fs.readFile(sourceZip)).toEqual(zip);
	const input = await browser.request("workflow/input", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId: project.id,
			irId,
			expectedRevision: view.revision,
			operationId: crypto.randomUUID(),
			text: "The manual requirements PR requests a business revision: trim outer whitespace, preserve internal spaces, and use world for empty input. Update the complete current IR and all SRs; do not approve or review automatically.",
		}),
	});
	expect(input.ok, `HTTP ${input.status}: ${await input.text()}`).toBe(true);
	view = await pollWorkflow(
		() => browser.view(project.id),
		current =>
			!![...current.groups, ...current.drafts].find(
				group => group.id === irId && group.status === "draft" && group.snapshot?.digest !== snapshot.digest,
			),
		"Imported native revision ingestion",
	);
	const after = [...view.groups, ...view.drafts].find(group => group.id === irId)!;
	expect(after.origin).toBe("import");
	expect(after.packageId).toBe(manifest.packageId);
	expect(after.packageDigest).toBe(sha256(canonicalJson(manifest)));
	expect(after.confirmation).toBeUndefined();
	expect(after.review).toBeUndefined();
	expect(after.revision).toBeGreaterThan(before.revision);
	expect(after.snapshot?.projectId).toBe(project.id);
	for (const document of [revised.document, ...revised.srs.map(sr => sr.document)])
		expect(await fs.readFile(path.join(after.worktree!.path, document.path), "utf8")).toBe(document.content);
	for (const version of after.files) {
		const bytes = await fs.readFile(path.join(after.worktree!.path, version.path));
		expect({ size: bytes.byteLength, sha256: sha256(bytes) }).toEqual({
			size: version.size,
			sha256: version.sha256,
		});
	}
	expect(after.sessions).toHaveLength(1);
	const native = after.sessions[0]!;
	expect(native).toMatchObject({ projectId: project.id, irId, role: "requirements", phase: "requirements", round: 0 });
	expect(native.sessionId).not.toBe(manifest.review.reviewer.sessionId);
	const journal = (await fs.readFile(native.sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as RawFileEntry);
	const header = journal.find(entry => entry.type === "session");
	expect(header).toMatchObject({ type: "session", id: native.sessionId, cwd: after.worktree!.path });
	expect(header?.parentSession).not.toBe(manifest.review.reviewer.sessionId);
	const binding = journal.find(entry => entry.type === "custom" && entry.customType === "dev-workflow-binding");
	if (binding?.type !== "custom") throw new Error("Fresh native history lacks its exact workflow binding");
	expect(binding.data).toEqual({
		projectId: project.id,
		irId,
		phase: "requirements",
		round: 0,
	});
	const supplied = context!.contextFiles as { path: string; content: string }[];
	expect(supplied).toContainEqual(original.document);
	expect(supplied).toContainEqual(original.srs[0]!.document);
	expect(await fs.readFile(path.join(after.worktree!.path, `${prefix}source.bin`))).toEqual(
		Buffer.from([0, 255, 1, 128]),
	);
	expect(await fs.readFile(sourceZip)).toEqual(zip);
	const unavailable = await browser.request(
		`workflow/package?projectId=${encodeURIComponent(project.id)}&irId=${irId}`,
	);
	expect(unavailable.ok).toBe(false);
}, 120_000);
