import { describe, expect, it } from "bun:test";
import { summarizeCompactTool } from "@oh-my-pi/pi-coding-agent/modes/compact-tool-summary";

const patch = "*** Begin Patch\n*** Add File: hello.txt\n+PRIVATE_PATCH_BODY\n*** End Patch\n";

describe("compact tool parameter summaries", () => {
	// Known tool schemas expose their operation/target, not arbitrary parameter bodies.
	it.each([
		{ name: "ast_grep", args: { pat: "oldApi($$$)", path: "src" }, visible: ["oldApi($$$)", "src"] },
		{ name: "ast_grep", args: { pat: "oldApi($$$)" }, visible: ["oldApi($$$)"] },
		{
			name: "ast_edit",
			args: { ops: [{ pat: "oldApi($$$)", out: "PRIVATE_REPLACEMENT" }], paths: ["src/**/*.ts"] },
			visible: ["src/**/*.ts"],
		},
		{
			name: "openwiki_read",
			args: { page: "architecture/jobs.md", sections: ["retry"] },
			visible: ["architecture/jobs.md"],
		},
		{ name: "openwiki_list_wikis", args: { workspace: "engineering" }, visible: ["engineering"] },
		{ name: "openwiki_list_workspaces", args: { wiki: "project-wiki" }, visible: ["project-wiki"] },
		{ name: "edit", args: { input: patch }, visible: ["hello.txt"] },
		{ name: "apply_patch", args: { input: patch }, visible: ["hello.txt"] },
		{ name: "edit", args: { path: "source.ts", content: "PRIVATE_REPLACEMENT" }, visible: ["source.ts"] },
		{
			name: "lsp",
			args: { action: "references", file: "src/app.ts", line: 12, symbol: "handle" },
			visible: ["references", "src/app.ts"],
		},
		{
			name: "debug",
			args: { action: "launch", adapter: "debugpy", program: "scripts/job.py" },
			visible: ["launch", "scripts/job.py"],
		},
		{ name: "ida", args: { action: "open", db: "sample.i64" }, visible: ["open", "sample.i64"] },
		{ name: "security_scan", args: { action: "status", operation_id: "op-123" }, visible: ["status", "op-123"] },
		{ name: "memory_edit", args: { op: "forget", id: "mem-123" }, visible: ["forget", "mem-123"] },
		{
			name: "manage_skill",
			args: { action: "delete", name: "obsolete-skill" },
			visible: ["delete", "obsolete-skill"],
		},
		{ name: "grep", args: { pattern: "TODO", path: "src" }, visible: ["TODO", "src"] },
		{ name: "knowledge_search", args: { query: "mbist failure", path: "docs" }, visible: ["mbist failure", "docs"] },
		{
			name: "repo",
			args: { action: "symbol", query: "Widget.render", path: "src" },
			visible: ["symbol", "Widget.render", "src"],
		},
		{ name: "todo", args: { op: "start", task: "修复解析器" }, visible: ["start", "修复解析器"] },
		{ name: "goal", args: { op: "create", objective: "完成迁移" }, visible: ["create", "完成迁移"] },
		{ name: "task", args: { name: "Parser", agent: "task", task: "检查解析器" }, visible: ["Parser", "检查解析器"] },
		{ name: "task", args: { agent: "reviewer", task: "检查解析器" }, visible: ["reviewer", "检查解析器"] },
		{
			name: "task",
			args: {
				tasks: [
					{ name: "Parser", task: "检查解析器" },
					{ name: "Renderer", task: "检查渲染器" },
				],
			},
			visible: ["Parser", "2"],
		},
		{
			name: "ask",
			args: { questions: [{ id: "storage", question: "Database?", options: [{ label: "SQLite" }] }] },
			visible: ["Database?"],
		},
		{
			name: "init_experiment",
			args: { name: "parser benchmark", primary_metric: "latency" },
			visible: ["parser benchmark"],
		},
		{
			name: "log_experiment",
			args: { metric: 12.5, status: "keep", description: "baseline" },
			visible: ["keep", "baseline"],
		},
		{ name: "yield", args: { key: 1, data: { result: "PRIVATE_PAYLOAD" } }, visible: ["1"] },
	])("projects $name operation and target", ({ name, args, visible }) => {
		const summary = summarizeCompactTool(name, args);
		const text = `${summary.detail} ${summary.command ?? ""}`;
		for (const expected of visible) expect(text).toContain(expected);
		expect(text).not.toMatch(/PRIVATE_PATCH_BODY|PRIVATE_REPLACEMENT|PRIVATE_PAYLOAD/);
	});

	it("shows valid workpool item numbers without exposing yield results", () => {
		for (const key of [1, 42, Number.MAX_SAFE_INTEGER]) {
			expect(summarizeCompactTool("yield", { key, data: "PRIVATE_PAYLOAD", error: "PRIVATE_ERROR" })).toEqual({
				detail: String(key),
			});
		}
	});

	it("does not coerce invalid workpool keys into public targets", () => {
		for (const key of [undefined, null, false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", {}, []]) {
			expect(summarizeCompactTool("yield", { key, data: "PRIVATE_PAYLOAD", error: "PRIVATE_ERROR" })).toEqual({
				detail: "",
			});
		}
	});

	// Intents win over target/operation fallback, while an actual command remains visible separately.
	it("preserves intent priority without dropping the raw command", () => {
		const args = {
			i: "argument intent",
			intent: "legacy intent",
			title: "title intent",
			command: "echo raw",
			path: "target.ts",
		};
		expect(summarizeCompactTool("bash", args, "event intent")).toEqual({
			detail: "event intent",
			command: "echo raw",
		});
		expect(summarizeCompactTool("bash", args)).toEqual({ detail: "argument intent", command: "echo raw" });
		expect(summarizeCompactTool("bash", { ...args, i: 42 })).toEqual({
			detail: "legacy intent",
			command: "echo raw",
		});
		expect(summarizeCompactTool("bash", { ...args, i: {}, intent: false })).toEqual({
			detail: "title intent",
			command: "echo raw",
		});
		expect(summarizeCompactTool("bash", { command: "echo raw" }, "echo raw")).toEqual({
			detail: "",
			command: "echo raw",
		});
		expect(summarizeCompactTool("repo", { action: "search", query: "TARGET", i: "INTENT" }).detail).toBe("INTENT");
	});

	// Eval preserves its source spelling; it is not guessed to be a shell or parsed as a browser invocation.
	it.each([
		{ code: '%load "scripts/my setup.py"', title: "加载脚本" },
		{ code: "%environment project", title: "切换环境" },
		{ code: "await browser({action: 'tabs'})", title: "查看标签" },
		{ code: "await computer({action: 'capabilities'})", title: "查看能力" },
	])("retains eval code $code", ({ code, title }) => {
		expect(summarizeCompactTool("eval", { language: "js", code, title })).toEqual({ detail: title, command: code });
		expect(summarizeCompactTool("eval", { code })).toEqual({ detail: "", command: code });
	});

	// Structured progress is supplied by the caller, never scraped from a tool's output text.
	it("uses supplied wait progress as the command while retaining the wait intent", () => {
		expect(summarizeCompactTool("wait", { i: "等待检查" }, undefined, "[bash] bg_1 echo test")).toEqual({
			detail: "等待检查",
			command: "[bash] bg_1 echo test",
		});
	});

	// The presence of context_notes.text controls the operation; the note itself stays private.
	it("distinguishes note reads, clears and writes without exposing note text", () => {
		expect(summarizeCompactTool("context_notes", {}).detail).toBe("read");
		expect(summarizeCompactTool("context_notes", { text: "" }).detail).toBe("clear");
		for (const text of ["PRIVATE_NOTE", "   "]) {
			expect(summarizeCompactTool("context_notes", { text }).detail).toBe("write");
		}
	});

	// Generic extensions may expose standard summary fields, not invented meanings for arbitrary schema fields.
	it.each(["path", "target", "url", "query", "pattern"])("uses a standard extension %s field", field => {
		expect(summarizeCompactTool("custom_mcp_tool", { [field]: "KNOWN_TARGET", payload: "PRIVATE_PAYLOAD" })).toEqual({
			detail: "KNOWN_TARGET",
		});
	});

	// Tools with no public short target remain identity-only; their payloads are never summaries.
	it.each([
		{ name: "think", args: { thoughts: "PRIVATE_THOUGHTS" } },
		{ name: "yield", args: { data: "PRIVATE_PAYLOAD", error: "PRIVATE_ERROR" } },
		{ name: "retain", args: { items: [{ content: "PRIVATE_MEMORY" }] } },
		{ name: "learn", args: { memory: "PRIVATE_MEMORY" } },
		{ name: "update_notes", args: { body: "PRIVATE_NOTE" } },
		{ name: "run_experiment", args: { timeout_seconds: 600 } },
		{ name: "new_context", args: {} },
		{ name: "openwiki_list_workspaces", args: {} },
		{ name: "custom_mcp_tool", args: { payload: "PRIVATE_PAYLOAD" } },
	])("keeps $name payloads out of its summary", ({ name, args }) => {
		expect(summarizeCompactTool(name, args)).toEqual({ detail: "" });
	});

	// Malformed and partial values are not coerced to text or used to mutate business arguments.
	it.each([
		{ shape: "undefined", args: undefined },
		{ shape: "null", args: null },
		{ shape: "boolean", args: false },
		{ shape: "number", args: 42 },
		{ shape: "string", args: "PRIVATE_PAYLOAD" },
		{ shape: "empty array", args: [] },
		{ shape: "wrong-type fields", args: { title: {}, command: false, path: [] } },
	])("ignores unsupported argument shapes $shape", ({ args }) => {
		expect(summarizeCompactTool("custom_mcp_tool", args)).toEqual({ detail: "" });
	});

	it("ignores wrong-type schema fields and leaves input objects unchanged", () => {
		const args = Object.freeze({ action: {}, query: "Widget", path: [], i: 7, title: ["PRIVATE_TITLE"] });
		expect(summarizeCompactTool("repo", args).detail).toContain("Widget");
		expect(args).toEqual({ action: {}, query: "Widget", path: [], i: 7, title: ["PRIVATE_TITLE"] });
		for (const name of [
			"lsp",
			"debug",
			"ida",
			"security_scan",
			"memory_edit",
			"manage_skill",
			"ast_edit",
			"task",
			"ask",
		]) {
			const summary = summarizeCompactTool(name, {
				action: [],
				op: {},
				file: false,
				tasks: {},
				questions: 3,
				paths: [null],
				ops: [false],
			});
			expect(summary).toEqual({ detail: "" });
		}
	});
});
