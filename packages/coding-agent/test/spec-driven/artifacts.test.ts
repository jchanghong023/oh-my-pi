import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import {
	buildRequirementSnapshot,
	canonicalJson,
	decodeRequirementPackage,
	encodeRequirementPackage,
	safeMaterialPath,
	sha256,
	validateRequirementContent,
} from "../../src/aireq-workbench/requirement-package";
import { assertSnapshotFiles } from "../../src/aireq-workbench/workflow-git";
import type { AIReqPackageManifest, AIReqRequirementContent } from "../../src/aireq-workbench/workflow-types";

function content(): AIReqRequirementContent {
	const markdown = (title: string) =>
		`# ${title}\n\n## Scenarios\nReturn the complete customer request Ω, preserving internal whitespace.\n\n## Rules and boundaries\nTrim outer whitespace, use world for empty names, do not alter unrelated behavior.\n\n## Acceptance\nBoth the CLI and API preserve internal whitespace; UT and ST remain separate evidence.\n`;
	return {
		title: "Greeting behavior",
		document: { path: "docs/aireq/requirements/ir-a/ir.md", content: markdown("Greeting behavior") },
		srs: [
			{
				id: "sr-a",
				title: "Greeting API",
				document: { path: "docs/aireq/requirements/ir-a/srs/sr-a.md", content: markdown("Greeting API") },
			},
		],
		attachments: [
			{ path: "docs/aireq/requirements/ir-a/context/design.bin", content: new Uint8Array([0, 255, 10, 128]) },
		],
	};
}
function bundle() {
	const requirement = content();
	requirement.attachments.push({
		path: "docs/aireq/requirements/ir-a/requirements.json",
		content: canonicalJson({
			version: 1,
			irId: "ir-a",
			title: requirement.title,
			documentPath: requirement.document.path,
			srs: requirement.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		}),
	});
	const snapshot = buildRequirementSnapshot("project-a", "ir-a", requirement);
	const files = new Map(
		[requirement.document, ...requirement.srs.map(sr => sr.document), ...requirement.attachments].map(document => [
			document.path,
			typeof document.content === "string" ? new TextEncoder().encode(document.content) : document.content,
		]),
	);
	const manifest: AIReqPackageManifest = {
		format: "omp-aireq-requirements",
		version: 1,
		packageId: "package-a",
		sourceProjectId: "project-a",
		repositoryId: "https://company.example/project",
		irId: "ir-a",
		releaseId: "release-a",
		createdAt: new Date().toISOString(),
		snapshot,
		confirmation: {
			operationId: "human-confirmation",
			snapshotDigest: snapshot.digest,
			confirmedAt: new Date().toISOString(),
		},
		review: {
			id: "review-a",
			snapshotDigest: snapshot.digest,
			passed: true,
			report: "Independent review of all complete IR and SR bytes passed.",
			reviewer: { sessionId: "independent-native-review", role: "reviewer" },
			createdAt: new Date().toISOString(),
		},
		files: snapshot.files,
	};
	return { requirement, snapshot, files, manifest };
}

test("formal requirement package round-trips every byte and stable identity without native history copies", async () => {
	await using root = await TempDir.create("@omp-aireq-package-");
	const { files, manifest } = bundle();
	const target = root.join("requirements.zip");
	await encodeRequirementPackage(target, manifest, files);
	const decoded = await decodeRequirementPackage(target);
	expect(decoded.manifest).toEqual(manifest);
	for (const [name, bytes] of files) expect(decoded.files.get(name)).toEqual(bytes);
	expect(decoded.files.size).toBe(files.size);
	expect(decoded.manifest.review.reviewer).toEqual({ sessionId: "independent-native-review", role: "reviewer" });
});

for (const invalid of ["missing", "malformed", "unknown"] as const) {
	test(`complete IR and all SR validation rejects ${invalid} material without changing input`, () => {
		const requirement = content();
		const before = structuredClone(requirement);
		if (invalid === "missing") requirement.srs = [];
		if (invalid === "malformed") requirement.srs[0]!.document.content = "# Incomplete\n";
		if (invalid === "unknown") Object.assign(requirement.srs[0]!, { approved: true });
		const submitted = structuredClone(requirement);
		expect(() => validateRequirementContent(requirement)).toThrow();
		expect(requirement).toEqual(submitted);
		expect(before.srs[0]!.document.content).toContain("complete customer request Ω");
	});
}

