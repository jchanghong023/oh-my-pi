import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "../..");
const tempDirs: string[] = [];
const hostIsAlpine = process.platform === "linux" && (await Bun.file("/etc/alpine-release").exists());

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
		"ldd",
		`#!/bin/sh
if [ "\${TEST_LIBC:-glibc}" = musl ]; then
  printf 'musl libc\\nVersion 1.2.5\\n' >&2
  exit 1
fi
echo 'ldd (GNU libc) 2.39'
`,
	);
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
printf 'curl %s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = "--version" ]; then
  printf 'curl %s (fixture) %s\\n' "\${TEST_CURL_VERSION:-8.0.0}" "\${TEST_CURL_TLS:-OpenSSL}"
  exit 0
fi
case " $* " in
  *" --insecure "*) ;;
  *) echo 'curl: (60) fixture certificate verification failed' >&2; exit 60 ;;
esac
case " $* " in
  *" --ssl-no-revoke "*)
    if [ "\${TEST_CURL_TLS:-OpenSSL}" != Schannel ] || [ "\${TEST_CURL_NO_REVOKE_SUPPORTED:-1}" = 0 ]; then
      echo 'curl: option --ssl-no-revoke: is unknown' >&2
      exit 2
    fi
    ;;
  *)
    if [ "\${TEST_CURL_TLS:-OpenSSL}" = Schannel ] && [ "\${TEST_CURL_NO_REVOKE_SUPPORTED:-1}" = 1 ]; then
      echo 'curl: (35) fixture Schannel revocation check failed' >&2
      exit 35
    fi
    ;;
esac
case " $* " in
  *" --fail-with-body "*)
    if [ "\${TEST_CURL_FAIL_WITH_BODY_SUPPORTED:-1}" = 0 ]; then
      echo 'curl: option --fail-with-body: is unknown' >&2
      exit 2
    fi
    ;;
esac
case "$*" in
  *api.github.com*)
    if [ "\${TEST_METADATA_EXIT:-0}" != 0 ]; then
      printf '%s\\n' "$TEST_METADATA_ERROR" >&2
      printf '\\n%s' "\${TEST_METADATA_STATUS:-000}"
      exit "$TEST_METADATA_EXIT"
    fi
    case "$*" in
      */releases/tags/*) tag="\${*##*/releases/tags/}" ;;
      *) tag="v18.0.9+fork.125" ;;
    esac
    printf '{"tag_name":"%s"}\\n' "$tag"
    printf '\\n200'
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
			OMP_CONFIG_ROOT: path.join(dir, "config"),
			OMP_PROFILE: "",
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

