import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import type { LoadContext } from "../../src/capability/types";
import archiveMetadata from "../../src/extensibility/plugins/developer-test-agent-archive";
import { getDeveloperTestAgentRoot } from "../../src/extensibility/plugins/developer-test-agent-resources";
import type { Skill } from "../../src/extensibility/skills";
import { metadata } from "./developer-test-agent-materialization-preload";

const [scenario, directory, sourceRoot] = process.argv.slice(2);
assert.ok(scenario && directory && sourceRoot, "scenario, temporary directory and source tree are required");
const archivePath = path.join(directory, "resources.json.gz");
// The child preload supplies an object export, never a callable metadata spy.
// The resource loader and its metadata are already loaded; the scenarios need no further hook.
Bun.plugin.clearAll();
assert.equal(archiveMetadata, metadata, "the archive export retains the metadata object identity");

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function setArchive(bytes?: Buffer): Promise<void> {
	if (bytes) await fs.writeFile(archivePath, bytes);
	metadata.digest = createHash("sha256")
		.update((await fs.readFile(archivePath)).toString("base64"))
		.digest("hex");
}

function cacheParent(profile: string): string {
	return path.join(profile, "developer-test-agent", "resources");
}

async function assertPublished(profile: string): Promise<void> {
	assert.deepEqual(
		await fs.readdir(cacheParent(profile)),
		[metadata.digest],
		"no temporary extraction directory remains",
	);
}

async function assertUnpublished(profile: string): Promise<void> {
	const parent = cacheParent(profile);
	if (await exists(parent))
		assert.deepEqual(await fs.readdir(parent), [], "no partial cache or staging directory remains");
}

async function tree(root: string, prefix = ""): Promise<string[]> {
	const names: string[] = [];
	for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		// Directory suffixes let the tree comparison check entry kinds without stat calls.
		if (entry.isDirectory()) names.push(`${name}/`, ...(await tree(root, name)));
		else names.push(name);
	}
	return names.sort();
}