test("snapshot versions bind titles, full nested member bytes and every SR membership", () => {
	const { requirement, snapshot } = bundle();
	for (const mutate of [
		(value: AIReqRequirementContent) => {
			value.title += " changed";
		},
		(value: AIReqRequirementContent) => {
			value.srs[0]!.document.content += "\nChanged Ω original bytes.\n";
		},
		(value: AIReqRequirementContent) => {
			value.attachments.push({
				path: "docs/aireq/requirements/ir-a/context/nested/extra.md",
				content: "New original context\n",
			});
		},
		(value: AIReqRequirementContent) => {
			value.srs.push({
				...value.srs[0]!,
				id: "sr-b",
				document: { ...value.srs[0]!.document, path: "docs/aireq/requirements/ir-a/srs/sr-b.md" },
			});
		},
	]) {
		const changed = structuredClone(requirement);
		mutate(changed);
		expect(buildRequirementSnapshot("project-a", "ir-a", changed).digest).not.toBe(snapshot.digest);
	}
});

test("unknown versions, missing members, corruption and stale human/review versions are rejected by actual ZIP decoding", async () => {
	await using root = await TempDir.create("@omp-aireq-package-negative-");
	const { files, manifest } = bundle();
	for (const kind of ["version", "missing", "corrupt", "unknown", "confirmation", "review"] as const) {
		const submitted = structuredClone(manifest);
		const bytes = new Map(files);
		if (kind === "version") Object.assign(submitted, { version: 900 });
		if (kind === "missing") bytes.delete(manifest.snapshot.documentPath);
		if (kind === "corrupt") bytes.set(manifest.snapshot.documentPath, new TextEncoder().encode("changed bytes"));
		if (kind === "unknown") Object.assign(submitted, { chat: [{ role: "user", content: "private native history" }] });
		if (kind === "confirmation") submitted.confirmation.snapshotDigest = sha256("stale version");
		if (kind === "review") submitted.review.snapshotDigest = sha256("another review snapshot");
		const target = root.join(`${kind}.zip`);
		await writeArchive(target, "zip", [["manifest.json", JSON.stringify(submitted)], ...bytes.entries()]);
		await expect(decodeRequirementPackage(target)).rejects.toThrow();
	}
});

test("runtime, credential and unsafe filesystem paths cannot become formal package authority", () => {
	for (const name of [
		"../escape.md",
		"C:/absolute.md",
		"docs/a.md:1",
		"docs/CON.md",
		"docs/.git/config",
		"docs/session.jsonl",
		"docs/.env",
		"docs/transcript.txt",
		"docs/credentials.json",
	])
		expect(() => safeMaterialPath(name)).toThrow();
	for (const mutate of [
		(value: AIReqRequirementContent) => {
			Object.assign(value, { sessionFile: "C:/private/native.jsonl" });
		},
		(value: AIReqRequirementContent) => {
			value.document.content += "\napi_key=private-secret-value\n";
		},
		(value: AIReqRequirementContent) => {
			value.srs[0]!.document.path = value.document.path.toUpperCase();
		},
	]) {
		const requirement = content();
		mutate(requirement);
		expect(() => validateRequirementContent(requirement)).toThrow();
	}
});

test("whole frozen set detects nested additions, missing files and changed bytes without deleting any material", async () => {
	await using root = await TempDir.create("@omp-aireq-frozen-set-");
	const { files, snapshot } = bundle();
	for (const [file, bytes] of files) {
		await fs.mkdir(path.dirname(root.join(file)), { recursive: true });
		await fs.writeFile(root.join(file), bytes);
	}
	await assertSnapshotFiles(root.path(), snapshot);
	const nested = "docs/aireq/requirements/ir-a/srs/nested/new-sr.md";
	await fs.mkdir(path.dirname(root.join(nested)), { recursive: true });
	await fs.writeFile(root.join(nested), "unapproved nested member\n");
	await expect(assertSnapshotFiles(root.path(), snapshot)).rejects.toThrow();
	expect(await fs.readFile(root.join(nested), "utf8")).toBe("unapproved nested member\n");
	await fs.unlink(root.join(nested));
	const target = snapshot.documentPath;
	await fs.writeFile(root.join(target), "changed frozen IR\n");
	await expect(assertSnapshotFiles(root.path(), snapshot)).rejects.toThrow();
	await fs.unlink(root.join(target));
	await expect(assertSnapshotFiles(root.path(), snapshot)).rejects.toThrow();
});