// These fixtures require POSIX sh and a colon-separated PATH. The glibc route
// cannot be simulated on Alpine, whose distro marker independently selects musl.
describe.skipIf(process.platform === "win32")("fork installer routing", () => {
	test.skipIf(hostIsAlpine).each([
		["x86_64", "x64"],
		["aarch64", "arm64"],
	])("defaults to the latest fork glibc release for %s", async (arch, assetArch) => {
		const result = await runInstallerWithFixture([], await createFixture("Linux", arch));
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain("api.github.com/repos/jchanghong023/oh-my-pi/releases/latest");
		expect(result.commands).toContain(
			`github.com/jchanghong023/oh-my-pi/releases/download/v18.0.9+fork.125/omp-linux-${assetArch}`,
		);
		expect(result.commands).not.toContain("bun install");
	});

	test.each([
		["x86_64", "x64"],
		["aarch64", "arm64"],
	])("selects the musl release asset for %s", async (arch, assetArch) => {
		const fixture = await createFixture("Linux", arch);
		fixture.env.TEST_LIBC = "musl";
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.commands).toContain(
			`github.com/jchanghong023/oh-my-pi/releases/download/v18.0.9+fork.125/omp-linux-musl-${assetArch}`,
		);
		expect(await Bun.file(path.join(fixture.installDir, "omp")).exists()).toBe(true);
	});

	test.each([
		["old OpenSSL", "7.43.0", "OpenSSL", "0", "0"],
		["modern OpenSSL", "8.0.0", "OpenSSL", "1", "1"],
		["modern Schannel", "8.0.0", "Schannel", "1", "1"],
	])("installs with %s curl without unsupported TLS or failure flags", async (_name, version, tls, revoke, body) => {
		const fixture = await createFixture();
		fixture.env.TEST_CURL_VERSION = version;
		fixture.env.TEST_CURL_TLS = tls;
		fixture.env.TEST_CURL_NO_REVOKE_SUPPORTED = revoke;
		fixture.env.TEST_CURL_FAIL_WITH_BODY_SUPPORTED = body;
		const result = await runInstallerWithFixture([], fixture);
		expect(result.exitCode, result.stderr).toBe(0);
		const installed = Bun.spawn([path.join(fixture.installDir, "omp"), "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [installedExit, installedOutput] = await Promise.all([
			installed.exited,
			new Response(installed.stdout).text(),
		]);
		expect(installedExit).toBe(0);
		expect(installedOutput.trim()).toBe("omp/18.0.9+fork.125");
	});

	test.each([
		["missing tag", "22", "404", "http", "curl: (22) The requested URL returned error: 404", "release_tag"],
		["missing latest", "22", "404", "http", "curl: (22) The requested URL returned error: 404", "release_latest"],
		["forbidden", "22", "403", "http", "curl: (22) The requested URL returned error: 403", "release_tag"],
		["DNS", "6", "000", "dns", "curl: (6) Could not resolve host: api.github.com", "release_tag"],
		["timeout", "28", "000", "timeout", "curl: (28) Operation timed out", "release_tag"],
		["TLS", "35", "000", "tls", "curl: (35) SSL connect error", "release_tag"],
	])(
		"reports %s metadata failures without damaging the installed binary",
		async (_name, code, status, kind, error, endpoint) => {
			const fixture = await createFixture();
			await fs.mkdir(fixture.installDir, { recursive: true });
			const oldBinary = '#!/bin/sh\necho "omp/18.0.8+fork.124"\n';
			const target = path.join(fixture.installDir, "omp");
			await writeExecutable(fixture.installDir, "omp", oldBinary);
			fixture.env.TEST_METADATA_EXIT = code;
			fixture.env.TEST_METADATA_STATUS = status;
			fixture.env.TEST_METADATA_ERROR = error;
			const args = endpoint === "release_tag" ? ["--ref", "v18.0.9+fork.125"] : [];
			const result = await runInstallerWithFixture(args, fixture);
			expect(result.exitCode).toBe(Number(code));
			expect(result.stderr).toContain(error);
			if (status === "404" && endpoint === "release_tag") {
				expect(result.stderr).toContain("Release tag not found:");
			} else {
				expect(result.stderr).not.toContain("Release tag not found:");
				expect(result.stderr).toContain(`curl exit ${code}, HTTP ${status}`);
			}
			expect(result.commands).not.toContain("/releases/download/");
			expect(await Bun.file(target).text()).toBe(oldBinary);
			expect(await fs.readdir(fixture.installDir)).toEqual(["omp"]);
			const logDir = path.join(fixture.env.OMP_CONFIG_ROOT!, "logs");
			const logs = await fs.readdir(logDir);
			const diagnostic = await Bun.file(path.join(logDir, logs[0])).text();
			expect(diagnostic).toContain(
				`curl_exit=${code} error_type=${kind} http_status=${status} endpoint=${endpoint}`,
			);
		},
	);

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
function New-FixtureBinary([string]$Path, [string]$Version, [switch]$FailProbe) {
    $typeName = "Fixture" + [Guid]::NewGuid().ToString("N")
    $body = if ($FailProbe) { 'System.Console.Error.WriteLine("fixture native startup failed"); System.Environment.Exit(42);' } else { "if (args.Length > 0 && args[0] == ""--version"") System.Console.WriteLine(""omp/$Version""); else { using (var ready = System.Threading.EventWaitHandle.OpenExisting(args[0])) using (var stop = System.Threading.EventWaitHandle.OpenExisting(args[1])) { ready.Set(); stop.WaitOne(); } }" }
    Add-Type -TypeDefinition "public class $typeName { public static void Main(string[] args) { $body } }" -OutputAssembly $Path -OutputType ConsoleApplication
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
} elseif ($env:TEST_MODE -eq "probe-failed") {
    New-FixtureBinary $download "" -FailProbe
} else {
    New-FixtureBinary $download "18.0.9+fork.125"
}
if ($env:TEST_MODE -eq "already") {
    Copy-Item -LiteralPath $old -Destination (Join-Path $install ".omp.old.fixture.exe")
}
$downloadCount = 0
$pathChecks = 0
function Invoke-RestMethod([string]$Uri) {
    if ($Uri -match '/main/scripts/install.ps1$') {
        return $script:installerDefinitions + '\nfunction Set-InstallEnvironment { $script:pathChecks++; return $false }\nInstall-Binary'
    }
    return @{ tag_name = "v18.0.9+fork.125" }
}
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
$script:installerDefinitions = $source.Substring(0, $lastStatement.Extent.StartOffset)
. ([scriptblock]::Create($script:installerDefinitions)) -Binary
function Set-InstallEnvironment {
    $script:pathChecks++
    if ($env:TEST_MODE -eq "path-failed") { Set-InstallStage "environment"; throw "fixture PATH access denied" }
    return $false
}
$script:blockMoves = $true
if ($env:TEST_MODE -in @("rollback", "rollback-failed", "retry", "rename-failed")) {
    function Move-Item([string]$LiteralPath, [string]$Destination) {
        $name = [System.IO.Path]::GetFileName($LiteralPath)
        if ($script:blockMoves) {
            if ($env:TEST_MODE -eq "rename-failed" -and $name -eq "omp.exe") { throw "fixture old image locked" }
            if ($name.StartsWith(".omp.tmp.")) { throw "fixture swap blocked" }
            if ($env:TEST_MODE -eq "rollback-failed" -and $name.StartsWith(".omp.old.")) { throw "fixture rollback access denied" }
        }
        Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    }
}
if ($env:TEST_MODE -eq "rename-failed") {
    function Stop-RunningOmp { Set-InstallStage "kill_fallback"; throw "fixture process access denied" }
}
$running = $null
$ready = $null
$stop = $null
try {
    if ($env:TEST_MODE -eq "running") {
        # Start-Process returning does not prove CLR Main has entered. The live
        # image must reach its session wait before installation can rename it.
        $eventId = [Guid]::NewGuid().ToString("N")
        $readyName = "Local\\omp-fixture-ready-$eventId"
        $stopName = "Local\\omp-fixture-stop-$eventId"
        $ready = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, $readyName)
        $stop = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, $stopName)
        $running = Start-Process -FilePath $old -ArgumentList @($readyName, $stopName) -PassThru
        if (-not $ready.WaitOne(10000)) { throw "Running fixture did not enter its session wait within 10 seconds." }
        $running.Refresh()
        if ($running.HasExited) { throw "Running fixture exited before installation (exit $($running.ExitCode))." }
    }
    $failed = $false
    $messages = @()
    try {
        Install-Binary 6>&1 | ForEach-Object { $script:messages += $_.ToString(); Write-Host $_ }
    } catch { $failed = $true; Write-Host $_.Exception.Message }
    if ($env:TEST_MODE -eq "directory") {
        Write-Host "RESULT failed=$failed retained=$((Get-Content -LiteralPath (Join-Path $old 'keep.txt')).Trim())"
    } elseif (Test-Path -LiteralPath $old -PathType Leaf) {
        $version = (& $old --version | Select-Object -First 1)
        Write-Host "RESULT failed=$failed version=$version"
    } else {
        Write-Host "RESULT failed=$failed targetMissing=True"
    }
    if ($running) {
        $running.Refresh()
        Write-Host "RESULT running=$(-not $running.HasExited)"
    }
    Write-Host "RESULT temps=$(@(Get-ChildItem -LiteralPath $install -Filter '.omp.tmp.*').Count)"
    Write-Host "RESULT asides=$(@(Get-ChildItem -LiteralPath $install -Filter '.omp.old.*').Count) downloads=$downloadCount pathChecks=$pathChecks"
    Write-Host "RESULT candidateCleanupInstructions=$(@($messages | Where-Object { $_.StartsWith('Remove-Item -LiteralPath ') }).Count)"
    if ($env:TEST_MODE -in @("rollback", "rollback-failed", "rename-failed")) {
        $probeCommand = $messages | Where-Object { $_ -match '^& .*\\.omp\\.tmp\\..* --version$' } | Select-Object -First 1
        Write-Host "RESULT recoveryVersion=$(& ([scriptblock]::Create($probeCommand)))"
    }
    if ($env:TEST_MODE -eq "rollback-failed") {
        $restoreCommand = $messages | Where-Object { $_.StartsWith("if (-not (Test-Path -LiteralPath ") } | Select-Object -First 1
        $script:blockMoves = $false
        & ([scriptblock]::Create($restoreCommand))
        Write-Host "RESULT restoredVersion=$(& $old --version)"
    }
    if ($env:TEST_MODE -eq "retry") {
        $retryCommand = $messages | Where-Object { $_.StartsWith('$env:PI_INSTALL_DIR = ') } | Select-Object -First 1
        $script:blockMoves = $false
        & ([scriptblock]::Create($retryCommand))
        Write-Host "RESULT retryVersion=$(& $old --version)"
    }
} finally {
    if ($stop) { $null = $stop.Set() }
    if ($running -and -not $running.HasExited -and -not $running.WaitForExit(5000)) {
        $running.Kill()
        $running.WaitForExit()
    }
    if ($ready) { $ready.Dispose() }
    if ($stop) { $stop.Dispose() }
}
`,
		);
		const child = Bun.spawn([windowsPowerShell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
			cwd: repoRoot,
			env: {
				...process.env,
				PI_INSTALL_DIR: path.join(dir, "install 'quoted"),
				OMP_CONFIG_ROOT: path.join(dir, "config"),
				OMP_PROFILE: "default",
				PI_PROFILE: "default",
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

	test("standalone rejection preserves the original exception and redacts its diagnostic evidence", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-standalone-"));
		tempDirs.push(dir);
		const installDir = path.join(dir, "PRIVATEINSTALLTARGET");
		const target = path.join(installDir, "omp.exe");
		const configRoot = path.join(dir, "config");
		await fs.mkdir(target, { recursive: true });
		await Bun.write(path.join(target, "keep.txt"), "unrelated");
		const child = Bun.spawn(
			[
				windowsPowerShell!,
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(repoRoot, "scripts", "install.ps1"),
				"-Binary",
				"-Ref",
				"PRIVATEINSTALLREF",
			],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					HOME: dir,
					USERPROFILE: dir,
					LOCALAPPDATA: path.join(dir, "local"),
					OMP_CONFIG_ROOT: configRoot,
					OMP_PROFILE: "default",
					PI_PROFILE: "default",
					PI_INSTALL_DIR: installDir,
					PROCESSOR_ARCHITECTURE: "AMD64",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(1);
		expect(stderr).toContain("Refusing to replace a directory");
		expect(stderr).not.toContain("ScriptHalted");
		expect(await Bun.file(path.join(target, "keep.txt")).text()).toBe("unrelated");
		const logsDir = path.join(configRoot, "logs");
		const files = (await fs.readdir(logsDir)).filter(name => name.endsWith(`.${child.pid}.log`));
		const raw = (await Promise.all(files.map(name => Bun.file(path.join(logsDir, name)).text()))).join("");
		expect(raw).not.toContain("PRIVATEINSTALLTARGET");
		expect(raw).not.toContain("PRIVATEINSTALLREF");
		const records = raw
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
		const terminal = records.filter(record => record.event === "install_failed");
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			pid: child.pid,
			level: "ERROR",
			stage: "install_target",
			result: "failed",
			target_version: "redacted",
			source_file: "install.ps1",
		});
		expect(terminal[0].source_line).toBeGreaterThan(0);
		expect(records.some(record => record.event === "http_request_started")).toBe(false);
	}, 30_000);

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

	test("a failed replacement restores the old install and leaves an executable recovery command", async () => {
		const result = await scenario("rollback");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("fixture swap blocked");
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.8+fork.124");
		expect(result.stdout).toContain("Stage: atomic_replace");
		expect(result.stdout).toContain("RESULT temps=1");
		expect(result.stdout).toContain("RESULT recoveryVersion=omp/18.0.9+fork.125");
	}, 30_000);

	test("a rollback failure reports both errors and provides a working old-image restore command", async () => {
		const result = await scenario("rollback-failed");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Stage: rollback");
		expect(result.stdout).toContain("fixture swap blocked");
		expect(result.stdout).toContain("fixture rollback access denied");
		expect(result.stdout).toContain("RESULT failed=True targetMissing=True");
		expect(result.stdout).toContain("RESULT recoveryVersion=omp/18.0.9+fork.125");
		expect(result.stdout).toContain("RESULT restoredVersion=omp/18.0.8+fork.124");
	}, 30_000);

	test("the printed retry command completes the same release in a quoted install path", async () => {
		const result = await scenario("retry");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.8+fork.124");
		expect(result.stdout).toContain("RESULT retryVersion=omp/18.0.9+fork.125");
	}, 30_000);

	test("a PATH failure reports partial installation instead of declaring success", async () => {
		const result = await scenario("path-failed");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Stage: environment");
		expect(result.stdout).toContain("fixture PATH access denied");
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.9+fork.125");
		expect(result.stdout).not.toContain("[OK] Installed");
	}, 30_000);

	test("a rename and process-permission failure preserves both causes and the verified download", async () => {
		const result = await scenario("rename-failed");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Stage: kill_fallback");
		expect(result.stdout).toContain("fixture old image locked");
		expect(result.stdout).toContain("fixture process access denied");
		expect(result.stdout).toContain("RESULT failed=True version=omp/18.0.8+fork.124");
		expect(result.stdout).toContain("RESULT recoveryVersion=omp/18.0.9+fork.125");
	}, 30_000);

	test("a failed native version probe exposes its stderr and exit code without replacing the old binary", async () => {
		const result = await scenario("probe-failed");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Stage: candidate_version");
		expect(result.stdout).toContain("fixture native startup failed");
		expect(result.stdout).toContain("exit code: 42");
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
		expect(result.stdout).toContain("RESULT candidateCleanupInstructions=0");
	}, 30_000);
});

describe.skipIf(!windowsPowerShell || !Bun.which("curl.exe"))("Windows installer proxy downloads", () => {
	test.each(["system", "environment", "fallback"] as const)(
		"downloads binary bytes through the %s proxy path without changing system settings",
		async mode => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-proxy-"));
			tempDirs.push(dir);
			const payload = new Uint8Array([0x4d, 0x5a, 0, 0xff, 0x0d, 0x0a]);
			const systemRequests: string[] = [];
			const environmentRequests: string[] = [];
			const systemProxy = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					systemRequests.push(request.url);
					return new Response(payload, {
						status: mode === "fallback" && systemRequests.length === 1 ? 503 : 200,
					});
				},
			});
			const environmentProxy =
				mode === "environment"
					? Bun.serve({
							hostname: "127.0.0.1",
							port: 0,
							fetch(request) {
								environmentRequests.push(request.url);
								return new Response(payload);
							},
						})
					: null;
			try {
				const harness = path.join(dir, "download.ps1");
				const outFile = path.join(dir, "download.exe");
				await Bun.write(
					harness,
					`$ErrorActionPreference = "Stop"
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:ALL_PROXY = $null
$env:NO_PROXY = $null
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$source = [IO.File]::ReadAllText($env:TEST_INSTALLER)
. ([scriptblock]::Create($source.Substring(0, $ast.EndBlock.Statements[-1].Extent.StartOffset))) -Binary
# Substitute only the process-local, OS-resolved proxy; never write HKCU settings.
[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy([Uri]$env:TEST_SYSTEM_PROXY, $false)
if ($env:TEST_ENVIRONMENT_PROXY) { $env:HTTP_PROXY = $env:TEST_ENVIRONMENT_PROXY }
Save-InstallBinary -Uri "http://omp-download.invalid/omp.exe" -OutFile $env:TEST_OUTFILE
`,
				);
				const child = Bun.spawn(
					[windowsPowerShell!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
					{
						cwd: repoRoot,
						env: {
							...process.env,
							OMP_CONFIG_ROOT: path.join(dir, "config"),
							OMP_PROFILE: "default",
							PI_PROFILE: "default",
							CURL_HOME: dir,
							TEST_INSTALLER: path.join(repoRoot, "scripts", "install.ps1"),
							TEST_SYSTEM_PROXY: `http://127.0.0.1:${systemProxy.port}`,
							TEST_ENVIRONMENT_PROXY: environmentProxy ? `http://127.0.0.1:${environmentProxy.port}` : "",
							TEST_OUTFILE: outFile,
							PROCESSOR_ARCHITECTURE: "AMD64",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
				expect(new Uint8Array(await fs.readFile(outFile))).toEqual(payload);
				const uri = "http://omp-download.invalid/omp.exe";
				expect(systemRequests).toEqual(mode === "environment" ? [] : mode === "fallback" ? [uri, uri] : [uri]);
				expect(environmentRequests).toEqual(mode === "environment" ? [uri] : []);
			} finally {
				systemProxy.stop(true);
				environmentProxy?.stop(true);
			}
		},
		30_000,
	);
});

