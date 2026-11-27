import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const hosts = [...new Set([Bun.which("powershell.exe"), Bun.which("pwsh")].filter((host): host is string => !!host))];

const loadInstaller = `$ErrorActionPreference = "Stop"
# Set the fixture architecture in PowerShell rather than relying on the Windows spawn environment.
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:PROCESSOR_ARCHITEW6432 = $null
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$source = [IO.File]::ReadAllText($env:TEST_INSTALLER)
. ([scriptblock]::Create($source.Substring(0, $ast.EndBlock.Statements[-1].Extent.StartOffset))) -Binary
`;

async function runHarness(host: string, root: string, source: string, extraEnv: Record<string, string> = {}) {
	const harness = path.join(root, "harness.ps1");
	await Bun.write(harness, loadInstaller + source);
	const child = Bun.spawn([host, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
		cwd: repoRoot,
		env: {
			...process.env,
			CNB_TOKEN: "",
			OMP_CONFIG_ROOT: path.join(root, "config"),
			OMP_CACHE_DIR: "",
			OMP_OFFLINE: "",
			OMP_PROFILE: "",
			PI_PROFILE: "",
			PI_INSTALL_DIR: path.join(root, "installed"),
			LOCALAPPDATA: path.join(root, "local"),
			TEST_INSTALLER: path.join(repoRoot, "scripts/install.ps1"),
			TEST_ROOT: root,
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(code, `${stdout}\n${stderr}`).toBe(0);
	const line = stdout.split(/\r?\n/).find(line => line.startsWith("RESULT "));
	if (!line) throw new Error(`Missing result: ${stdout}`);
	return JSON.parse(line.slice(7));
}

// PowerShell is the production interpreter. Only OS process enumeration and
// termination are replaced; the identity, rejection and logging logic is real.
for (const host of hosts) {
	describe(`installer kill fallback identity (${path.basename(host)})`, () => {
		for (const mode of ["exact", "foreign", "unreadable", "remaining", "absent"] as const) {
			it(`enforces exact image identity for ${mode} processes`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installer-identity-"));
				try {
					const result = await runHarness(
						host,
						root,
						`$target = Join-Path $env:TEST_ROOT "installed/omp.exe"
$script:stopped = @()
$script:waited = @()
$script:timeouts = @()
$script:candidates = @()
if ($env:TEST_MODE -ne "absent") {
    $script:candidates += [pscustomobject]@{ Id = 41001; Path = $target.ToUpperInvariant(); HasExited = $false }
    $script:candidates += [pscustomobject]@{ Id = 41002; Path = (Join-Path $env:TEST_ROOT "other/omp.exe"); HasExited = $false }
    $script:candidates += [pscustomobject]@{ Id = 41003; Path = ($target + ".other"); HasExited = $false }
}
if ($env:TEST_MODE -eq "foreign") { $script:candidates = @($script:candidates | Where-Object { $_.Id -ne 41001 }) }
if ($env:TEST_MODE -eq "unreadable") { $script:candidates += [pscustomobject]@{ Id = 41004; Path = $null; HasExited = $false } }
function Get-Process { [CmdletBinding()] param([string]$Name) $script:candidates }
function Stop-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject, [switch]$Force)
    process {
        if (-not $Force) { throw "Expected forced stop" }
        $script:stopped += $InputObject.Id
        if ($env:TEST_MODE -ne "remaining") { $InputObject.HasExited = $true }
    }
}
function Wait-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject, [int]$Timeout)
    process { $script:waited += $InputObject.Id; $script:timeouts += $Timeout }
}
$failure = $null
try { Stop-RunningOmp -TargetPath $target } catch { $failure = $_.Exception.Message }
Write-Output ("RESULT " + (@{ stopped = @($script:stopped); waited = @($script:waited); timeouts = @($script:timeouts); failure = $failure; log = $script:InstallLogPath } | ConvertTo-Json -Compress))
`,
						{ TEST_MODE: mode },
					);
					const shouldStop = mode === "exact" || mode === "remaining";
					expect(result.stopped).toEqual(shouldStop ? [41001] : []);
					expect(result.waited).toEqual(shouldStop ? [41001] : []);
					expect(result.timeouts).toEqual(shouldStop ? [10] : []);
					const raw = await Bun.file(result.log).text();
					const records = raw
						.trim()
						.split(/\r?\n/)
						.map(line => JSON.parse(line));
					expect(records.find(record => record.event === "kill_fallback_started")).toMatchObject({
						match_policy: "exact_executable_path",
						timeout_ms: 10000,
					});
					if (mode === "unreadable") {
						expect(result.failure).toContain("41004");
						expect(records.find(record => record.event === "kill_fallback_failed")).toMatchObject({
							result: "unsafe_identity",
							unreadable_count: 1,
						});
					} else if (mode === "remaining") {
						expect(result.failure).toContain("41001");
						expect(records.find(record => record.event === "kill_fallback_failed")).toMatchObject({
							result: "processes_remaining",
							remaining_count: 1,
						});
					} else {
						expect(result.failure).toBeNull();
						expect(records.find(record => record.event === "kill_fallback_completed")).toMatchObject({
							result: mode === "exact" ? "stopped" : mode === "absent" ? "absent" : "no_matching_processes",
							matched_count: mode === "exact" ? 1 : 0,
						});
					}
					expect(raw).not.toContain(root);
					expect(raw).not.toContain("CommandLine");
				} finally {
					await fs.rm(root, { recursive: true, force: true });
				}
			}, 30_000);
		}
	});

	it(`requires a syntactically valid CNB bearer token before HTTP (${path.basename(host)})`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installer-token-"));
		try {
			const result = await runHarness(
				host,
				root,
				`$script:requests = 0
function Invoke-InstallWebRequest { $script:requests++; throw "Unexpected network request" }
function Get-TokenError([string]$Token) {
    $env:CNB_TOKEN = $Token
    try { Install-Binary } catch { return $_.Exception.Message }
}
$result = @{
    missing = Get-TokenError ""
    whitespace = Get-TokenError " "
    separator = Get-TokenError "token=more"
    newline = Get-TokenError ("token" + [char]10)
}
$result.requests = $script:requests
Write-Output ("RESULT " + ($result | ConvertTo-Json -Compress))
`,
			);
			expect(result.missing).toContain("repo-release:r");
			for (const key of ["whitespace", "separator", "newline"]) {
				expect(result[key]).toBe("CNB_TOKEN is not a valid bearer token.");
			}
			expect(result.requests).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it(`requires consistent release version metadata before downloading (${path.basename(host)})`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installer-title-"));
		try {
			const result = await runHarness(
				host,
				root,
				`$env:CNB_TOKEN = "test.token_~+/abc=="
$script:probedVersions = @()
function Invoke-InstallWebRequest([Uri]$Uri, [int]$TimeoutSec, [hashtable]$Headers, [switch]$Redirect) {
    if ($Headers.Accept -cne "application/vnd.cnb.api+json" -or $Headers.Authorization -cne "Bearer test.token_~+/abc==") {
        throw "Unexpected API headers"
    }
    if ($Redirect) { throw "Signed asset requested" }
    [pscustomobject]@{
        tag_name = $script:fixtureTag
        name = $script:fixtureTitle
        assets = @([pscustomobject]@{ name = "omp-windows-x64.exe"; hash_algo = "sha256"; hash_value = "0" * 64 })
    }
}
function Test-InstalledBinaryVersion([string]$TargetPath, [string]$ReleaseTag) {
    $script:probedVersions += $ReleaseTag
    return $false
}
function Get-TitleResult([string]$Ref, [string]$Title) {
    $script:fixtureTag = $Ref
    $script:fixtureTitle = $Title
    try { Install-Binary } catch { return $_.Exception.Message }
}
$result = @{
    unmarked = Get-TitleResult "omp" "omp"
    conflicting = Get-TitleResult "v18.0.9+fork.125" "v18.0.9+fork.124"
    malformed = Get-TitleResult "omp" "Release [omp:v18.0.9-rc.02]"
    marked = Get-TitleResult "omp" "Release [omp:v18.0.9-rc.2+fork.125]"
    fixed = Get-TitleResult "v18.0.9+fork.125" "Release title"
}
$result.probedVersions = $script:probedVersions
Write-Output ("RESULT " + ($result | ConvertTo-Json -Compress))
`,
			);
			expect(result.unmarked).toContain("no unambiguous binary version");
			expect(result.conflicting).toContain("no unambiguous binary version");
			expect(result.malformed).toContain("invalid binary version metadata");
			expect(result.marked).toBe("Signed asset requested");
			expect(result.fixed).toBe("Signed asset requested");
			expect(result.probedVersions).toEqual(["18.0.9-rc.2+fork.125", "18.0.9+fork.125"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it(`requires one exact SemVer stdout line from the executable (${path.basename(host)})`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installer-version-"));
		try {
			const result = await runHarness(
				host,
				root,
				`$target = Join-Path $env:TEST_ROOT ".omp.tmp.probe.exe"
[IO.File]::WriteAllText($target, "")
function Invoke-Native([scriptblock]$Command) {
    $global:LASTEXITCODE = $script:probeExit
    $script:probeOutput
}
function Invoke-VersionCase([string]$Version, [string[]]$Lines, [int]$ExitCode = 0) {
    $script:probeOutput = $Lines
    $script:probeExit = $ExitCode
    Test-InstalledBinaryVersion -TargetPath $target -ReleaseTag $Version
}
$result = @{
    exact = Invoke-VersionCase "v18.0.9-rc.2+fork.125" "omp/18.0.9-rc.2+fork.125"
    wrongBuild = Invoke-VersionCase "18.0.9+fork.125" "omp/18.0.9+fork.124"
    badSemver = Invoke-VersionCase "18.0.9-rc.02" "omp/18.0.9-rc.02"
    trailingText = Invoke-VersionCase "18.0.9" "omp/18.0.9 trailing"
    extraLine = Invoke-VersionCase "18.0.9" @("omp/18.0.9", "unexpected")
    failedProbe = Invoke-VersionCase "18.0.9" "omp/18.0.9" 42
}
Write-Output ("RESULT " + ($result | ConvertTo-Json -Compress))
`,
			);
			expect(result).toEqual({
				exact: true,
				wrongBuild: false,
				badSemver: false,
				trailingText: false,
				extraLine: false,
				failedProbe: false,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
}