const profile = path.join(directory, "profile-a");
if (scenario === "consumers") {
	await setArchive();
	const root = await getDeveloperTestAgentRoot(profile);
	assert.equal(root, await fs.realpath(path.join(cacheParent(profile), metadata.digest, "developer-test-agent")));
	assert.notEqual(root, sourceRoot, "the archive branch, not the source fallback, must execute");
	const sourceEntries = await tree(sourceRoot);
	assert.deepEqual(
		await tree(root),
		[
			...sourceEntries,
			"materialization-fixture/",
			"materialization-fixture/empty/",
			"materialization-fixture/binary",
		].sort(),
	);
	for (const name of sourceEntries) {
		if (name.endsWith("/")) continue;
		const source = path.join(sourceRoot, name);
		const target = path.join(root, name);
		const [actual, expected] = await Promise.all([fs.readFile(target), fs.readFile(source)]);
		assert.deepEqual(actual, expected, name);
		if (process.platform !== "win32") {
			const [actual, expected] = await Promise.all([fs.stat(target), fs.stat(source)]);
			assert.equal(actual.mode & 0o777, expected.mode & 0o777, name);
		}
	}
	assert.deepEqual(await fs.readdir(path.join(root, "materialization-fixture", "empty")), []);
	assert.deepEqual(
		await fs.readFile(path.join(root, "materialization-fixture", "binary")),
		Buffer.from([0, 1, 2, 0, 128, 255]),
	);
	if (process.platform !== "win32")
		assert.equal((await fs.stat(path.join(root, "materialization-fixture", "binary"))).mode & 0o777, 0o640);

	const [
		{ loadDeveloperTestCommands, loadDeveloperTestSkills },
		{ expandSlashCommand },
		{ parseInternalUrl },
		{ SkillProtocolHandler },
	] = await Promise.all([
		import("../../src/discovery/developer-test-agent"),
		import("../../src/extensibility/slash-commands"),
		import("../../src/internal-urls/parse"),
		import("../../src/internal-urls/skill-protocol"),
	]);
	const ctx: LoadContext = { cwd: process.cwd(), home: directory, repoRoot: null, agentDir: profile };
	const commands = await loadDeveloperTestCommands(ctx);
	assert.deepEqual(commands.items.map(command => command.name).sort(), [
		"cloud-dt-fix",
		"dt",
		"generate-dt-dir",
		"generate-dt-files",
		"incremental-dt",
	]);
	const request = "src/service.py\n保留 <T>、{{literal}} 和 $&";
	for (const command of commands.items) {
		assert.equal(path.dirname(command.path), path.join(root, "commands"));
		const expanded = expandSlashCommand(`/${command.name} ${request}`, [
			{
				name: command.name,
				content: command.content,
				description: "DT",
				source: "bundled",
			},
		]);
		assert.ok(expanded.includes(request), `${command.name} preserves the raw user request`);
		assert.ok(!expanded.includes("{{{rawArguments}}}"), `${command.name} renders invocation arguments`);
	}
	const cloud = commands.items.find(command => command.name === "cloud-dt-fix");
	assert.ok(cloud);
	assert.ok(
		cloud.content.includes(`${root.replaceAll("\\", "/")}/skills/fix-ut/references/java/codecovcli-check.md`),
		"command resource links use the materialized plugin root",
	);
	const discovered = await loadDeveloperTestSkills(ctx);
	assert.deepEqual(discovered.items.map(skill => skill.name).sort(), [
		"fix-ut",
		"generate-ut",
		"improve-coverage",
		"improve-validity",
		"test-report",
	]);
	const skills: Skill[] = discovered.items.map(skill => {
		assert.equal(skill.containRoot, root);
		assert.equal(path.dirname(path.dirname(skill.path)), path.join(root, "skills"));
		return {
			name: skill.name,
			description: "",
			filePath: skill.path,
			baseDir: path.dirname(skill.path),
			source: "developer-test-agent:project",
			containRoot: skill.containRoot,
		};
	});
	const handler = new SkillProtocolHandler();
	for (const skill of skills) {
		const resource = await handler.resolve(parseInternalUrl(`skill://${skill.name}`), { skills });
		assert.equal(resource.sourcePath, skill.filePath);
		assert.equal(resource.content, await fs.readFile(skill.filePath, "utf8"));
	}
	for (const relative of [
		"references/java/generation-rules.md",
		"references/cpp/generation-rules.md",
		"references/go/generation-rules.md",
		"references/python/generation-rules.md",
		"scripts/java/decompile.js",
		"examples/cpp/test_example.cpp",
	]) {
		const resource = await handler.resolve(parseInternalUrl(`skill://generate-ut/${relative}`), { skills });
		assert.equal(resource.sourcePath, path.join(root, "skills", "generate-ut", ...relative.split("/")));
		assert.equal(
			resource.content,
			await fs.readFile(path.join(sourceRoot, "skills", "generate-ut", ...relative.split("/")), "utf8"),
		);
	}
	const jar = await fs.readFile(path.join(root, "skills", "generate-ut", "assets", "java", "cfr-0.152.jar"));
	assert.deepEqual(jar.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	await assert.rejects(
		handler.resolve(parseInternalUrl("skill://generate-ut/../../../../secret.txt"), { skills }),
		/traversal/i,
	);
	assert.deepEqual(await fs.readdir(process.cwd()), [], "the current project is not a materialization target");
	await assertPublished(profile);
} else if (scenario === "cache") {
	await setArchive();
	const sibling = path.join(directory, "profile-b");
	const roots = await Promise.all(Array.from({ length: 4 }, () => getDeveloperTestAgentRoot(profile)));
	assert.equal(new Set(roots).size, 1, "concurrent callers receive one published path");
	const first = roots[0];
	const second = await getDeveloperTestAgentRoot(sibling);
	assert.notEqual(first, second);
	const command = path.join("commands", "dt.md");
	assert.deepEqual(await fs.readFile(path.join(first, command)), await fs.readFile(path.join(second, command)));
	await fs.writeFile(path.join(first, "profile-only.txt"), "profile-a");
	assert.equal(await exists(path.join(second, "profile-only.txt")), false);
	await fs.rm(archivePath);
	assert.equal(await getDeveloperTestAgentRoot(profile), first, "a published cache does not reread a missing archive");
	assert.equal(await getDeveloperTestAgentRoot(sibling), second);
	assert.equal(await fs.readFile(path.join(first, "profile-only.txt"), "utf8"), "profile-a");
	await assertPublished(profile);
	await assertPublished(sibling);
	const uncached = path.join(directory, "profile-c");
	await assert.rejects(getDeveloperTestAgentRoot(uncached), { code: "ENOENT" });
	assert.equal(await exists(uncached), false);
	assert.deepEqual(await fs.readdir(process.cwd()), []);
} else if (scenario === "invalid-paths") {
	const sentinel = path.join(directory, "sentinel.txt");
	await fs.writeFile(sentinel, "untouched");
	for (const name of ["../escape", "/absolute", "C:/escape", "safe\\escape", "safe/./escape"]) {
		const data = { data: Buffer.from("must-not-escape").toString("base64"), mode: 0o644 };
		await setArchive(
			gzipSync(
				JSON.stringify([
					["written-before-rejection", data],
					[name, data],
				]),
			),
		);
		await assert.rejects(getDeveloperTestAgentRoot(profile), {
			message: `Invalid embedded developer-test-agent resource path: ${name}`,
		});
		await assertUnpublished(profile);
		assert.equal(await fs.readFile(sentinel, "utf8"), "untouched");
	}
	assert.deepEqual((await fs.readdir(directory)).sort(), [
		"profile-a",
		"resources.json.gz",
		"sentinel.txt",
		"unrelated-project",
	]);
	assert.deepEqual(await fs.readdir(process.cwd()), []);
} else if (scenario === "write-failure") {
	await setArchive();
	await assert.rejects(
		getDeveloperTestAgentRoot(profile),
		error => error instanceof Error && error.message.includes("occupied"),
	);
	await assertUnpublished(profile);
} else {
	throw new Error(`Unknown materialization scenario: ${scenario}`);
}
process.stdout.write(JSON.stringify({ scenario, assertionsCompleted: true }));
