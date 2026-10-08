import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "../..");
const tempDirs: string[] = [];

type InstallerFixture = {
	env: NodeJS.ProcessEnv;
	log: string;
	installDir: string;
};

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function createFixture(osName = "Linux", arch = "x86_64"): Promise<InstallerFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-installer-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	const log = path.join(dir, "commands.log");
	await fs.mkdir(binDir);
	await Bun.write(log, "");

	await writeExecutable(binDir, "uname", `#!/bin/sh\n[ "$1" = "-s" ] && echo ${osName} || echo ${arch}\n`);
	await writeExecutable(binDir, "sysctl", "#!/bin/sh\necho 0\n");
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
printf 'curl %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  *api.github.com*)
    case "$*" in
      */releases/tags/*) tag="\${*##*/releases/tags/}" ;;
      *) tag="v18.0.9+fork.125" ;;
    esac
    printf '{"tag_name":"%s"}\\n' "$tag"
    ;;
  *)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then
        printf '%s\\n' '#!/bin/sh' "echo \\"\${TEST_BINARY_PREFIX-omp/}\${TEST_BINARY_VERSION:-18.0.9+fork.125}\\"" > "$2"
        exit 0
      fi
      shift
    done
    exit 1
    ;;
esac
`,
	);

	return {
		log,
		installDir,
		env: {
			...process.env,
			PATH: `${binDir}:/usr/bin:/bin`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
			TEST_LOG: log,
		},
	};
}

async function runInstallerWithFixture(
	args: string[],
	fixture: InstallerFixture,
): Promise<{ exitCode: number; stdout: string; stderr: string; commands: string }> {
	const proc = Bun.spawn(["sh", "scripts/install.sh", ...args], {
		cwd: repoRoot,
		env: fixture.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const commands = await Bun.file(fixture.log).text();
	return { exitCode, stdout, stderr, commands };
}

async function runInstaller(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; commands: string }> {
	return runInstallerWithFixture(args, await createFixture());
}

// The fixtures stub uname/curl with POSIX `sh` scripts, join PATH with `:`,
// and spawn the installer through `sh`, none of which exist on Windows.
describe.skipIf(process.platform === "win32")("fork installer routing", () => {
	test.each([
		["x86_64", "x64"],
		["aarch64", "arm64"],
	])("defaults to the latest fork release for %s", async (arch, assetArch) => {
		const result = await runInstallerWithFixture([], await createFixture("Linux", arch));
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain("api.github.com/repos/jchanghong023/oh-my-pi/releases/latest");
		expect(result.commands).toContain(
			`github.com/jchanghong023/oh-my-pi/releases/download/v18.0.9+fork.125/omp-linux-${assetArch}`,
		);
		expect(result.commands).not.toContain("bun install");
	});

	test("rejects the removed source mode before network access", async () => {
		const result = await runInstaller(["--source"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unknown option: --source");
		expect(result.commands).not.toContain("api.github.com");
	});

	test("a release ref selects that published fork release", async () => {
		const result = await runInstaller(["--ref", "v18.0.9+fork.125"]);
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain("api.github.com/repos/jchanghong023/oh-my-pi/releases/tags/v18.0.9+fork.125");
		expect(result.commands).not.toContain("git clone");
		expect(result.commands).not.toContain("bun install");
	});

	test("rejects every installation mode on macOS before network access", async () => {
		for (const args of [[], ["--binary"]]) {
			const result = await runInstallerWithFixture(args, await createFixture("Darwin"));
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("macOS is not supported by this fork.");
			expect(result.commands).not.toContain("api.github.com");
			expect(result.commands).not.toContain("git clone");
			expect(result.commands).not.toContain("bun install");
		}
	});

	test.skipIf(process.platform !== "linux")(
		"atomically replaces Linux targets without stopping running sessions",
		async () => {
			const fixture = await createFixture();
			await fs.mkdir(fixture.installDir, { recursive: true });
			const target = path.join(fixture.installDir, "omp");
			const sleepBinary = Bun.which("sleep");
			if (!sleepBinary) throw new Error("sleep executable is required for the Linux installer fixture");
			await fs.copyFile(sleepBinary, target);
			await fs.chmod(target, 0o755);
			const running = Bun.spawn([target, "60"], { stdout: "ignore", stderr: "ignore" });
			try {
				const result = await runInstallerWithFixture([], fixture);
				expect(result.exitCode, result.stdout).toBe(0);
				expect(result.stdout).toContain("continue using the old inode and old version");
				expect(result.stdout).toContain("Exit and restart those sessions");
				expect(() => process.kill(running.pid, 0)).not.toThrow();

				const installed = Bun.spawn([target, "--version"], { stdout: "pipe", stderr: "pipe" });
				const [installedExit, installedOutput] = await Promise.all([
					installed.exited,
					new Response(installed.stdout).text(),
				]);
				expect(installedExit).toBe(0);
				expect(installedOutput.trim()).toBe("omp/18.0.9+fork.125");
			} finally {
				running.kill();
				await running.exited;
			}
		},
	);

	test("rejects a directory at the executable path without moving its contents", async () => {
		const fixture = await createFixture();
		const target = path.join(fixture.installDir, "omp");
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(path.join(target, "keep.txt"), "unrelated");
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Refusing to replace a directory");
		expect(await Bun.file(path.join(target, "keep.txt")).text()).toBe("unrelated");
		expect(result.commands).not.toContain("api.github.com");
	});

	test.each([
		["wrong version", "omp/", "18.0.9+fork.124"],
		["missing omp prefix", "", "18.0.9+fork.125"],
	])("a %s download leaves the previous install untouched", async (_case, prefix, version) => {
		const fixture = await createFixture();
		await fs.mkdir(fixture.installDir, { recursive: true });
		const target = path.join(fixture.installDir, "omp");
		const oldBinary = '#!/bin/sh\necho "omp/18.0.8+fork.124"\n';
		await writeExecutable(fixture.installDir, "omp", oldBinary);
		fixture.env.TEST_BINARY_PREFIX = prefix;
		fixture.env.TEST_BINARY_VERSION = version;
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unexpected version");
		expect(await Bun.file(target).text()).toBe(oldBinary);
		expect((await fs.readdir(fixture.installDir)).filter(file => file.startsWith(".omp.tmp."))).toEqual([]);
	});

	test("an installed program reporting the bare release number is not mistaken for omp", async () => {
		const fixture = await createFixture();
		await fs.mkdir(fixture.installDir, { recursive: true });
		await writeExecutable(fixture.installDir, "omp", '#!/bin/sh\necho "18.0.9+fork.125"\n');
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.commands).toContain("/releases/download/");
	});

	test("an already-installed release skips binary download and still gives a PATH hint", async () => {
		const fixture = await createFixture();
		await fs.mkdir(fixture.installDir, { recursive: true });
		await writeExecutable(
			fixture.installDir,
			"omp",
			'#!/bin/sh\necho "omp/18.0.9+fork.125 (built 2026-10-04T00:00Z)"\n',
		);
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("already installed");
		expect(result.stdout).toContain(`Add ${fixture.installDir} to your PATH`);
		expect(result.commands).not.toContain("/releases/download/");
	});
});

const windowsPowerShell = process.platform === "win32" ? Bun.which("powershell.exe") : null;

// Execute the installer functions in an isolated PowerShell process. Only HTTP
// and user-PATH persistence are replaced; binary probes, live-image rename and
// rollback use real files and processes. No network or real omp install is used.
describe.skipIf(!windowsPowerShell)("Windows fork installer replacement", () => {
	async function scenario(mode: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-installer-"));
		tempDirs.push(dir);
		const harness = path.join(dir, "scenario.ps1");
		await Bun.write(
			harness,
			`$ErrorActionPreference = "Stop"
