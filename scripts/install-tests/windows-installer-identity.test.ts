import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const hosts = [...new Set([Bun.which("powershell.exe"), Bun.which("pwsh")].filter((host): host is string => !!host))];

// PowerShell is the production interpreter. Only OS process enumeration and
// termination are replaced; the identity, rejection and logging logic is real.
for (const host of hosts) {
	describe(`installer kill fallback identity (${path.basename(host)})`, () => {
		for (const mode of ["exact", "foreign", "unreadable", "remaining", "absent"] as const) {
			it(`enforces exact image identity for ${mode} processes`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-installer-identity-"));
				try {
					const harness = path.join(root, "identity.ps1");
					await Bun.write(
						harness,
						`$ErrorActionPreference = "Stop"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$source = [IO.File]::ReadAllText($env:TEST_INSTALLER)
. ([scriptblock]::Create($source.Substring(0, $ast.EndBlock.Statements[-1].Extent.StartOffset))) -Binary
$target = Join-Path $env:TEST_ROOT "installed/omp.exe"
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
					);
					const child = Bun.spawn(
						[host, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
						{
							cwd: repoRoot,
							env: {
								...process.env,
								OMP_CONFIG_ROOT: path.join(root, "config"),
								OMP_CACHE_DIR: "",
								OMP_OFFLINE: "",
								OMP_PROFILE: "",
								PI_PROFILE: "",
								PROCESSOR_ARCHITECTURE: "AMD64",
								TEST_INSTALLER: path.join(repoRoot, "scripts/install.ps1"),
								TEST_ROOT: root,
								TEST_MODE: mode,
							},
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					const [code, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect(code, `${stdout}\n${stderr}`).toBe(0);
					const line = stdout.split(/\r?\n/).find(line => line.startsWith("RESULT "));
					if (!line) throw new Error(`Missing result: ${stdout}`);
					const result = JSON.parse(line.slice(7));
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
}
