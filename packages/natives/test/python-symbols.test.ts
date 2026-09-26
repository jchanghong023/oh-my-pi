import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob, pythonSymbols } from "../native/index.js";

describe("native Python definitions", () => {
	test("indexes decorated multiline async definitions with original UTF-8 and CRLF coordinates", async () => {
		const code = [
			"@decorate(",
			'    "é:値"',
			")",
			"async def 服务(",
			"    value: dict[str, str],",
			") -> str:",
			'    return value["x"]',
			"",
			"@register",
			"class 外部:",
			"    @staticmethod",
			"    async def 执行(self, x: int) -> int:",
			"        def inner():",
			"            return x",
			"        return inner()",
			"    class Inner:",
			"        def child(self): return 1",
			"",
			"def outer():",
			"    class Local:",
			"        def call(self): return 2",
			"    def nested(): return 3",
			"    return nested()",
		].join("\r\n");
		const result = await pythonSymbols({ code });
		expect(result.parseError).toBe(false);
		expect(result.symbols).toEqual([
			{
				name: "服务",
				qualname: "服务",
				kind: "function",
				startLine: 1,
				endLine: 7,
				signature: '@decorate(\r\n    "é:値"\r\n)\r\nasync def 服务(\r\n    value: dict[str, str],\r\n) -> str:',
			},
			{
				name: "外部",
				qualname: "外部",
				kind: "class",
				startLine: 9,
				endLine: 17,
				signature: "@register\r\nclass 外部:",
			},
			{
				name: "执行",
				qualname: "外部.执行",
				kind: "method",
				startLine: 11,
				endLine: 15,
				signature: "@staticmethod\r\n    async def 执行(self, x: int) -> int:",
			},
			{
				name: "inner",
				qualname: "外部.执行.inner",
				kind: "function",
				startLine: 13,
				endLine: 14,
				signature: "def inner():",
			},
			{
				name: "Inner",
				qualname: "外部.Inner",
				kind: "class",
				startLine: 16,
				endLine: 17,
				signature: "class Inner:",
			},
			{
				name: "child",
				qualname: "外部.Inner.child",
				kind: "method",
				startLine: 17,
				endLine: 17,
				signature: "def child(self):",
			},
			{ name: "outer", qualname: "outer", kind: "function", startLine: 19, endLine: 23, signature: "def outer():" },
			{
				name: "Local",
				qualname: "outer.Local",
				kind: "class",
				startLine: 20,
				endLine: 21,
				signature: "class Local:",
			},
			{
				name: "call",
				qualname: "outer.Local.call",
				kind: "method",
				startLine: 21,
				endLine: 21,
				signature: "def call(self):",
			},
			{
				name: "nested",
				qualname: "outer.nested",
				kind: "function",
				startLine: 22,
				endLine: 22,
				signature: "def nested():",
			},
		]);
	});

	test("repeated names remain separate declarations and nested class methods have the immediate class as owner", async () => {
		const code =
			"def same(): return 1\ndef same(): return 2\nclass C:\n    class Nested:\n        def same(self): return 3\n    def method(self):\n        class Inside:\n            def same(self): return 4\n        def same(): return 5\n        return same()\n";
		const { symbols, parseError } = await pythonSymbols({ code });
		expect(parseError).toBe(false);
		expect(symbols.map(({ qualname, kind, startLine }) => [qualname, kind, startLine])).toEqual([
			["same", "function", 1],
			["same", "function", 2],
			["C", "class", 3],
			["C.Nested", "class", 4],
			["C.Nested.same", "method", 5],
			["C.method", "method", 6],
			["C.method.Inside", "class", 7],
			["C.method.Inside.same", "method", 8],
			["C.method.same", "function", 9],
		]);
	});

	test("syntax errors discard all symbols rather than returning earlier definitions", async () => {
		const valid = "def previously_valid(): return 1\n";
		expect((await pythonSymbols({ code: valid })).symbols[0]?.name).toBe("previously_valid");
		const broken = await pythonSymbols({ code: `${valid}def broken(:\n` });
		expect(broken).toEqual({ symbols: [], parseError: true });
		expect(await pythonSymbols({ code: "" })).toEqual({ symbols: [], parseError: false });
	});

	test("an already-aborted task rejects rather than exposing partial symbols", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(pythonSymbols({ code: "def example(): pass\n", signal: controller.signal })).rejects.toThrow();
	});
});

test.skipIf(process.platform === "win32")(
	"strict glob reports unreadable subtrees instead of claiming a complete inventory",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-strict-glob-"));
		const blocked = path.join(root, "blocked");
		try {
			await fs.chmod(root, 0o755);
			await fs.mkdir(blocked);
			await fs.writeFile(path.join(blocked, "hidden.py"), "pass\n");
			await fs.writeFile(path.join(root, "visible.py"), "pass\n");
			await fs.chmod(blocked, 0);
			if (process.getuid?.() === 0) {
				// The child loads the real addon first, then drops root privileges to exercise OS permissions.
				const script = `
					const { glob } = await import(${JSON.stringify(new URL("../native/index.js", import.meta.url).href)});
					process.chdir(${JSON.stringify(root)});
					process.setgid(65534);
					process.setuid(65534);
					const options = { pattern: "**/*.py", path: ${JSON.stringify(root)} };
					const ordinary = await glob(options);
					let strictFailed = false;
					try { await glob({ ...options, strictErrors: true }); }
					catch { strictFailed = true; }
					console.log(JSON.stringify({ matches: ordinary.matches.map(match => match.path), strictFailed }));
				`;
				const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
				const [output, errors, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				if (exitCode !== 0) throw new Error(`Unprivileged native glob failed: ${errors}`);
				expect(JSON.parse(output)).toEqual({ matches: ["visible.py"], strictFailed: true });
			} else {
				expect((await glob({ pattern: "**/*.py", path: root })).matches.map(match => match.path)).toEqual([
					"visible.py",
				]);
				await expect(glob({ pattern: "**/*.py", path: root, strictErrors: true })).rejects.toThrow();
			}
		} finally {
			await fs.chmod(blocked, 0o700).catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
