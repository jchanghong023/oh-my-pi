import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bazelShell, bazelToolPath } from "./test-gate-bazel-tools";

test("WindowsApps-first PATH retains later installed Python candidates in order", () => {
	const installed = "C:\\Python313;C:\\Python312;C:\\Program Files\\Git\\cmd";
	expect(bazelToolPath(`C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps;${installed}`, "win32")).toBe(
		installed,
	);
});

test("WindowsApps matching is case-insensitive without excluding neighboring installation names", () => {
	expect(
		bazelToolPath(
			"C:/Microsoft/WindowsApps/;C:/MICROSOFT/WINDOWSAPPS/alias;C:/Microsoft/WindowsAppsTools;C:/Python313",
			"win32",
		),
	).toBe("C:/Microsoft/WindowsAppsTools;C:/Python313");
});

test("non-Windows tool lookup preserves PATH verbatim", () => {
	const value = "/opt/Microsoft/WindowsApps:/usr/local/bin::/usr/bin";
	expect(bazelToolPath(value, "linux")).toBe(value);
});

test("Windows shell selection crosses real installed-Git filesystem boundaries, never app aliases", () => {
	const temporary = mkdtempSync(path.join(os.tmpdir(), "bazel-shell-"));
	try {
		const git = path.join(temporary, "Git");
		const alias = path.join(temporary, "Microsoft", "WindowsApps");
		for (const directory of ["cmd", "bin", "usr/bin", "mingw64/bin"]) {
			mkdirSync(path.join(git, directory), { recursive: true });
		}
		mkdirSync(alias, { recursive: true });
		const bash = path.join(git, "bin", "bash.exe");
		const aliasBash = path.join(alias, "bash.exe");
		const runtime = path.join(git, "usr", "bin", "msys-2.0.dll");
		for (const filename of [
			bash,
			aliasBash,
			runtime,
			path.join(git, "cmd", "git.exe"),
			path.join(git, "mingw64", "bin", "git.exe"),
		]) {
			writeFileSync(filename, "fixture");
		}
		const env = { PATH: `${alias};${path.join(git, "cmd")}`, BAZEL_SH: aliasBash };
		expect(bazelShell(env, "win32")).toBe(bash);
		expect(bazelShell({ PATH: path.join(git, "mingw64", "bin") }, "win32")).toBe(bash);
		const explicit = path.join(temporary, "explicit-bash.exe");
		writeFileSync(explicit, "fixture");
		expect(bazelShell({ ...env, BAZEL_SH: explicit }, "win32")).toBe(explicit);
		expect(bazelShell({ ...env, BAZEL_SH: path.join(temporary, "missing.exe") }, "win32")).toBe(bash);
		// A stray bin/bash.exe beside git.exe is not a closed Git/MSYS installation.
		rmSync(runtime);
		expect(() => bazelShell(env, "win32")).toThrow("installed Bash");
		expect(() => bazelShell({ PATH: alias }, "win32")).toThrow("installed Bash");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("non-Windows shell selection preserves the inherited shell without imposing Git for Windows", () => {
	expect(bazelShell({ PATH: "/usr/bin", BAZEL_SH: "/bin/bash" }, "linux")).toBe("/bin/bash");
	expect(bazelShell({ PATH: "/usr/bin" }, "linux")).toBeUndefined();
});
