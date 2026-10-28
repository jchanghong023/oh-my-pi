import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Path consumers (search/grep, the bash shell filesystem) only need the artifact's
 * filesystem path. Blocking them for large artifacts would break `search`
 * against MCP results and `bash` commands that reference the file — the very
 * workflows the read-tool guidance points users toward.
 */
describe("artifact:// locate vs content resolution", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;
	const handler = new ArtifactProtocolHandler();

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-path-only-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		// 9 MiB — larger than the 8 MiB inline cap so `resolve` refuses to
		// materialize while `locate` still returns the backing file.
		const bytes = Buffer.alloc(9 * 1024 * 1024, 65);
		await Bun.write(path.join(artifactDir, "0.mcp.log"), bytes);
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("still rejects full content resolution for large artifacts (existing OOM guard)", async () => {
		const url = parseInternalUrl("artifact://0");
		await expect(handler.resolve(url)).rejects.toThrow(/full internal resolution is blocked/);
	});

	it("materializes small artifacts on ordinary resolution", async () => {
		const smallArtifactDir = path.join(testDir, "small-session");
		await fs.mkdir(smallArtifactDir, { recursive: true });
		await Bun.write(path.join(smallArtifactDir, "9.mcp.log"), "hello world\n");
		const unregisterSmall = registerArtifactsDir(smallArtifactDir);
		try {
			const url = parseInternalUrl("artifact://9");
			const resource = await handler.resolve(url);
			expect(resource.content).toBe("hello world\n");
			expect(resource.sourcePath).toBe(path.join(smallArtifactDir, "9.mcp.log"));
		} finally {
			unregisterSmall();
		}
	});
});

describe("resolveToolSearchScope locates large artifacts", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-scope-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		const bytes = Buffer.alloc(9 * 1024 * 1024, 65);
		await Bun.write(path.join(artifactDir, "0.mcp.log"), bytes);
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("resolves ast_grep/ast_edit search scope for large artifacts without the inline-content cap", async () => {
		// The URL stays the search root; its stat must reach the backing file, not
		// InternalUrlRouter's capped content resolution.
		const scope = await resolveToolSearchScope({
			rawPaths: ["artifact://0"],
			cwd: testDir,
			internalUrlAction: "search",
			filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
		});
		expect(scope.searchPath).toBe("artifact://0");
		expect(scope.isDirectory).toBe(false);
	});
});

describe("artifact:// attachment discovery", () => {
	let root: string;
	let runtimeRoot: string;
	let external: string;
	const handler = new ArtifactProtocolHandler();
	const url = parseInternalUrl("artifact://0");

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-protocol-boundary-")));
		runtimeRoot = path.join(root, "runtime");
		external = path.join(root, "external");
		await fs.mkdir(runtimeRoot);
		await fs.mkdir(external);
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(async () => {
		resetRegisteredArtifactDirsForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("locates, resolves and completes real runtime attachments including seance sources", async () => {
		const source = path.join(runtimeRoot, "source");
		const own = path.join(runtimeRoot, "own");
		await fs.mkdir(source);
		await fs.mkdir(own);
		const artifact = path.join(source, "0.bash.log");
		await fs.writeFile(artifact, "runtime attachment");
		registerArtifactsDir(source);
		expect(await handler.locate(url)).toBe(artifact);
		expect((await handler.resolve(url)).content).toBe("runtime attachment");
		expect(await handler.complete()).toEqual([{ value: "0" }]);
		const context: ResolveContext = {
			localProtocolOptions: { getArtifactsDir: () => own },
			session: { seanceSourceArtifactsDir: source } as ResolveContext["session"],
		};
		expect(await handler.locate(url, context)).toBe(artifact);
		expect((await handler.resolve(url, context)).content).toBe("runtime attachment");
	});

	it("keeps ordinary-mode external directory links readable", async () => {
		await fs.writeFile(path.join(external, "0.bash.log"), "ordinary attachment");
		const linked = path.join(runtimeRoot, "linked");
		await fs.symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
		registerArtifactsDir(linked);
		expect(await handler.locate(url)).toBe(path.join(linked, "0.bash.log"));
		expect((await handler.resolve(url)).content).toBe("ordinary attachment");
		expect(await handler.complete()).toEqual([{ value: "0" }]);
	});
});