function New-FixtureBinary([string]$Path, [string]$Version) {
    $typeName = "Fixture" + [Guid]::NewGuid().ToString("N")
    Add-Type -TypeDefinition "public class $typeName { public static void Main(string[] args) { if (args.Length > 0 && args[0] == ""--version"") System.Console.WriteLine(""omp/$Version""); else System.Threading.Thread.Sleep(60000); } }" -OutputAssembly $Path -OutputType ConsoleApplication
}
$install = $env:PI_INSTALL_DIR
New-Item -ItemType Directory -Path $install | Out-Null
$old = Join-Path $install "omp.exe"
$download = Join-Path $env:TEST_ROOT "download.exe"
if ($env:TEST_MODE -eq "directory") {
    New-Item -ItemType Directory -Path $old | Out-Null
    Set-Content -LiteralPath (Join-Path $old "keep.txt") -Value "unrelated"
} else {
    $oldVersion = if ($env:TEST_MODE -eq "already") { "18.0.9+fork.125" } else { "18.0.8+fork.124" }
    New-FixtureBinary $old $oldVersion
}
if ($env:TEST_MODE -eq "invalid") {
    New-FixtureBinary $download "18.0.9+fork.124"
} else {
    New-FixtureBinary $download "18.0.9+fork.125"
}
if ($env:TEST_MODE -eq "already") {
    Copy-Item -LiteralPath $old -Destination (Join-Path $install ".omp.old.fixture.exe")
}
$downloadCount = 0
$pathChecks = 0
function Invoke-RestMethod { return @{ tag_name = "v18.0.9+fork.125" } }
function Invoke-WebRequest([string]$Uri, [string]$OutFile, [int]$TimeoutSec, [switch]$UseBasicParsing) {
    $script:downloadCount++
    Copy-Item -LiteralPath $download -Destination $OutFile
}
function Get-Command([string]$Name) {
    if ($Name -eq "curl.exe") { return $null }
    Microsoft.PowerShell.Core\\Get-Command $Name
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$lastStatement = $ast.EndBlock.Statements[-1]
$source = [System.IO.File]::ReadAllText($env:TEST_INSTALLER)
. ([scriptblock]::Create($source.Substring(0, $lastStatement.Extent.StartOffset))) -Binary
function Set-InstallEnvironment { $script:pathChecks++; return $false }
if ($env:TEST_MODE -eq "rollback") {
    function Move-Item([string]$LiteralPath, [string]$Destination) {
        if ([System.IO.Path]::GetFileName($LiteralPath).StartsWith(".omp.tmp.")) { throw "fixture swap blocked" }
        Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    }
}
$running = $null
try {
    if ($env:TEST_MODE -eq "running") {
        $running = Start-Process -FilePath $old -PassThru
    }
    $failed = $false
    try { Install-Binary } catch { $failed = $true; Write-Host $_.Exception.Message }
    if ($env:TEST_MODE -eq "directory") {
        Write-Host "RESULT failed=$failed retained=$((Get-Content -LiteralPath (Join-Path $old 'keep.txt')).Trim())"
    } else {
        $version = (& $old --version | Select-Object -First 1)
        Write-Host "RESULT failed=$failed version=$version"
    }
    if ($running) {
        $running.Refresh()
        Write-Host "RESULT running=$(-not $running.HasExited)"
    }
    Write-Host "RESULT temps=$(@(Get-ChildItem -LiteralPath $install -Filter '.omp.tmp.*').Count)"
    Write-Host "RESULT asides=$(@(Get-ChildItem -LiteralPath $install -Filter '.omp.old.*').Count) downloads=$downloadCount pathChecks=$pathChecks"
} finally {
    if ($running -and -not $running.HasExited) { $running.Kill(); $running.WaitForExit() }
}
`,
		);
		const child = Bun.spawn([windowsPowerShell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
			cwd: repoRoot,
			env: {
				...process.env,
				PI_INSTALL_DIR: path.join(dir, "install"),
				TEST_ROOT: dir,
				TEST_MODE: mode,
				TEST_INSTALLER: path.join(repoRoot, "scripts", "install.ps1"),
				// Pin x64 without touching PROCESSOR_ARCHITEW6432: Bun.spawn on
				// Windows never delivers that variable to the child, and an empty
				// value additionally drops PROCESSOR_ARCHITECTURE, which would make
				// install.ps1 fail its architecture detection. A 64-bit host process
				// has no PROCESSOR_ARCHITEW6432 anyway, so install.ps1 reads the
				// pinned PROCESSOR_ARCHITECTURE.
				PROCESSOR_ARCHITECTURE: "AMD64",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	test("an already-installed release removes unlocked old images without downloading and still checks PATH", async () => {
		const result = await scenario("already");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("RESULT failed=False version=omp/18.0.9+fork.125");
		expect(result.stdout).toContain("RESULT asides=0 downloads=0 pathChecks=1");
		expect(result.stdout).toContain("RESULT temps=0");
	}, 30_000);

	test("rejects a wrong-version binary before changing the installed executable", async () => {
		const result = await scenario("invalid");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.8+fork.124");
		expect(result.stdout).toContain("RESULT temps=0");
	}, 30_000);

	test("rolls back the old executable when moving the verified download fails", async () => {
		const result = await scenario("rollback");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("fixture swap blocked");
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.8+fork.124");
		expect(result.stdout).toContain("RESULT temps=0");
	}, 30_000);

	test("rejects a directory at the executable path without moving its contents", async () => {
		const result = await scenario("directory");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Refusing to replace a directory");
		expect(result.stdout).toContain("RESULT failed=True retained=unrelated");
		expect(result.stdout).toContain("RESULT temps=0");
	}, 30_000);

	test("replaces a running executable without stopping its session", async () => {
		const result = await scenario("running");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("RESULT failed=False version=omp/18.0.9+fork.125");
		expect(result.stdout).toContain("RESULT running=True");
	}, 30_000);
});
