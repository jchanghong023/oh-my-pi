import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";
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
		"previews without writing and applies AST edits for %s targets",
		async scope => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-pending-"));
			try {
				const filePath = path.join(tempDir, "legacy.ts");
				const files = [{ path: filePath, source: "legacyWrap(x, value)\n" }];
				if (scope === "multiple files") {
					files.push({ path: path.join(tempDir, "other.ts"), source: "legacyWrap(other, value)\n" });
				}
				for (const file of files) await Bun.write(file.path, file.source);
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
					paths: scope === "directory" ? [tempDir] : files.map(file => file.path),
				});
				expect(previewResult.details).toBeDefined();
				expect((previewResult.details as { applied?: boolean }).applied).toBe(false);
				for (const file of files) expect(await Bun.file(file.path).text()).toBe(file.source);

				expect(queue.hasPendingInvoker).toBe(true);
				const invoker = queue.peekPendingInvoker()!;
				const applyResult = (await invoker({
					action: "apply",
					reason: "apply previewed AST edit",
				})) as InvokedToolResult;
				const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";
				expect(applyResult.isError).toBeUndefined();
				expect(applyText).toContain(
					files.length === 1 ? "Applied 1 replacement in 1 file." : "Applied 2 replacements in 2 files.",
				);
				expect(
					(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
						?.sourceResultDetails?.totalReplacements,
				).toBe(files.length);
				for (const file of files) {
					expect(await Bun.file(file.path).text()).toBe(file.source.replace("legacyWrap", "modernWrap"));
				}
			} finally {
				await removeWithRetries(tempDir);
			}
		},
	);

	it.each([
		["file to directory", false],
		["file to directory", true],
		["directory to file", false],
		["directory to file", true],
	] as const)("rewrites current paths across %s with multiple targets=%s", async (boundary, multipleTargets) => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-target-type-"));
		const cwd = path.join(tempDir, "project");
		await fs.mkdir(cwd);
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
			for (const candidate of boundary === "file to directory" ? [targetPath] : childPaths) {
				expect(await Bun.file(candidate).text()).toBe(source);
			}
			if (multipleTargets) expect(await Bun.file(stablePath).text()).toBe(source);

			await fs.rm(targetPath, { recursive: true });
			if (boundary === "file to directory") await writeDirectory();
			else await Bun.write(targetPath, source);
			const rewrittenPaths = boundary === "file to directory" ? [...childPaths] : [targetPath];
			if (multipleTargets) rewrittenPaths.push(stablePath);
			const expectedFiles = rewrittenPaths
				.map(filePath => path.relative(cwd, filePath).replaceAll("\\", "/"))
				.sort();

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
					fileReplacements: expect.arrayContaining(expectedFiles.map(filePath => ({ path: filePath, count: 1 }))),
				},
			});
			for (const filePath of rewrittenPaths) {
				expect(await Bun.file(filePath).text()).toBe(source.replace("legacy_call", "modern_call"));
			}
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("reports zero writes when a previewed file is deleted before apply", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-deleted-target-"));
		const errorLog = spyOn(logger, "error").mockImplementation(() => {});
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
			const preview = await tool.execute("ast-edit-preview-failure", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect(preview.details).toMatchObject({ applied: false, totalReplacements: 1 });
			expect(await Bun.file(filePath).text()).toBe("legacyWrap(x, value)\n");
			await fs.rm(filePath);
			const invoker = queue.peekPendingInvoker()!;
			await expect(invoker({ action: "apply", reason: "apply after target disappeared" })).rejects.toThrow();
			expect(await Bun.file(filePath).exists()).toBe(false);
			expect(errorLog).toHaveBeenCalledWith(
				"Deferred AST edit apply failed",
				expect.objectContaining({
					event: "ast_edit_deferred_apply_failed",
					stage: "resolve_scope",
					result: "failed",
					candidate_count: 1,
					reported_written_count: 0,
					possible_partial_write: false,
				}),
			);
		} finally {
			errorLog.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("reports and applies explicit file targets under their own paths", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-files-"));
		try {
			await fs.mkdir(path.join(tempDir, "server", "public"), { recursive: true });
			const first = path.join(tempDir, "server", "public", "session.ts");
			const second = path.join(tempDir, "client.ts");
			await Bun.write(first, "legacyWrap(a, b)\n");
			await Bun.write(second, "legacyWrap(c, d)\n");
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

			const previewResult = await tool.execute("ast-edit-files", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["server/public/session.ts", "client.ts"],
			});
			const files = (previewResult.details as { files?: string[] }).files ?? [];
			expect([...files].sort()).toEqual(["client.ts", "server/public/session.ts"]);

			const applyResult = (await queue.peekPendingInvoker()!({
				action: "apply",
				reason: "apply previewed AST edit",
			})) as InvokedToolResult;
			expect(applyResult.isError).toBeUndefined();
			expect(await Bun.file(first).text()).toBe("modernWrap(a, b)\n");
			expect(await Bun.file(second).text()).toBe("modernWrap(c, d)\n");
		} finally {
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