describe.skipIf(!windowsPowerShell || !Bun.which("curl.exe") || !Bun.which("openssl.exe"))(
	"Windows installer untrusted-certificate downloads",
	() => {
		test("downloads binary bytes from a self-signed HTTPS endpoint through the relaxed TLS posture", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ps-tls-"));
			tempDirs.push(dir);
			const payload = new Uint8Array([0x4d, 0x5a, 0, 0xff, 0x0d, 0x0a]);
			const keyFile = path.join(dir, "key.pem");
			const certFile = path.join(dir, "cert.pem");
			const openssl = Bun.spawnSync(
				[
					Bun.which("openssl.exe")!,
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-keyout",
					keyFile,
					"-out",
					certFile,
					"-days",
					"1",
					"-nodes",
					"-subj",
					"/CN=localhost",
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
			expect(openssl.exitCode, openssl.stderr?.toString()).toBe(0);
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				tls: { key: Bun.file(keyFile), cert: Bun.file(certFile) },
				fetch: () => new Response(payload),
			});
			try {
				const harness = path.join(dir, "tls-download.ps1");
				const outFile = path.join(dir, "download.exe");
				await Bun.write(
					harness,
					`$ErrorActionPreference = "Stop"
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:ALL_PROXY = $null
$env:NO_PROXY = $null
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$source = [IO.File]::ReadAllText($env:TEST_INSTALLER)
. ([scriptblock]::Create($source.Substring(0, $ast.EndBlock.Statements[-1].Extent.StartOffset))) -Binary
# No proxy for this probe: exercise the TLS posture, not proxy resolution.
[Net.WebRequest]::DefaultWebProxy = $null
if ($PSVersionTable.PSVersion.Major -lt 7) {
    if (-not [Net.ServicePointManager]::ServerCertificateValidationCallback) { throw "TLS policy callback not installed" }
    if (([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -eq 0) { throw "TLS 1.2 not enabled" }
}
Save-InstallBinary -Uri "https://127.0.0.1:$env:TEST_PORT/omp.exe" -OutFile $env:TEST_OUTFILE
`,
				);
				const child = Bun.spawn(
					[windowsPowerShell!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
					{
						cwd: repoRoot,
						env: {
							...process.env,
							OMP_CONFIG_ROOT: path.join(dir, "config"),
							OMP_PROFILE: "default",
							PI_PROFILE: "default",
							CURL_HOME: dir,
							TEST_INSTALLER: path.join(repoRoot, "scripts", "install.ps1"),
							TEST_PORT: String(server.port),
							TEST_OUTFILE: outFile,
							PROCESSOR_ARCHITECTURE: "AMD64",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				// Without --insecure curl exits 60 on the self-signed chain and the
				// Invoke-WebRequest fallback would have to rescue the download.
				expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
				expect(stdout).not.toContain("curl download failed");
				expect(new Uint8Array(await fs.readFile(outFile))).toEqual(payload);
			} finally {
				server.stop(true);
			}
		}, 30_000);
	},
);
