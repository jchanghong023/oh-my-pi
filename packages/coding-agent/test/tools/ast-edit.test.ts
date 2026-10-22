import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RepoService } from "@oh-my-pi/pi-coding-agent/repo/service";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { subscribeFsMutation } from "@oh-my-pi/pi-coding-agent/tools/fs-cache-invalidation";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { withTlaplusGrammar } from "../helpers/tlaplus-grammar";

type InvokedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// xdev mounting (default-on) would unmount the discoverable ast_edit
		// into xd://; these tests need it in the returned toolset.
		settings: Settings.isolated({ "tools.xdev": false }),
		...overrides,
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object schema");
	}
	return value as Record<string, unknown>;
}

describe("ast_edit tool schema", () => {
	it("uses op entries as [{ pat, out }]", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);
		const properties = asSchemaObject(schema.properties);
		const ops = asSchemaObject(properties.ops);

		expect(ops.type).toBe("array");
		const items = asSchemaObject(ops.items);
		expect(items.type).toBe("object");
		expect(items.required).toEqual(["pat", "out"]);
		const itemProperties = asSchemaObject(items.properties);
		expect(asSchemaObject(itemProperties.pat).type).toBe("string");
		expect(asSchemaObject(itemProperties.out).type).toBe("string");
		expect(properties.preview).toBeUndefined();
	});

	it("remains strict-representable after strict adaptation", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);

		const strict = adaptSchemaForStrict(schema, true);
		expect(strict.strict).toBe(true);
	});

	it("renders +/- lines with numbered hashline prefixes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-render-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");

			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-test", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const lines = text.split("\n");
			const removedLine = lines.find(line => line.startsWith("-"));
			const addedLine = lines.find(line => line.startsWith("+"));

			expect(removedLine).toBeDefined();
			expect(addedLine).toBeDefined();
			expect(removedLine).toMatch(/^-\d+:/);
			expect(addedLine).toMatch(/^\+\d+:/);
			expect(removedLine?.split(":", 1)[0].length).toBe(addedLine?.split(":", 1)[0].length);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it.each(["single file", "directory", "multiple files"])(
		"notifies committed AST edits for %s targets",
		async scope => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-pending-"));
			const notifications: string[] = [];
			const unsubscribe = subscribeFsMutation(paths => {
				notifications.push(
					...paths
						.map(filePath => path.resolve(filePath))
						.filter(filePath => filePath.startsWith(`${path.resolve(tempDir)}${path.sep}`)),
				);
			});
			try {
				const filePath = path.join(tempDir, "legacy.ts");
				await Bun.write(filePath, "legacyWrap(x, value)\n");
				const filePaths = [filePath];
				if (scope === "multiple files") {
					const secondPath = path.join(tempDir, "other.ts");
					await Bun.write(secondPath, "legacyWrap(other, value)\n");
					filePaths.push(secondPath);
				}
				const queue = new ToolChoiceQueue();

				const tools = await createTools(
					createTestSession(tempDir, {
						getToolChoiceQueue: () => queue,
						buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
						steer: () => {},
					}),
					["ast_edit"],
				);
				const tool = tools.find(entry => entry.name === "ast_edit");
				expect(tool).toBeDefined();

				const previewResult = await tool!.execute("ast-edit-preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: scope === "directory" ? [tempDir] : filePaths,
				});
				expect(previewResult.details).toBeDefined();
				expect((previewResult.details as { applied?: boolean }).applied).toBe(false);
				expect(notifications).toEqual([]);

				expect(queue.hasPendingInvoker).toBe(true);
				const invoker = queue.peekPendingInvoker()!;
				const applyResult = (await invoker({
					action: "apply",
					reason: "apply previewed AST edit",
				})) as InvokedToolResult;
				const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";
				expect(applyResult.isError).toBeUndefined();
				expect(applyText).toContain(
					filePaths.length === 1 ? "Applied 1 replacement in 1 file." : "Applied 2 replacements in 2 files.",
				);
				expect(
					(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
						?.sourceResultDetails?.totalReplacements,
				).toBe(filePaths.length);
				const updated = await Bun.file(filePath).text();
				expect(updated).toContain("modernWrap(x, value)");
				expect(notifications.sort()).toEqual(filePaths.sort());
			} finally {
				unsubscribe();
				await removeWithRetries(tempDir);
			}
		},
	);

	it.each([
		["file to directory", false],
		["file to directory", true],
		["directory to file", false],
		["directory to file", true],
	] as const)(
		"refreshes rewritten paths and index content across %s with multiple targets=%s",
		async (boundary, multipleTargets) => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-target-type-"));
			const cwd = path.join(tempDir, "project");
			await fs.mkdir(cwd);
			const service = new RepoService({ cwd, agentDir: path.join(tempDir, "agent") });
			const notifications: string[] = [];
			const unsubscribe = subscribeFsMutation(paths => {
				const projectPaths = paths
					.map(filePath => path.resolve(filePath))
					.filter(filePath => filePath.startsWith(`${cwd}${path.sep}`));
				notifications.push(...projectPaths);
				service.markChanged(projectPaths);
			});
			try {
				const targetPath = path.join(cwd, "target.py");
				const childPaths = [path.join(targetPath, "child.py"), path.join(targetPath, "nested", "other.py")];
				const source = "def caller():\n    return legacy_call(value)\n";
				const writeDirectory = async () => {
					await fs.mkdir(path.dirname(childPaths[1]!), { recursive: true });
					for (const childPath of childPaths) await Bun.write(childPath, source);
				};
				if (boundary === "file to directory") await Bun.write(targetPath, source);
				else await writeDirectory();
				const stablePath = path.join(cwd, "stable.py");
				if (multipleTargets) await Bun.write(stablePath, source);
				const queue = new ToolChoiceQueue();
				const tools = await createTools(
					createTestSession(cwd, {
						getToolChoiceQueue: () => queue,
						buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
						steer: () => {},
					}),
					["ast_edit"],
				);
				const tool = tools.find(entry => entry.name === "ast_edit")!;
				const preview = await tool.execute("ast-edit-target-type-preview", {
					ops: [{ pat: "legacy_call($A)", out: "modern_call($A)" }],
					paths: multipleTargets ? [targetPath, stablePath] : [targetPath],
				});
				expect(preview.details).toMatchObject({ applied: false });
				expect(notifications).toEqual([]);
				for (const candidate of boundary === "file to directory" ? [targetPath] : childPaths) {
					expect(await Bun.file(candidate).text()).toBe(source);
				}

				await fs.rm(targetPath, { recursive: true });
				if (boundary === "file to directory") await writeDirectory();
				else await Bun.write(targetPath, source);
				const rewrittenPaths = boundary === "file to directory" ? [...childPaths] : [targetPath];
				if (multipleTargets) rewrittenPaths.push(stablePath);
				const expectedFiles = rewrittenPaths
					.map(filePath => path.relative(cwd, filePath).replaceAll("\\", "/"))
					.sort();
				// Index the replacement tree before apply: only the AST write notifications
				// can now refresh these already-indexed legacy snippets.
				await service.build();
				expect((await service.search("legacy_call")).hits.map(hit => hit.path).sort()).toEqual(expectedFiles);

				const applyResult = (await queue.peekPendingInvoker()!({
					action: "apply",
					reason: "apply after target type changed",
				})) as InvokedToolResult;
				expect(applyResult.isError).toBe(true);
				expect(applyResult.details).toMatchObject({
					sourceResultDetails: {
						applied: true,
						totalReplacements: rewrittenPaths.length,
						files: expect.arrayContaining(expectedFiles),
						fileReplacements: expect.arrayContaining(
							expectedFiles.map(filePath => ({ path: filePath, count: 1 })),
						),
					},
				});
				expect(notifications.sort()).toEqual(rewrittenPaths.sort());
				for (const filePath of rewrittenPaths) {
					expect(await Bun.file(filePath).text()).toBe(source.replace("legacy_call", "modern_call"));
				}
				const refreshed = await service.search("modern_call");
				expect(refreshed.hits.map(hit => hit.path).sort()).toEqual(expectedFiles);
				for (const hit of refreshed.hits) expect(hit.snippet).toContain("modern_call(value)");
				expect((await service.status()).pendingCount).toBe(0);
			} finally {
				unsubscribe();
				service.close();
				await removeWithRetries(tempDir);
			}
		},
	);

	it("marks the single-file candidate uncertain when deferred apply fails", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-failed-notify-"));
		const notifications: Array<{ paths: readonly string[]; reason?: string }> = [];
		const unsubscribe = subscribeFsMutation((paths, reason) => {
			const normalizedPaths = paths.map(filePath => path.resolve(filePath));
			if (normalizedPaths.some(filePath => filePath.startsWith(`${path.resolve(tempDir)}${path.sep}`)))
				notifications.push({ paths: normalizedPaths, reason });
		});
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();
			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit")!;
			await tool.execute("ast-edit-preview-failure", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			await fs.rm(filePath);
			const invoker = queue.peekPendingInvoker()!;
			try {
				await invoker({ action: "apply", reason: "apply after target disappeared" });
			} catch {
				// The resolver may propagate the native failure or return an error result.
			}
			expect(notifications).toEqual([
				{
					paths: [filePath],
					reason: "AST edit apply failed; files may have been partially written; reconcile to verify coverage",
				},
			]);
		} finally {
			unsubscribe();
			await removeWithRetries(tempDir);
		}
	});

	it("fails stale pending apply when preview no longer matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-stale-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect((previewResult.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			const mutatedContent = "otherWrap(x, value)\n";
			await Bun.write(filePath, mutatedContent);

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({ action: "apply", reason: "apply stale preview" })) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";

			expect(applyResult.isError).toBe(true);
			expect(applyText).toContain("Preview is stale / no longer matches");
			expect(applyText).toContain("no replacements were applied");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(0);
			expect(await Bun.file(filePath).text()).toBe(mutatedContent);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "legacyWrap(rootValue, rootArg)\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "legacyWrap(childValue, childArg)\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "legacyWrap(ignoreValue, ignoreArg)\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "legacyWrap(outsideValue, outsideArg)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-glob", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [`${packagesDir}/pkg-*/src/**/*.ts`],
			});

			const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
			const details = previewResult.details as
				| { totalReplacements?: number; fileReplacements?: Array<{ path: string; count: number }> }
				| undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.totalReplacements).toBe(2);
			expect(details?.fileReplacements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "packages/pkg-123/src/root.ts", count: 1 }),
					expect.objectContaining({ path: "packages/pkg-123/src/nested/child.ts", count: 1 }),
				]),
			);

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply previewed AST edit with combined globs" });

			expect(await Bun.file(path.join(sourceDir, "root.ts")).text()).toContain("modernWrap(rootValue, rootArg)");
			expect(await Bun.file(path.join(nestedDir, "child.ts")).text()).toContain("modernWrap(childValue, childArg)");
			expect(await Bun.file(path.join(sourceDir, "ignore.js")).text()).toContain(
				"legacyWrap(ignoreValue, ignoreArg)",
			);
			expect(await Bun.file(path.join(tempDir, "outside.ts")).text()).toContain(
				"legacyWrap(outsideValue, outsideArg)",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("infers tlaplus from .tla files for AST edits", () =>
		withTlaplusGrammar(async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-tlaplus-"));
			try {
				const filePath = path.join(tempDir, "Spec.tla");
				await Bun.write(
					filePath,
					`---- MODULE Spec ----\nVARIABLE x\n\nInit == x = 0\n\nNext == x' = x + 1\n====\n`,
				);
				const queue = new ToolChoiceQueue();

				const tools = await createTools(
					createTestSession(tempDir, {
						getToolChoiceQueue: () => queue,
						buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
						steer: () => {},
					}),
					["ast_edit"],
				);
				const tool = tools.find(entry => entry.name === "ast_edit");
				expect(tool).toBeDefined();

				const previewResult = await tool!.execute("ast-edit-tlaplus", {
					ops: [{ pat: "Init", out: "Start" }],
					paths: [filePath],
				});

				const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
				const details = previewResult.details as { totalReplacements?: number; parseErrors?: string[] } | undefined;
				expect(text).toContain("Start");
				expect(details?.totalReplacements).toBe(1);
				expect(details?.parseErrors).toBeUndefined();

				const invoker = queue.peekPendingInvoker()!;
				await invoker({ action: "apply", reason: "apply tlaplus AST edit" });
				expect(await Bun.file(filePath).text()).toContain("Start == x = 0");
			} finally {
				await removeWithRetries(tempDir);
			}
		}));
});
